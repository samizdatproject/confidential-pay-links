import { decodeEventLog, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { payLinksAbi, payLinksReaderAbi } from './abi.generated';

export { payLinksAbi, payLinksReaderAbi };

/** The ERC-7984 calls this app uses (OpenZeppelin confidential-contracts v0.5). */
export const erc7984Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function confidentialTransferAndCall(address to, bytes32 encryptedAmount, bytes inputProof, bytes data) returns (bytes32)',
  // Test-token faucet path: ERC-20 underlying -> confidential wrapper.
  'function underlying() view returns (address)',
  'function wrap(address to, uint256 amount) returns (bytes32)',
]);

export const mintableErc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export type Invoice = {
  merchant: Address;
  createdAt: number;
  expiresAt: number;
  token: Address;
  cancelled: boolean;
  payer: Address;
  detailsHash: Hex;
  amount: Hex; // encrypted handle
  paid: Hex; // encrypted handle
};

export type Payment = { index: number; payer: Address; paidAt: number; received: Hex; accepted: Hex };

const ZERO = '0x0000000000000000000000000000000000000000';

export const isOpenPayer = (a: Address) => a.toLowerCase() === ZERO;

export async function readInvoice(client: PublicClient, payLinks: Address, invoiceId: Hex): Promise<Invoice | null> {
  const r = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'getInvoice', args: [invoiceId] });
  if (r.merchant.toLowerCase() === ZERO) return null;
  return {
    merchant: r.merchant,
    createdAt: Number(r.createdAt),
    expiresAt: Number(r.expiresAt),
    token: r.token,
    cancelled: r.cancelled,
    payer: r.payer,
    detailsHash: r.detailsHash,
    amount: r.amount,
    paid: r.paid,
  };
}

export async function readPayment(client: PublicClient, payLinks: Address, invoiceId: Hex, index: number): Promise<Payment> {
  const p = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'getPayment', args: [invoiceId, BigInt(index)] });
  return { index, payer: p.payer, paidAt: Number(p.paidAt), received: p.received, accepted: p.accepted };
}

/** The latest `limit` payment attempts of an invoice (attempts are public and can be spammed, so never read all). */
export async function readRecentPayments(client: PublicClient, payLinks: Address, reader: Address, invoiceId: Hex, limit = 20) {
  const total = Number(await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'paymentCount', args: [invoiceId] }));
  const offset = Math.max(0, total - limit);
  const ps = await client.readContract({
    address: reader, abi: payLinksReaderAbi, functionName: 'getPayments', args: [payLinks, invoiceId, BigInt(offset), BigInt(limit)],
  });
  const items: Payment[] = ps.map((p, i) => ({ index: offset + i, payer: p.payer, paidAt: Number(p.paidAt), received: p.received, accepted: p.accepted }));
  return { total, items };
}

export async function readMerchantInvoiceIds(client: PublicClient, payLinks: Address, reader: Address, merchant: Address): Promise<Hex[]> {
  const n = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'invoiceCountOf', args: [merchant] });
  const ids: Hex[] = [];
  for (let off = 0n; off < n; off += 100n) {
    ids.push(
      ...(await client.readContract({ address: reader, abi: payLinksReaderAbi, functionName: 'invoicesOf', args: [payLinks, merchant, off, 100n] })),
    );
  }
  return ids;
}

/** The payer's latest `limit` payments, newest first. */
export async function readPayerPayments(client: PublicClient, payLinks: Address, reader: Address, payer: Address, limit = 50) {
  const total = Number(await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'paymentCountBy', args: [payer] }));
  const offset = Math.max(0, total - limit);
  const refs = await client.readContract({ address: reader, abi: payLinksReaderAbi, functionName: 'paymentsBy', args: [payLinks, payer, BigInt(offset), BigInt(limit)] });
  return refs.map((r) => ({ invoiceId: r.invoiceId, index: Number(r.index) })).reverse();
}

/** The PaymentReceived event of `payLinks` in a transaction receipt, if the payment reached it. */
export function paymentFromReceipt(receipt: TransactionReceipt, payLinks: Address) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== payLinks.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: payLinksAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'PaymentReceived') {
        return { invoiceId: ev.args.invoiceId, payer: ev.args.payer, index: Number(ev.args.index) };
      }
    } catch {
      // not one of ours
    }
  }
  return null;
}

/** Public, non-encrypted status of an invoice. Whether it is *paid* is encrypted and not part of this. */
export type OpenState = 'open' | 'cancelled' | 'expired';

export function openState(inv: Invoice, nowSeconds: number): OpenState {
  if (inv.cancelled) return 'cancelled';
  if (inv.expiresAt !== 0 && nowSeconds > inv.expiresAt) return 'expired';
  return 'open';
}
