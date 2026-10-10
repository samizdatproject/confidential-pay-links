import { decodeEventLog, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { payLinksAbi } from './abi.generated';

export { payLinksAbi };

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

export type Payment = { payer: Address; paidAt: number; received: Hex; accepted: Hex };

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

export async function readPayments(client: PublicClient, payLinks: Address, invoiceId: Hex): Promise<Payment[]> {
  const ps = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'getPayments', args: [invoiceId] });
  return ps.map((p) => ({ payer: p.payer, paidAt: Number(p.paidAt), received: p.received, accepted: p.accepted }));
}

export async function readMerchantInvoiceIds(client: PublicClient, payLinks: Address, merchant: Address): Promise<Hex[]> {
  const n = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'invoiceCountOf', args: [merchant] });
  const ids: Hex[] = [];
  for (let off = 0n; off < n; off += 100n) {
    ids.push(
      ...(await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'invoicesOf', args: [merchant, off, 100n] })),
    );
  }
  return ids;
}

export async function readPayerPayments(client: PublicClient, payLinks: Address, payer: Address) {
  const refs = await client.readContract({ address: payLinks, abi: payLinksAbi, functionName: 'paymentsBy', args: [payer] });
  return refs.map((r) => ({ invoiceId: r.invoiceId, index: Number(r.index) }));
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
