// Live end-to-end on Sepolia with the real Zama relayer, KMS and Zama's cUSDCMock wrapper. Spends testnet ETH only.
//
//   CPL_KEYS=../../confidential-pay-links-secrets/e2e-keys.json node e2e/sepolia-live.mjs
//
// CPL_KEYS is a JSON file {merchant, payer, auditor: {key, address}} of throwaway testnet keys (never commit it).
// Steps: (a) exact payment -> accepted; (b) wrong amount -> refunded; (c) publish + confirm paid on chain;
// (d) auditor viewer decrypts. Every tx hash and decrypted value is written to e2e-results/sepolia-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfig, isRetryable, memoryStorage, ZamaSDK } from '@zama-fhe/sdk';
import { sepolia } from '@zama-fhe/sdk/chains';
import { node } from '@zama-fhe/sdk/node';
import { ViemProvider, ViemSigner } from '@zama-fhe/sdk/viem';
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia as viemSepolia } from 'viem/chains';

const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PAYLINKS = '0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d';
const READER = '0x2d7003f996491F965C3Fb32355Cc42150FE5f94D';
const TOKEN = '0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639'; // cUSDCMock
const UNDERLYING = '0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF'; // public-mint mock USDC
const ZERO = '0x0000000000000000000000000000000000000000';
const keys = JSON.parse(readFileSync(process.env.CPL_KEYS, 'utf8'));
const art = JSON.parse(readFileSync(fileURLToPath(new URL('../../contracts/out/ConfidentialPayLinks.sol/ConfidentialPayLinks.json', import.meta.url)), 'utf8'));
const abi = art.abi;
const tokenAbi = parseAbi([
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function confidentialTransferAndCall(address to, bytes32 encryptedAmount, bytes inputProof, bytes data) returns (bytes32)',
  'function wrap(address to, uint256 amount) returns (bytes32)',
  'function decimals() view returns (uint8)',
]);
const erc20Abi = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

const pub = createPublicClient({ chain: viemSepolia, transport: http(RPC) });
const out = { network: 'sepolia', payLinks: PAYLINKS, reader: READER, token: TOKEN, started: new Date().toISOString(), txs: {}, values: {}, retries: [] };
const save = () => {
  const dir = fileURLToPath(new URL('../../e2e-results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}sepolia-live.json`, JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
};

function actor(name) {
  const account = privateKeyToAccount(keys[name].key);
  const wallet = createWalletClient({ chain: viemSepolia, account, transport: http(RPC) });
  const sdk = new ZamaSDK(createConfig({
    chains: [{ ...sepolia, network: RPC }],
    provider: new ViemProvider({ publicClient: pub }),
    signer: new ViemSigner({ walletClient: wallet }),
    storage: memoryStorage,
    relayers: { [sepolia.id]: node({ timeout: 180_000 }) },
  }));
  return { name, address: account.address, wallet, sdk };
}

/** Retries relayer/KMS calls on transient errors (Sepolia decryption has had outages). */
async function retry(label, fn, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = isRetryable(e) || /DECRYPTION_FAILED|RELAYER|fetch|timed? ?out|50[234]|not (yet )?(allowed|authorized)|ACL/i.test(`${e?.code} ${e?.message}`);
      if (i >= attempts || !transient) throw e;
      const wait = Math.min(60, 5 * 2 ** (i - 1));
      out.retries.push({ label, attempt: i, error: String(e?.message ?? e).slice(0, 200), waitSeconds: wait });
      console.log(`  ${label}: ${String(e?.message ?? e).slice(0, 120)} — retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function send(who, label, req) {
  const hash = await who.wallet.writeContract({ ...req, chain: viemSepolia, account: who.wallet.account });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  out.txs[label] = { hash, status: r.status, gasUsed: r.gasUsed };
  console.log(`  ${label}: ${hash} ${r.status} gas ${r.gasUsed}`);
  if (r.status !== 'success') throw new Error(`${label} reverted`);
  save();
  return r;
}

const decrypt = (who, label, pairs) =>
  retry(`decrypt:${label}`, () => who.sdk.decryption.decryptValues(pairs.map((h) => ({ encryptedValue: h.handle, contractAddress: h.contract }))));

async function balance(who) {
  const h = await pub.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'confidentialBalanceOf', args: [who.address] });
  if (/^0x0{64}$/.test(h)) return 0n;
  return (await decrypt(who, `balance:${who.name}`, [{ handle: h, contract: TOKEN }]))[h];
}

async function createInvoice(m, amount, tag) {
  const nonce = keccak256(toHex(`${tag}-${Date.now()}`));
  const enc = await retry(`encrypt:${tag}`, () => m.sdk.encrypt({ values: [{ value: amount, type: 'euint64' }], contractAddress: PAYLINKS, userAddress: m.address }));
  const id = await pub.readContract({ address: PAYLINKS, abi, functionName: 'invoiceIdOf', args: [m.address, nonce] });
  await send(m, `createInvoice:${tag}`, { address: PAYLINKS, abi, functionName: 'createInvoice', args: [nonce, TOKEN, ZERO, 0, keccak256(toHex(tag)), enc.encryptedValues[0], enc.inputProof] });
  return id;
}

async function pay(p, id, amount, tag) {
  const enc = await retry(`encrypt:pay:${tag}`, () => p.sdk.encrypt({ values: [{ value: amount, type: 'euint64' }], contractAddress: TOKEN, userAddress: p.address }));
  const r = await send(p, `pay:${tag}`, {
    address: TOKEN, abi: tokenAbi, functionName: 'confidentialTransferAndCall',
    args: [PAYLINKS, enc.encryptedValues[0], enc.inputProof, encodeAbiParameters([{ type: 'bytes32' }], [id])],
  });
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== PAYLINKS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === 'PaymentReceived') return Number(ev.args.index);
    } catch {}
  }
  throw new Error('no PaymentReceived');
}

const m = actor('merchant');
const p = actor('payer');
const a = actor('auditor');
out.merchant = m.address;
out.payer = p.address;
out.auditor = a.address;
const check = (cond, msg) => {
  out.values[`check:${msg}`] = Boolean(cond);
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
};

try {
  const dec = await pub.readContract({ address: TOKEN, abi: tokenAbi, functionName: 'decimals' });
  const unit = 10n ** BigInt(dec);
  const PRICE = 25n * unit;

  console.log('setup: payer mints mock USDC and wraps it into cUSDCMock');
  const shield = 100n * unit; // cUSDCMock has the same 6 decimals as its underlying
  await send(p, 'mintUnderlying', { address: UNDERLYING, abi: erc20Abi, functionName: 'mint', args: [p.address, shield] });
  await send(p, 'approveUnderlying', { address: UNDERLYING, abi: erc20Abi, functionName: 'approve', args: [TOKEN, shield] });
  await send(p, 'wrap', { address: TOKEN, abi: tokenAbi, functionName: 'wrap', args: [p.address, shield] });
  const p0 = await balance(p);
  const m0 = await balance(m);
  out.values.payerStart = p0;
  out.values.merchantStart = m0;
  console.log(`  payer ${p0}, merchant ${m0}`);

  console.log('(a) exact payment');
  const idA = await createInvoice(m, PRICE, 'a');
  out.values.invoiceA = idA;
  const iA = await pay(p, idA, PRICE, 'a-exact');
  const payA = await pub.readContract({ address: PAYLINKS, abi, functionName: 'getPayment', args: [idA, BigInt(iA)] });
  const vA = await decrypt(p, 'payer-receipt-a', [{ handle: payA.accepted, contract: PAYLINKS }, { handle: payA.received, contract: PAYLINKS }]);
  out.values.a_payerSeesAccepted = vA[payA.accepted];
  out.values.a_payerSeesReceived = vA[payA.received];
  check(vA[payA.accepted] === true, 'a: payer decrypts accepted=true');
  const p1 = await balance(p);
  const m1 = await balance(m);
  out.values.payerAfterA = p1;
  out.values.merchantAfterA = m1;
  check(p1 === p0 - PRICE && m1 === m0 + PRICE, 'a: 25 moved payer -> merchant');
  const invA = await pub.readContract({ address: PAYLINKS, abi, functionName: 'getInvoice', args: [idA] });
  const mA = await decrypt(m, 'merchant-a', [{ handle: invA.amount, contract: PAYLINKS }, { handle: invA.paid, contract: PAYLINKS }]);
  out.values.a_merchantSeesAmount = mA[invA.amount];
  out.values.a_merchantSeesPaid = mA[invA.paid];
  check(mA[invA.amount] === PRICE && mA[invA.paid] === true, 'a: merchant decrypts amount=25, paid=true');

  console.log('(b) wrong amount');
  const idB = await createInvoice(m, PRICE, 'b');
  out.values.invoiceB = idB;
  const iB = await pay(p, idB, PRICE - unit, 'b-wrong'); // 24 instead of 25
  const payB = await pub.readContract({ address: PAYLINKS, abi, functionName: 'getPayment', args: [idB, BigInt(iB)] });
  const vB = await decrypt(p, 'payer-receipt-b', [{ handle: payB.accepted, contract: PAYLINKS }, { handle: payB.received, contract: PAYLINKS }]);
  out.values.b_payerSeesAccepted = vB[payB.accepted];
  out.values.b_payerSeesReceived = vB[payB.received];
  check(vB[payB.accepted] === false, 'b: payer decrypts accepted=false (refunded)');
  const p2 = await balance(p);
  const m2 = await balance(m);
  out.values.payerAfterB = p2;
  out.values.merchantAfterB = m2;
  check(p2 === p1 && m2 === m1, 'b: payer balance restored, merchant unchanged');
  const invB = await pub.readContract({ address: PAYLINKS, abi, functionName: 'getInvoice', args: [idB] });
  const mB = await decrypt(m, 'merchant-b', [{ handle: invB.paid, contract: PAYLINKS }]);
  out.values.b_merchantSeesPaid = mB[invB.paid];
  check(mB[invB.paid] === false, 'b: invoice unpaid');

  console.log('(c) publish + confirm paid for (a)');
  await send(m, 'publishPaidStatus:a', { address: PAYLINKS, abi, functionName: 'publishPaidStatus', args: [idA] });
  const handle = await pub.readContract({ address: PAYLINKS, abi, functionName: 'publishedPaidHandle', args: [idA] });
  const pd = await retry('publicDecrypt:a', () => a.sdk.decryption.decryptPublicValues([handle]));
  out.values.c_publicClear = pd.clearValues[handle];
  check(pd.clearValues[handle] === true, 'c: public decryption says paid=true');
  await send(p, 'confirmPaidStatus:a', { address: PAYLINKS, abi, functionName: 'confirmPaidStatus', args: [idA, pd.abiEncodedClearValues, pd.decryptionProof] });
  const confirmed = await pub.readContract({ address: PAYLINKS, abi, functionName: 'paidConfirmed', args: [idA] });
  out.values.c_paidConfirmed = confirmed;
  check(confirmed === true, 'c: paidConfirmed[a] == true on chain');
  let amountPublic = true;
  try { await a.sdk.decryption.decryptPublicValues([invA.amount]); } catch { amountPublic = false; }
  check(!amountPublic, 'c: invoice amount is NOT publicly decryptable');

  console.log('(d) auditor');
  let deniedBefore = false;
  try { await a.sdk.decryption.decryptValues([{ encryptedValue: invA.amount, contractAddress: PAYLINKS }]); } catch { deniedBefore = true; }
  check(deniedBefore, 'd: auditor denied before grant');
  await send(m, 'addViewer:a', { address: PAYLINKS, abi, functionName: 'addViewer', args: [idA, a.address] });
  const ad = await decrypt(a, 'auditor-a', [{ handle: invA.amount, contract: PAYLINKS }, { handle: invA.paid, contract: PAYLINKS }]);
  out.values.d_auditorSeesAmount = ad[invA.amount];
  out.values.d_auditorSeesPaid = ad[invA.paid];
  check(ad[invA.amount] === PRICE && ad[invA.paid] === true, 'd: auditor decrypts amount=25, paid=true');
  let deniedOther = false;
  try { await a.sdk.decryption.decryptValues([{ encryptedValue: invB.amount, contractAddress: PAYLINKS }]); } catch { deniedOther = true; }
  check(deniedOther, 'd: auditor still cannot decrypt invoice b');

  const pages = await pub.readContract({ address: READER, abi: parseAbi(['function invoicesOf(address,address,uint256,uint256) view returns (bytes32[])']), functionName: 'invoicesOf', args: [PAYLINKS, m.address, 0n, 10n] });
  check(pages.includes(idA) && pages.includes(idB), 'reader lists both invoices');
  out.result = 'PASS';
} catch (e) {
  out.result = 'FAIL';
  out.error = String(e?.stack ?? e).slice(0, 1500);
  console.error(e);
  process.exitCode = 1;
} finally {
  out.finished = new Date().toISOString();
  save();
  console.log(`result: ${out.result}`);
  process.exit();
}
