// End-to-end test against a local anvil running the cleartext FHEVM host stack (scripts/local-chain.sh), using the
// Zama SDK's cleartext relayer: the same SDK calls the web app makes (encrypt, user decrypt, public decrypt), the same
// contract and the same OpenZeppelin ERC-7984 wrapper code as on Sepolia. Only the FHE backend is replaced.
//
// Run:  ../scripts/local-chain.sh   (in another terminal; writes web/.env.development.local)
//       npm run e2e
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleartext, memoryStorage, ZamaSDK } from '@zama-fhe/sdk';
import { hardhat } from '@zama-fhe/sdk/chains';
import { createConfig } from '@zama-fhe/sdk/viem';
import { createPublicClient, createWalletClient, encodeAbiParameters, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { erc7984Abi, mintableErc20Abi, payLinksAbi, paymentFromReceipt, readInvoice, readPayments } from '../src/contract';
import { checkDetails, decodeLink, detailsHashOf, encodeLink, invoiceIdOf, randomBytes32 } from '../src/link';

const envFile = fileURLToPath(new URL('../.env.development.local', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k} (run scripts/local-chain.sh first)`);
  return v;
};

const RPC = process.env.E2E_RPC_URL ?? 'http://127.0.0.1:8545';
// Well-known anvil dev keys #1..#4 (public test keys, local chain only).
const KEYS = {
  merchant: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  auditor: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;

const chain = { ...foundry, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;

function actor(pk: Hex) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ chain, account, transport: http(RPC) });
  const sdk = new ZamaSDK(
    createConfig({
      chains: [{ ...hardhat, network: RPC }],
      publicClient: pub,
      walletClient: wallet,
      storage: memoryStorage,
      relayers: { [hardhat.id]: cleartext() },
    } as Parameters<typeof createConfig>[0]),
  );
  return { address: account.address, wallet, sdk };
}

async function send(w: ReturnType<typeof actor>['wallet'], req: Parameters<typeof w.writeContract>[0]) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r;
}

describe('Confidential Pay Links end to end (local cleartext FHEVM)', () => {
  it('creates a link, refunds a wrong payment, accepts the right one, and discloses selectively', async () => {
    const payLinks = need('VITE_LOCAL_PAYLINKS') as Address;
    const token = need('VITE_LOCAL_TOKEN') as Address;
    const underlying = need('VITE_LOCAL_UNDERLYING') as Address;
    const chainId = await pub.getChainId();
    const m = actor(KEYS.merchant);
    const p = actor(KEYS.payer);
    const a = actor(KEYS.auditor);
    const s = actor(KEYS.stranger);
    const log: Record<string, unknown> = { chainId, payLinks, token, merchant: m.address, payer: p.address };
    const balanceOf = async (who: ReturnType<typeof actor>) => {
      const h = await pub.readContract({ address: token, abi: erc7984Abi, functionName: 'confidentialBalanceOf', args: [who.address] });
      return (await who.sdk.decryption.decryptValues([{ encryptedValue: h, contractAddress: token }]))[h] as bigint;
    };

    // Payer gets test tokens: mint the public ERC-20, then wrap it into the ERC-7984 token.
    await send(p.wallet, { address: underlying, abi: mintableErc20Abi, functionName: 'mint', args: [p.address, 1_000_000_000n], chain, account: p.wallet.account! });
    await send(p.wallet, { address: underlying, abi: mintableErc20Abi, functionName: 'approve', args: [token, 1_000_000_000n], chain, account: p.wallet.account! });
    await send(p.wallet, { address: token, abi: erc7984Abi, functionName: 'wrap', args: [p.address, 1_000_000_000n], chain, account: p.wallet.account! });
    const payerStart = await balanceOf(p);
    const merchantStart = await balanceOf(m);

    // 1. Merchant creates an invoice for 25.00, encrypting the amount client-side.
    const price = 25_000_000n;
    const nonce = randomBytes32();
    const salt = randomBytes32();
    const invoiceId = invoiceIdOf(chainId, payLinks, m.address, nonce);
    const link = { chainId, invoiceId, salt, memo: 'Invoice #42 — logo design', amount: price };
    const enc = await m.sdk.encrypt({ values: [{ value: price, type: 'euint64' }], contractAddress: payLinks, userAddress: m.address });
    await send(m.wallet, {
      address: payLinks, abi: payLinksAbi, functionName: 'createInvoice',
      args: [nonce, token, '0x0000000000000000000000000000000000000000', 0, detailsHashOf(link), enc.encryptedValues[0] as Hex, enc.inputProof as Hex],
      chain, account: m.wallet.account!,
    });
    const url = encodeLink(link);
    const decoded = decodeLink(url);
    const inv = (await readInvoice(pub, payLinks, decoded.invoiceId))!;
    expect(inv.merchant).toBe(m.address);
    expect(checkDetails(decoded, inv.detailsHash)).toBe('verified');
    expect(checkDetails({ ...decoded, amount: price - 1n }, inv.detailsHash)).toBe('modified');
    log.link = url;

    const pay = async (who: ReturnType<typeof actor>, amount: bigint) => {
      const e = await who.sdk.encrypt({ values: [{ value: amount, type: 'euint64' }], contractAddress: token, userAddress: who.address });
      const data = encodeAbiParameters([{ type: 'bytes32' }], [invoiceId]);
      const r = await send(who.wallet, {
        address: token, abi: erc7984Abi, functionName: 'confidentialTransferAndCall',
        args: [payLinks, e.encryptedValues[0] as Hex, e.inputProof as Hex, data], chain, account: who.wallet.account!,
      });
      const ev = paymentFromReceipt(r, payLinks);
      expect(ev?.invoiceId).toBe(invoiceId);
      return { ...ev!, tx: r.transactionHash, gas: r.gasUsed };
    };

    // 2. A wrong amount is refunded, and the payer can see that.
    const wrong = await pay(p, price - 1n);
    const payments1 = await readPayments(pub, payLinks, invoiceId);
    const acc0 = payments1[wrong.index]!.accepted;
    expect((await p.sdk.decryption.decryptValues([{ encryptedValue: acc0, contractAddress: payLinks }]))[acc0]).toBe(false);
    expect(await balanceOf(p)).toBe(payerStart);

    // 3. The exact amount is forwarded to the merchant.
    const right = await pay(p, price);
    const payments2 = await readPayments(pub, payLinks, invoiceId);
    const acc1 = payments2[right.index]!.accepted;
    expect((await p.sdk.decryption.decryptValues([{ encryptedValue: acc1, contractAddress: payLinks }]))[acc1]).toBe(true);
    expect(await balanceOf(p)).toBe(payerStart - price);
    expect(await balanceOf(m)).toBe(merchantStart + price);
    log.payTx = right.tx;
    log.payGas = right.gas;

    // 4. Merchant decrypts the amount and the paid flag.
    const inv2 = (await readInvoice(pub, payLinks, invoiceId))!;
    const md = await m.sdk.decryption.decryptValues([
      { encryptedValue: inv2.amount, contractAddress: payLinks },
      { encryptedValue: inv2.paid, contractAddress: payLinks },
    ]);
    expect(md[inv2.amount]).toBe(price);
    expect(md[inv2.paid]).toBe(true);

    // 5. Selective disclosure: an auditor cannot decrypt until the merchant grants this one invoice.
    await expect(a.sdk.decryption.decryptValues([{ encryptedValue: inv2.amount, contractAddress: payLinks }])).rejects.toThrow();
    await send(m.wallet, { address: payLinks, abi: payLinksAbi, functionName: 'addViewer', args: [invoiceId, a.address], chain, account: m.wallet.account! });
    const ad = await a.sdk.decryption.decryptValues([
      { encryptedValue: inv2.amount, contractAddress: payLinks },
      { encryptedValue: inv2.paid, contractAddress: payLinks },
    ]);
    expect(ad[inv2.amount]).toBe(price);
    expect(ad[inv2.paid]).toBe(true);
    await expect(s.sdk.decryption.decryptValues([{ encryptedValue: inv2.paid, contractAddress: payLinks }])).rejects.toThrow();

    // 6. Public "paid?" proof: publish only the flag, decrypt it without a wallet, record it on chain.
    await send(m.wallet, { address: payLinks, abi: payLinksAbi, functionName: 'publishPaidStatus', args: [invoiceId], chain, account: m.wallet.account! });
    const published = await pub.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'publishedPaidHandle', args: [invoiceId] });
    const pd = await s.sdk.decryption.decryptPublicValues([published]);
    expect(pd.clearValues[published]).toBe(true);
    await send(s.wallet, {
      address: payLinks, abi: payLinksAbi, functionName: 'confirmPaidStatus',
      args: [invoiceId, pd.abiEncodedClearValues as Hex, pd.decryptionProof as Hex], chain, account: s.wallet.account!,
    });
    expect(await pub.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'paidConfirmed', args: [invoiceId] })).toBe(true);
    // The amount was never made public.
    await expect(s.sdk.decryption.decryptPublicValues([inv2.amount])).rejects.toThrow();

    const dir = fileURLToPath(new URL('../../e2e-results/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}local-cleartext.json`, JSON.stringify(log, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  });
});
