import { encodeAbiParameters, getAddress, isAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { defaultChainId, explorerAddress, explorerTx, networkOf, networks, payLinksOf, readerOf, tokenInfo, type TokenInfo } from './chains';
import {
  erc7984Abi,
  isOpenPayer,
  mintableErc20Abi,
  openState,
  payLinksAbi,
  paymentFromReceipt,
  readInvoice,
  readMerchantInvoiceIds,
  readPayerPayments,
  readPayment,
  readRecentPayments,
  type Payment,
  type Invoice,
} from './contract';
import { encryptU64, fheFor, withRetry } from './fhe';
import { gasLimitFor, looksOutOfGas } from './gas';
import {
  checkDetails,
  decodeLink,
  detailsHashOf,
  encodeLink,
  formatAmount,
  invoiceIdOf,
  MAX_MEMO_BYTES,
  parseAmount,
  randomBytes32,
  type PayLink,
} from './link';
import { savedLinkFor, saveLinkQuery } from './store';
import { badge, card, copy, errText, extLink, fmtTime, h, render, row, short, statusLine, testBanner, type Child } from './ui';
import { connectWallet, publicClientFor } from './wallet';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const now = () => Math.floor(Date.now() / 1000);
const baseUrl = () => `${location.origin}${location.pathname}`;

type Session = { chainId: number; wallet: WalletClient; account: Address; client: PublicClient };

async function connect(chainId: number): Promise<Session> {
  const { wallet, account } = await connectWallet(networkOf(chainId).chain);
  return { chainId, wallet, account, client: publicClientFor(chainId) };
}

const sdkOf = (s: Session) => fheFor(s.chainId, s.client, s.wallet);

/** A transaction that reached the chain and reverted. Carries an explorer link for the status line. */
export class TxRevertedError extends Error {
  constructor(message: string, readonly explorerUrl?: string) {
    super(message);
  }
}

async function sendTx(
  s: Session,
  req: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
  say: (m: string) => void,
) {
  const { request } = await s.client.simulateContract({ ...req, account: s.account } as Parameters<PublicClient['simulateContract']>[0]);
  // Explicit gas: wallet estimates (especially through smart-account wrappers) have run out of gas on FHE calls.
  let estimate: bigint | undefined;
  try {
    estimate = await s.client.estimateContractGas({ ...req, account: s.account } as Parameters<PublicClient['estimateContractGas']>[0]);
  } catch {
    estimate = undefined; // the floor still applies
  }
  const gas = gasLimitFor(req.functionName, estimate);
  // MetaMask can replace a dapp's gas limit with its own zero-margin estimate (MetaMask/metamask-extension#46334),
  // which FHE transactions can outgrow. Tell the user what to look for.
  say(`Confirm in your wallet. Suggested gas limit: ${gas.toLocaleString('en-US')}. If your wallet shows a lower limit, raise it (MetaMask: Edit network fee → Advanced → Gas limit).`);
  const hash = await s.wallet.writeContract({ ...(request as object), gas } as Parameters<WalletClient['writeContract']>[0]);
  say(`Sent ${short(hash)}. Waiting for the block…`);
  const r = await s.client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') {
    const tx = await s.client.getTransaction({ hash }).catch(() => undefined);
    const oog = looksOutOfGas(r.gasUsed, tx?.gas);
    const lowered = tx?.gas !== undefined && tx.gas < gas ? ` Your wallet sent a gas limit of ${tx.gas.toLocaleString('en-US')} instead of the suggested ${gas.toLocaleString('en-US')}.` : '';
    throw new TxRevertedError(
      `Transaction ${short(hash)} reverted${oog ? `: it most likely ran out of gas.${lowered} Try again and set the gas limit to at least ${gas.toLocaleString('en-US')} in your wallet (MetaMask: Edit network fee → Advanced).` : `.${lowered} Try again; if it keeps failing, open it in the explorer.`}`,
      explorerTx(s.chainId, hash),
    );
  }
  return r;
}

/** Token metadata: the app's list first, then the token itself. */
async function tokenMeta(chainId: number, token: Address): Promise<TokenInfo & { listed: boolean }> {
  const known = tokenInfo(chainId, token);
  if (known) return { ...known, listed: true };
  const c = publicClientFor(chainId);
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address: token, abi: erc7984Abi, functionName: 'symbol' }).catch(() => '?'),
    c.readContract({ address: token, abi: erc7984Abi, functionName: 'decimals' }).catch(() => 6),
  ]);
  // Never show an unlisted token under its self-declared name alone: anyone can deploy a token called "cUSDC".
  return { address: token, symbol: `UNLISTED (claims "${String(symbol).slice(0, 20)}")`, decimals: Number(decimals), listed: false };
}

function stateBadge(inv: Invoice) {
  const st = openState(inv, now());
  return st === 'open' ? badge('open', 'open') : badge(st, 'bad');
}

function lockedValue(text = 'encrypted') {
  return h('span', { class: 'locked' }, '🔒 ', text);
}

function networkBanner(chainId: number) {
  const n = networks[chainId];
  return n ? testBanner(n.chain.name) : null;
}

// ================================================================== create

export function viewCreate() {
  const status = statusLine();
  const network = h('select', { id: 'network' });
  for (const n of Object.values(networks)) {
    const opt = h('option', { value: String(n.chain.id) }, `${n.chain.name}${n.payLinks ? '' : ' (not deployed yet)'}`);
    if (n.chain.id === defaultChainId()) opt.selected = true;
    network.append(opt);
  }
  const token = h('select', { id: 'token' });
  const fillTokens = () => {
    token.replaceChildren(...networkOf(Number(network.value)).tokens.map((t) => h('option', { value: t.address }, t.symbol)));
  };
  fillTokens();
  network.addEventListener('change', fillTokens);
  const amount = h('input', { id: 'amount', placeholder: '25.00', inputmode: 'decimal', autocomplete: 'off' });
  const memo = h('input', { id: 'memo', placeholder: 'Invoice #42 — logo design', maxlength: String(MAX_MEMO_BYTES) });
  const payer = h('input', { id: 'payer', placeholder: 'Optional: 0x… only this address can pay and see the amount', autocomplete: 'off' });
  const expiry = h('select', { id: 'expiry' },
    h('option', { value: '0' }, 'Never'),
    h('option', { value: String(24 * 3600) }, 'In 24 hours'),
    h('option', { value: String(7 * 24 * 3600), selected: '' }, 'In 7 days'),
    h('option', { value: String(30 * 24 * 3600) }, 'In 30 days'),
  );
  const inLink = h('input', { id: 'inlink', type: 'checkbox', checked: '' });
  const out = h('div', { class: 'out' });

  const form = h('form', { onsubmit: async (e: Event) => {
    e.preventDefault();
    out.replaceChildren();
    const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
    submit.disabled = true;
    try {
      const chainId = Number(network.value);
      const net = networkOf(chainId);
      const contract = payLinksOf(chainId);
      const tok = net.tokens.find((t) => t.address === token.value)!;
      const value = parseAmount(amount.value, tok.decimals);
      const fixedPayer = payer.value.trim();
      if (fixedPayer && !isAddress(fixedPayer)) throw new Error('The payer must be a 0x address, or empty');
      status.pending('Connecting wallet…');
      const s = await connect(chainId);
      const nonce = randomBytes32();
      const link: PayLink = {
        chainId,
        invoiceId: invoiceIdOf(chainId, contract, s.account, nonce),
        salt: randomBytes32(),
        memo: memo.value.trim(),
        amount: inLink.checked ? value : undefined,
      };
      encodeLink(link); // validates memo etc. before any signature
      const enc = await withRetry(() => encryptU64(sdkOf(s), value, contract, s.account), {
        label: 'Encrypting the amount in your browser',
        onProgress: (p) => status.pending(p.message),
      });
      const secs = Number(expiry.value);
      await sendTx(s, {
        address: contract,
        abi: payLinksAbi,
        functionName: 'createInvoice',
        args: [nonce, tok.address, fixedPayer ? getAddress(fixedPayer) : ZERO_ADDR, secs ? now() + secs : 0, detailsHashOf(link), enc.handle, enc.inputProof],
      }, status.pending);
      const q = encodeLink(link);
      saveLinkQuery(q);
      const url = `${baseUrl()}#/pay?${q}`;
      const input = h('input', { readonly: '', value: url, class: 'mono' });
      status.ok('Invoice created on chain. The amount is stored encrypted.');
      out.append(
        h('h3', {}, 'Your payment link'),
        input,
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: async () => status.ok((await copy(url, input)) ? 'Copied.' : 'Select and copy the link.') }, 'Copy link'),
          h('a', { class: 'button ghost', href: `#/pay?${q}` }, 'Open it'),
          h('a', { class: 'button ghost', href: '#/dashboard' }, 'Dashboard'),
        ),
        row('Invoice id', h('code', {}, link.invoiceId)),
        h('p', { class: 'hint' },
          link.amount === undefined
            ? 'The amount is not in the link. ' + (fixedPayer ? 'The payer you named can decrypt it.' : 'Before someone can pay, add their address as a viewer in your dashboard so they can decrypt it.')
            : 'The amount and memo travel in the link (after the #, so they never reach a server) and are checked against a commitment stored with the invoice. On chain the amount is only stored encrypted.',
          ' Keep this link: the memo exists only in it and in this browser.'),
      );
    } catch (err) {
      status.error(err);
    } finally {
      submit.disabled = false;
    }
  } },
    h('label', { for: 'network' }, 'Network'), network,
    h('label', { for: 'token' }, 'Get paid in'), token,
    h('label', { for: 'amount' }, 'Amount'), amount,
    h('label', { for: 'memo' }, 'Memo (only in the link, never on chain)'), memo,
    h('label', { for: 'payer' }, 'Payer (optional)'), payer,
    h('label', { for: 'expiry' }, 'Expires'), expiry,
    h('label', { class: 'check' }, inLink, ' Put the amount in the link, so anyone holding the link can see it without a wallet'),
    h('button', { type: 'submit' }, 'Create confidential payment link'),
  );
  render(
    card(networkBanner(Number(network.value)), h('h2', {}, 'Request a confidential payment'), form, status.el, out),
    h('section', { class: 'explain' },
      h('p', {}, 'Amounts are encrypted with Fully Homomorphic Encryption (Zama Protocol). The contract checks the payment against the invoice without ever seeing either number, forwards an exact payment to you, and refunds anything else. Observers see that a payment happened, not how much or whether it was accepted.'),
      h('p', {}, h('a', { href: '#/how' }, 'What is public and what is private →')),
    ),
  );
}

// ================================================================== pay

export async function viewPay(query: string) {
  let link: PayLink;
  try {
    link = decodeLink(query);
  } catch (e) {
    return render(card(h('h2', {}, 'This link is broken'), h('p', {}, errText(e))));
  }
  render(card(h('p', {}, 'Reading the invoice…')));
  let inv: Invoice | null;
  let contract: Address;
  try {
    contract = payLinksOf(link.chainId);
    inv = await readInvoice(publicClientFor(link.chainId), contract, link.invoiceId);
  } catch (e) {
    return render(card(h('h2', {}, 'Could not read the invoice'), h('p', {}, errText(e)), retryButton()));
  }
  if (!inv) {
    return render(card(networkBanner(link.chainId), h('h2', {}, 'Invoice not found'),
      h('p', {}, `There is no invoice with this id on ${networkOf(link.chainId).chain.name} for this contract. Invoice ids are bound to one network and one contract, so a link for another network or deployment cannot be paid here.`)));
  }
  const invoice = inv;
  const tok = await tokenMeta(link.chainId, invoice.token);
  const details = checkDetails(link, invoice.detailsHash);
  const state = openState(invoice, now());
  const status = statusLine();
  const amountSlot = h('span', {}, link.amount !== undefined && details === 'verified' ? `${formatAmount(link.amount, tok.decimals)} ${tok.symbol}` : lockedValue());
  let knownAmount = details === 'verified' ? link.amount : undefined;
  const payBtn = h('button', { type: 'button' }, 'Pay');
  const balanceSlot = h('span', { class: 'muted' }, '');
  let session: Session | undefined;

  const ensureSession = async () => {
    session ??= await connect(link.chainId);
    if (!isOpenPayer(invoice.payer) && session.account.toLowerCase() !== invoice.payer.toLowerCase())
      throw new Error(`Only ${invoice.payer} can pay this invoice. Switch account in your wallet.`);
    return session;
  };

  const revealBtn = h('button', { type: 'button', class: 'ghost', onclick: async () => {
    try {
      const s = await ensureSession();
      const v = await withRetry(() => sdkOf(s).decryption.decryptValues([{ encryptedValue: invoice.amount, contractAddress: contract }]), {
        label: 'Decrypting the amount (sign once in your wallet)',
        onProgress: (p) => status.pending(p.message),
      });
      knownAmount = v[invoice.amount] as bigint;
      amountSlot.replaceChildren(`${formatAmount(knownAmount, tok.decimals)} ${tok.symbol}`);
      revealBtn.remove();
      status.ok('Amount decrypted for your address only.');
      updatePay();
    } catch (e) {
      status.error(e, () => revealBtn.click());
      if (/not allowed to decrypt|NOT_ENTITLED|not authorized/i.test(errText(e)) && session)
        status.error(new Error(`This address (${session.account}) cannot see the amount yet. Send it to the merchant and ask them to add it as a viewer.`));
    }
  } }, 'Decrypt amount');

  const balanceBtn = h('button', { type: 'button', class: 'ghost small', onclick: async () => {
    try {
      const s = await ensureSession();
      const handle = await s.client.readContract({ address: invoice.token, abi: erc7984Abi, functionName: 'confidentialBalanceOf', args: [s.account] });
      const v = await withRetry(() => sdkOf(s).decryption.decryptValues([{ encryptedValue: handle, contractAddress: invoice.token }]), {
        label: 'Decrypting your balance', onProgress: (p) => status.pending(p.message),
      });
      balanceSlot.textContent = `${formatAmount((v[handle] as bigint) ?? 0n, tok.decimals)} ${tok.symbol}`;
      status.clear();
    } catch (e) {
      status.error(e, () => balanceBtn.click());
    }
  } }, 'Show my balance');

  const net = networkOf(link.chainId);
  const faucet = tok.mintableUnderlying
    ? h('button', { type: 'button', class: 'ghost small', onclick: async () => {
      try {
        const s = await ensureSession();
        const amt = 100n * 10n ** BigInt(tok.decimals);
        await sendTx(s, { address: tok.mintableUnderlying!, abi: mintableErc20Abi, functionName: 'mint', args: [s.account, amt] }, status.pending);
        await sendTx(s, { address: tok.mintableUnderlying!, abi: mintableErc20Abi, functionName: 'approve', args: [tok.address, amt] }, status.pending);
        await sendTx(s, { address: tok.address, abi: erc7984Abi, functionName: 'wrap', args: [s.account, amt] }, status.pending);
        status.ok(`Minted and shielded 100 test ${tok.symbol}.`);
      } catch (e) {
        status.error(e);
      }
    } }, `Get 100 test ${tok.symbol}`)
    : null;

  const ack = h('input', { type: 'checkbox' });
  ack.addEventListener('change', () => updatePay());
  const updatePay = () => {
    const can = state === 'open' && details === 'verified' && knownAmount !== undefined && (tok.listed || ack.checked);
    payBtn.toggleAttribute('disabled', !can);
    payBtn.textContent = knownAmount !== undefined ? `Pay ${formatAmount(knownAmount, tok.decimals)} ${tok.symbol}` : 'Pay';
  };
  updatePay();

  payBtn.addEventListener('click', async () => {
    payBtn.setAttribute('disabled', '');
    try {
      const s = await ensureSession();
      const amt = knownAmount!;
      const enc = await withRetry(() => encryptU64(sdkOf(s), amt, invoice.token, s.account), {
        label: 'Encrypting your payment', onProgress: (p) => status.pending(p.message),
      });
      const data = encodeAbiParameters([{ type: 'bytes32' }], [link.invoiceId]);
      const r = await sendTx(s, {
        address: invoice.token, abi: erc7984Abi, functionName: 'confidentialTransferAndCall',
        args: [contract, enc.handle, enc.inputProof, data],
      }, status.pending);
      const ev = paymentFromReceipt(r, contract);
      if (!ev) throw new Error('The transaction did not reach the invoice contract');
      location.hash = `#/receipt?c=${link.chainId}&id=${link.invoiceId}&i=${ev.index}&tx=${r.transactionHash}`;
    } catch (e) {
      status.error(e);
      updatePay();
    }
  });

  const warnings: Child[] = [];
  if (details === 'modified')
    warnings.push(h('div', { class: 'alert' }, 'This link was modified: its memo or amount does not match what the merchant committed to on chain. Do not pay from it; ask the merchant for the original link.'));
  if (!tok.listed)
    warnings.push(h('div', { class: 'alert' }, `This invoice asks for a token this app does not list: ${invoice.token}. Its name proves nothing. Only pay if you have checked this exact address.`,
      h('label', { class: 'check' }, ack, ' I checked the token address and want to pay in it')));
  if (state !== 'open') warnings.push(h('div', { class: 'alert' }, `This invoice is ${state} and cannot be paid.`));

  render(
    card(
      networkBanner(link.chainId),
      ...warnings,
      h('h2', {}, 'Payment request ', stateBadge(invoice)),
      h('p', { class: 'amount' }, amountSlot),
      link.memo && details === 'verified' ? row('For', link.memo) : null,
      row('Pay to', extLink(explorerAddress(link.chainId, invoice.merchant), invoice.merchant)),
      row('Token', extLink(explorerAddress(link.chainId, invoice.token), tok.symbol)),
      !isOpenPayer(invoice.payer) ? row('Payer', invoice.payer) : null,
      invoice.expiresAt ? row('Expires', fmtTime(invoice.expiresAt)) : null,
      row('Network', net.chain.name),
      row('Your balance', h('span', {}, balanceSlot, ' ', balanceBtn, ' ', faucet ?? '')),
      h('div', { class: 'actions' }, knownAmount === undefined && details === 'verified' ? revealBtn : null, payBtn),
      status.el,
      h('p', { class: 'hint' }, `Gas: an encrypted payment needs about 4.5–4.8M gas on Sepolia. The app suggests ${gasLimitFor('confidentialTransferAndCall', undefined).toLocaleString('en-US')}; some wallets (MetaMask) replace it with a tight estimate of their own. If a payment fails out of gas, set the gas limit to at least that under Edit network fee → Advanced.`),
      h('p', { class: 'hint' }, 'Your payment is encrypted in your browser and sent with one confidentialTransferAndCall. If the amount does not match exactly, or the invoice was already paid, the token refunds you in the same transaction. Nobody watching the chain can tell which happened. You pay network gas in ETH.'),
      h('p', { class: 'hint' }, 'Already paid? ', h('a', { href: `#/check?c=${link.chainId}&id=${link.invoiceId}` }, 'Public paid check'), ' · ', h('a', { href: '#/receipts' }, 'My payments')),
    ),
  );
}

function retryButton() {
  return h('button', { type: 'button', class: 'ghost', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, 'Retry');
}

// ================================================================== payer receipt

export async function viewReceipt(query: string) {
  const p = new URLSearchParams(query);
  const chainId = Number(p.get('c'));
  const invoiceId = p.get('id') as Hex;
  const index = Number(p.get('i'));
  const txParam = p.get('tx');
  const tx = txParam && /^0x[0-9a-fA-F]{64}$/.test(txParam) ? txParam : null;
  const status = statusLine();
  const result = h('div', {});
  let payment: Payment | undefined;
  let contract: Address;
  try {
    contract = payLinksOf(chainId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(invoiceId ?? '') || !Number.isSafeInteger(index) || index < 0) throw new Error('Bad receipt link');
    payment = await readPayment(publicClientFor(chainId), contract, invoiceId, index);
  } catch (e) {
    return render(card(h('h2', {}, 'Payment not found'), h('p', {}, errText(e)), retryButton()));
  }
  const pay = payment;
  const inv = (await readInvoice(publicClientFor(chainId), contract, invoiceId))!;
  const tok = await tokenMeta(chainId, inv.token);
  const decryptBtn = h('button', { type: 'button', onclick: async () => {
    decryptBtn.setAttribute('disabled', '');
    try {
      const s = await connect(chainId);
      if (s.account.toLowerCase() !== pay.payer.toLowerCase()) throw new Error(`This payment was made by ${pay.payer}. Switch to that account to decrypt it.`);
      const v = await withRetry(() => sdkOf(s).decryption.decryptValues([
        { encryptedValue: pay.accepted, contractAddress: contract },
        { encryptedValue: pay.received, contractAddress: contract },
      ]), { label: 'Decrypting your receipt', attempts: 6, onProgress: (x) => status.pending(x.message) });
      const ok = v[pay.accepted] === true;
      const amt = v[pay.received] as bigint;
      status.clear();
      result.replaceChildren(
        h('h3', {}, ok ? badge('accepted — the merchant was paid', 'ok') : badge('refunded — your tokens came back', 'bad')),
        row('Amount you sent', `${formatAmount(amt, tok.decimals)} ${tok.symbol}`),
        h('p', { class: 'hint' }, ok
          ? 'Only you, the merchant and viewers the merchant names can decrypt this.'
          : 'The amount did not match the invoice, the invoice was already paid, or your balance was too low (an ERC-7984 transfer then moves 0). Nothing left your wallet except gas.'),
      );
      decryptBtn.remove();
    } catch (e) {
      status.error(e, () => decryptBtn.click());
      decryptBtn.removeAttribute('disabled');
    }
  } }, 'Decrypt my receipt');
  render(card(
    networkBanner(chainId),
    h('h2', {}, 'Payment receipt'),
    row('Invoice', h('code', {}, invoiceId)),
    row('Payer', pay.payer),
    row('Merchant', inv.merchant),
    row('Token', extLink(explorerAddress(chainId, inv.token), tok.symbol)),
    row('Time', fmtTime(pay.paidAt)),
    tx ? row('Transaction', extLink(explorerTx(chainId, tx), short(tx))) : null,
    row('Outcome', lockedValue('encrypted — only you and the merchant can see it')),
    result,
    h('div', { class: 'actions' }, decryptBtn),
    status.el,
    h('p', { class: 'hint' }, 'Decryption goes through the Zama relayer. If the testnet is having an outage this page keeps retrying for a while; your payment is already final on chain either way.'),
  ));
}

export async function viewMyPayments() {
  const list = h('div', { class: 'links' });
  const status = statusLine();
  const go = async () => {
    try {
      const chainId = defaultChainId();
      const s = await connect(chainId);
      const refs = await readPayerPayments(s.client, payLinksOf(chainId), readerOf(chainId), s.account);
      list.replaceChildren(...(refs.length ? refs.map((r) =>
        h('div', { class: 'linkrow' }, h('a', { href: `#/receipt?c=${chainId}&id=${r.invoiceId}&i=${r.index}` }, `${short(r.invoiceId)} · payment #${r.index}`))) : [h('p', {}, 'No payments from this address yet.')]));
      status.clear();
    } catch (e) {
      status.error(e, go);
    }
  };
  render(card(h('h2', {}, 'My payments'), h('button', { type: 'button', onclick: go }, 'Connect wallet'), status.el, list));
}

// ================================================================== merchant dashboard

const RECENT_PAYMENTS = 20;
type Row = { id: Hex; inv: Invoice; tok: TokenInfo; link?: PayLink; payments: Payment[]; paymentTotal: number };

export function viewDashboard() {
  const status = statusLine();
  const body = h('div', {});
  const network = h('select', {});
  for (const n of Object.values(networks)) {
    if (!n.payLinks) continue;
    const o = h('option', { value: String(n.chain.id) }, n.chain.name);
    if (n.chain.id === defaultChainId()) o.selected = true;
    network.append(o);
  }
  let rows: Row[] = [];
  let session: Session | undefined;
  const clear = new Map<string, bigint | boolean>();

  const load = async () => {
    try {
      const chainId = Number(network.value);
      status.pending('Connecting wallet…');
      session = await connect(chainId);
      const contract = payLinksOf(chainId);
      status.pending('Reading your invoices…');
      const ids = await readMerchantInvoiceIds(session.client, contract, readerOf(chainId), session.account);
      rows = await Promise.all(ids.reverse().map(async (id) => {
        const inv = (await readInvoice(session!.client, contract, id))!;
        const recent = await readRecentPayments(session!.client, contract, readerOf(chainId), id, RECENT_PAYMENTS);
        return { id, inv, tok: await tokenMeta(chainId, inv.token), link: savedLinkFor(chainId, id), payments: recent.items, paymentTotal: recent.total };
      }));
      status.clear();
      draw();
    } catch (e) {
      status.error(e, load);
    }
  };

  const decryptAll = async () => {
    if (!session) return;
    const contract = payLinksOf(session.chainId);
    const inputs = rows.flatMap((r) => [r.inv.amount, r.inv.paid, ...r.payments.flatMap((p) => [p.received, p.accepted])])
      .map((encryptedValue) => ({ encryptedValue, contractAddress: contract }));
    if (!inputs.length) return;
    try {
      const v = await withRetry(() => sdkOf(session!).decryption.decryptValues(inputs), {
        label: `Decrypting ${inputs.length} values (one signature)`, attempts: 6, onProgress: (p) => status.pending(p.message),
      });
      for (const [k, val] of Object.entries(v)) clear.set(k.toLowerCase(), val as bigint | boolean);
      status.ok('Decrypted locally. Nothing was revealed to anyone else.');
      draw();
    } catch (e) {
      status.error(e, decryptAll);
    }
  };

  const val = (handle: Hex) => clear.get(handle.toLowerCase());
  const amt = (r: Row, handle: Hex) => {
    const v = val(handle);
    return typeof v === 'bigint' ? `${formatAmount(v, r.tok.decimals)} ${r.tok.symbol}` : lockedValue();
  };
  const paidCell = (handle: Hex) => {
    const v = val(handle);
    return v === undefined ? lockedValue() : v ? badge('paid', 'ok') : badge('unpaid', 'open');
  };

  /** Runs a merchant action, reloads the list, then shows the action's result (load() resets the status line). */
  const action = (label: string, fn: (r: Row) => Promise<string | void>, r: Row, cls = 'ghost small') =>
    h('button', { type: 'button', class: cls, onclick: async () => {
      try {
        const msg = await fn(r);
        if (msg === undefined) return;
        await load();
        if (clear.size) await decryptAll(); // permit is cached: no new wallet prompt
        status.ok(msg);
      } catch (e) {
        status.error(e);
      }
    } }, label);

  const addViewer = async (r: Row) => {
    const who = prompt('Address that may decrypt this invoice\'s amount and paid status (an auditor, or the payer).\nThis cannot be revoked: they keep access to these values and to later paid-status updates of this invoice.')?.trim();
    if (!who) return;
    if (!isAddress(who)) throw new Error('Not an address');
    await sendTx(session!, { address: payLinksOf(session!.chainId), abi: payLinksAbi, functionName: 'addViewer', args: [r.id, getAddress(who)] }, status.pending);
    return `Done. Send them: ${baseUrl()}#/audit?c=${session!.chainId}&id=${r.id}`;
  };
  const cancel = async (r: Row) => {
    if (!confirm('Cancel this invoice? Later payments will be rejected.')) return;
    await sendTx(session!, { address: payLinksOf(session!.chainId), abi: payLinksAbi, functionName: 'cancelInvoice', args: [r.id] }, status.pending);
    return 'Invoice cancelled.';
  };
  const publish = async (r: Row) => {
    if (!confirm('Make this invoice\'s paid / not-paid status public? The amount stays private, but payment attempts are public, so the timing can hint which attempt succeeded. This cannot be undone for the current status.')) return;
    await sendTx(session!, { address: payLinksOf(session!.chainId), abi: payLinksAbi, functionName: 'publishPaidStatus', args: [r.id] }, status.pending);
    return `Published. Public check: ${baseUrl()}#/check?c=${session!.chainId}&id=${r.id}`;
  };

  const exportCsv = () => {
    // Quote every cell and defuse spreadsheet formulas (a memo like "=HYPERLINK(...)" would otherwise run).
    const esc = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const lines = [['invoice_id', 'created_utc', 'token', 'memo', 'state', 'amount', 'paid', 'payments', `accepted_payer_in_latest_${RECENT_PAYMENTS}`].join(',')];
    for (const r of rows) {
      const a = val(r.inv.amount);
      const accepted = r.payments.find((p) => val(p.accepted) === true);
      lines.push([
        r.id, fmtTime(r.inv.createdAt), r.tok.symbol, r.link?.memo ?? '', openState(r.inv, now()),
        typeof a === 'bigint' ? formatAmount(a, r.tok.decimals) : 'encrypted',
        String(val(r.inv.paid) ?? 'encrypted'), String(r.paymentTotal),
        // Only the latest attempts are loaded and decrypted (attempts can be spammed); say so instead of guessing.
        accepted?.payer ?? (r.paymentTotal > r.payments.length ? `not among latest ${RECENT_PAYMENTS} attempts` : ''),
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'confidential-invoices.csv' });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const draw = () => {
    if (!session) return;
    if (!rows.length) {
      body.replaceChildren(h('p', {}, 'No invoices from this address yet. ', h('a', { href: '#/' }, 'Create one.')));
      return;
    }
    body.replaceChildren(
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: decryptAll }, 'Decrypt all (one signature)'),
        h('button', { type: 'button', class: 'ghost', onclick: exportCsv }, 'Export CSV'),
        h('button', { type: 'button', class: 'ghost', onclick: load }, 'Refresh')),
      ...rows.map((r) => h('div', { class: 'invoice' },
        h('div', { class: 'invoice-head' },
          h('strong', {}, r.link?.memo || short(r.id)), ' ',
          // "open" next to "paid" reads as a contradiction; only show the state when it adds information.
          val(r.inv.paid) === true && openState(r.inv, now()) === 'open' ? null : stateBadge(r.inv), ' ', paidCell(r.inv.paid)),
        row('Amount', amt(r, r.inv.amount)),
        row('Created', fmtTime(r.inv.createdAt)),
        r.inv.expiresAt ? row('Expires', fmtTime(r.inv.expiresAt)) : null,
        !isOpenPayer(r.inv.payer) ? row('Payer', r.inv.payer) : null,
        row('Payments', r.payments.length
          ? h('div', {},
            r.paymentTotal > r.payments.length ? h('div', { class: 'muted' }, `latest ${r.payments.length} of ${r.paymentTotal} attempts`) : null,
            ...r.payments.map((p) => h('div', { class: 'payment' },
            `#${p.index} ${short(p.payer)} · ${fmtTime(p.paidAt)} · `, amt(r, p.received), ' ',
            val(p.accepted) === undefined ? lockedValue() : val(p.accepted) ? badge('accepted', 'ok') : badge('refunded', 'bad'))))
          : 'none yet'),
        row('Invoice id', h('code', {}, r.id)),
        h('div', { class: 'actions' },
          r.link ? h('button', { type: 'button', class: 'ghost small', onclick: async () => {
            status.ok((await copy(`${baseUrl()}#/pay?${encodeLink(r.link!)}`)) ? 'Link copied.' : 'Clipboard unavailable.');
          } }, 'Copy link') : h('span', { class: 'muted' }, 'link not saved in this browser'),
          action('Add viewer', addViewer, r),
          action('Publish paid status', publish, r),
          openState(r.inv, now()) === 'open' ? action('Cancel', cancel, r) : null,
          h('a', { class: 'button ghost small', href: `#/check?c=${session!.chainId}&id=${r.id}` }, 'Public check'),
        ),
      )),
    );
  };

  render(
    card(h('h2', {}, 'Merchant dashboard'),
      h('p', { class: 'hint' }, 'Your invoices are read from the chain. Amounts, payments and paid status are encrypted; you decrypt them locally after one wallet signature.'),
      h('div', { class: 'inline' }, network, h('button', { type: 'button', onclick: load }, 'Connect wallet')),
      status.el, body),
  );
}

// ================================================================== public paid check

export async function viewCheck(query: string) {
  const p = new URLSearchParams(query);
  const chainId = Number(p.get('c') ?? defaultChainId());
  const invoiceId = (p.get('id') ?? '') as Hex;
  const status = statusLine();
  const result = h('div', {});
  const idInput = h('input', { class: 'mono', placeholder: '0x… invoice id', value: invoiceId });
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    location.hash = `#/check?c=${chainId}&id=${idInput.value.trim()}`;
  } }, h('label', {}, 'Invoice id'), idInput, h('button', { type: 'submit' }, 'Check'));
  render(card(networkBanner(chainId), h('h2', {}, 'Is this invoice paid?'),
    h('p', { class: 'hint' }, 'Public check, no wallet needed. It can only show a result the merchant has published, and it never reveals an amount. "Paid" means some address sent exactly the invoiced amount of this token; check the payer yourself if who paid matters.'),
    form, status.el, result));
  if (!/^0x[0-9a-fA-F]{64}$/.test(invoiceId)) return;

  const run = async () => {
    try {
      const client = publicClientFor(chainId);
      const contract = payLinksOf(chainId);
      status.pending('Reading the invoice…');
      const inv = await readInvoice(client, contract, invoiceId);
      if (!inv) return status.error(new Error('No such invoice on this network and contract.'));
      const [confirmed, handle] = await Promise.all([
        client.readContract({ address: contract, abi: payLinksAbi, functionName: 'paidConfirmed', args: [invoiceId] }),
        client.readContract({ address: contract, abi: payLinksAbi, functionName: 'publishedPaidHandle', args: [invoiceId] }),
      ]);
      const tok = await tokenMeta(chainId, inv.token);
      const facts = [
        row('Merchant', inv.merchant),
        row('Token', extLink(explorerAddress(chainId, inv.token), tok.symbol)),
        row('Created', fmtTime(inv.createdAt)),
        row('State', stateBadge(inv)),
      ];
      if (confirmed) {
        status.clear();
        return result.replaceChildren(h('h3', {}, badge('PAID — proven on chain', 'ok')), ...facts,
          h('p', { class: 'hint' }, 'A KMS-signed decryption of the encrypted paid flag was verified by the contract (paidConfirmed = true). Paid status never goes back to unpaid.'));
      }
      if (/^0x0{64}$/.test(handle)) {
        status.clear();
        return result.replaceChildren(h('h3', {}, badge('no public status yet', 'lock')), ...facts,
          h('p', { class: 'hint' }, 'The merchant has not published a paid status for this invoice. Ask them to click "Publish paid status" in their dashboard.'));
      }
      const sdk = fheFor(chainId, client);
      const r = await withRetry(() => sdk.decryption.decryptPublicValues([handle]), {
        label: 'Asking the Zama network for the published status', attempts: 6, onProgress: (x) => status.pending(x.message),
      });
      // Do not trust the relayer's cleartext: check the KMS signatures against the contract before showing a result.
      status.pending('Verifying the KMS signatures against the contract…');
      const { result: verified } = await client.simulateContract({
        address: contract, abi: payLinksAbi, functionName: 'confirmPaidStatus',
        args: [invoiceId, r.abiEncodedClearValues as Hex, r.decryptionProof as Hex],
      });
      const paid = verified === true;
      if (paid !== (r.clearValues[handle] === true)) throw new Error('The relayer\'s answer does not match its signed proof.');
      status.clear();
      const record = h('button', { type: 'button', class: 'ghost', onclick: async () => {
        try {
          const s = await connect(chainId);
          await sendTx(s, { address: contract, abi: payLinksAbi, functionName: 'confirmPaidStatus', args: [invoiceId, r.abiEncodedClearValues as Hex, r.decryptionProof as Hex] }, status.pending);
          status.ok('Recorded on chain.');
          void run();
        } catch (e) {
          status.error(e);
        }
      } }, 'Record this proof on chain');
      result.replaceChildren(
        h('h3', {}, paid ? badge('PAID', 'ok') : badge('NOT PAID (at the time it was published)', 'open')), ...facts,
        h('p', { class: 'hint' }, 'Decrypted by the Zama KMS from the status the merchant published, and its signatures were checked by the contract. Only the yes/no flag was made public.'),
        ...(paid ? [record] : []),
      );
    } catch (e) {
      status.error(e, run);
    }
  };
  await run();
}

// ================================================================== auditor view

export async function viewAudit(query: string) {
  const p = new URLSearchParams(query);
  const chainId = Number(p.get('c'));
  const invoiceId = p.get('id') as Hex;
  const status = statusLine();
  const result = h('div', {});
  const go = async () => {
    try {
      const contract = payLinksOf(chainId);
      const s = await connect(chainId);
      const inv = await readInvoice(s.client, contract, invoiceId);
      if (!inv) throw new Error('No such invoice');
      const tok = await tokenMeta(chainId, inv.token);
      const v = await withRetry(() => sdkOf(s).decryption.decryptValues([
        { encryptedValue: inv.amount, contractAddress: contract },
        { encryptedValue: inv.paid, contractAddress: contract },
      ]), { label: 'Decrypting with your viewer access', attempts: 6, onProgress: (x) => status.pending(x.message) });
      status.ok(`Decrypted for ${s.account}.`);
      result.replaceChildren(
        row('Merchant', inv.merchant),
        row('Token', tok.symbol),
        row('Amount', `${formatAmount(v[inv.amount] as bigint, tok.decimals)} ${tok.symbol}`),
        row('Paid', v[inv.paid] ? badge('paid', 'ok') : badge('not paid', 'open')),
        row('Created', fmtTime(inv.createdAt)),
        row('Invoice id', h('code', {}, invoiceId)),
        h('p', { class: 'hint' }, 'You can see this one invoice because the merchant granted your address access. You cannot see their other invoices, their balance, or individual payment attempts.'),
      );
    } catch (e) {
      status.error(e, go);
    }
  };
  render(card(networkBanner(chainId), h('h2', {}, 'Auditor view'),
    h('p', { class: 'hint' }, 'For an address the merchant added as a viewer of this invoice.'),
    row('Invoice id', h('code', {}, invoiceId ?? '')),
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: go }, 'Connect wallet and decrypt')),
    status.el, result));
}

// ================================================================== privacy model

export function viewHow() {
  const li = (...c: Child[]) => h('li', {}, ...c);
  render(card(h('h2', {}, 'What is public, what is private'),
    h('h3', {}, 'Encrypted on chain (FHE)'),
    h('ul', {},
      li('The invoice amount. Decryptable by the merchant, a fixed payer, and viewers the merchant adds.'),
      li('Every amount sent, and whether each payment was accepted or refunded. Decryptable by the merchant and that payer.'),
      li('Whether the invoice is paid. Decryptable by the merchant and viewers; public only if the merchant publishes it. "Paid" means some address sent exactly the invoiced amount; it does not say who.'),
      li('Token balances (ERC-7984).')),
    h('h3', {}, 'Public'),
    h('ul', {},
      li('That an invoice exists: its id, the merchant address, the token (one of a fixed list set at deployment), the optional payer, the expiry, and a hash of the link details.'),
      li('Who sent a payment attempt to which invoice, and when (addresses are not hidden by FHE).'),
      li('Gas use, which is the same for an accepted and a refunded payment.')),
    h('h3', {}, 'Only in the link'),
    h('ul', {},
      li('The memo and, if the merchant chose, the amount. They sit after the # in the URL, so browsers never send them to a server, and a hash on chain detects edits. Anyone you share the link with can read them.')),
    h('h3', {}, 'Trust'),
    h('ul', {},
      li('No owner, no admin, no upgrade. The contract never keeps funds: exact payments are forwarded in the same transaction, everything else is refunded by the token.'),
      li('Decryption relies on the Zama Protocol (KMS threshold network, gateway and relayer). On testnet these can have outages; the app retries and your funds are unaffected.')),
  ));
}
