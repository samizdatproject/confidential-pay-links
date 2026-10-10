import { encodeAbiParameters, formatUnits, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem';

/**
 * A confidential payment link. Only `chainId` and `invoiceId` identify the invoice; the rest are off-chain
 * details for the payer, protected by a commitment (`detailsHash`) stored in the invoice on chain.
 * The amount hint is optional: without it, the payer must be able to decrypt the amount (fixed payer or viewer).
 */
export type PayLink = {
  chainId: number;
  invoiceId: Hex;
  /** Random 32 bytes; makes the commitment unguessable even for short memos. */
  salt: Hex;
  memo: string;
  /** Amount in token base units, or undefined when the merchant left it out of the link. */
  amount?: bigint;
};

export const MAX_MEMO_BYTES = 140;
export const MAX_UINT64 = 2n ** 64n - 1n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** Same formula as ConfidentialPayLinks.invoiceIdOf: binds an invoice to its chain, its contract and its merchant. */
export function invoiceIdOf(chainId: number, contract: Address, merchant: Address, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(chainId), contract, merchant, nonce],
    ),
  );
}

/** Commitment to the off-chain link details. An absent amount hint is committed as 0 (zero invoices are unpayable). */
export function detailsHashOf(d: Pick<PayLink, 'salt' | 'memo' | 'amount'>): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }, { type: 'uint256' }], [d.salt, d.memo, d.amount ?? 0n]),
  );
}

/**
 * Characters that can make a memo display differently from what it says: C0/C1 controls (incl. NEL), soft hyphen,
 * combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent vowels, Mongolian free variation
 * selectors and vowel separator, zero-width and bidi marks/overrides/isolates, line/paragraph separators, word joiner,
 * invisible operators and deprecated format controls, Braille blank, variation selectors (incl. supplement),
 * BOM, interlinear annotation controls, musical-symbol format controls, and Unicode tag characters.
 */
export const HIDDEN_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Amount must be a number like 12.50');
  const frac = s.split('.')[1]?.length ?? 0;
  if (frac > decimals) throw new Error(`Use at most ${decimals} decimals`);
  const v = parseUnits(s, decimals);
  if (v === 0n) throw new Error('Amount must be greater than zero');
  if (v > MAX_UINT64) throw new Error('Amount is too large for a confidential token (uint64)');
  return v;
}

export function formatAmount(v: bigint, decimals: number): string {
  return formatUnits(v, decimals);
}

export function validateLink(l: PayLink): PayLink {
  if (!Number.isSafeInteger(l.chainId) || l.chainId <= 0) throw new Error('Bad chain id');
  if (!BYTES32.test(l.invoiceId)) throw new Error('Bad invoice id');
  if (!BYTES32.test(l.salt)) throw new Error('Bad salt');
  if (HIDDEN_CHARS.test(l.memo)) throw new Error('Memo contains invisible or direction-changing characters');
  if (new TextEncoder().encode(l.memo).length > MAX_MEMO_BYTES) throw new Error(`Memo is longer than ${MAX_MEMO_BYTES} bytes`);
  if (l.amount !== undefined && (l.amount <= 0n || l.amount > MAX_UINT64)) throw new Error('Bad amount');
  return { ...l, invoiceId: l.invoiceId.toLowerCase() as Hex, salt: l.salt.toLowerCase() as Hex };
}

/** Query string for a link (no leading '?'). The amount is written in base units so decimals never matter. */
export function encodeLink(l: PayLink): string {
  const v = validateLink(l);
  const p = new URLSearchParams({ c: String(v.chainId), id: v.invoiceId, s: v.salt });
  if (v.memo) p.set('m', v.memo);
  if (v.amount !== undefined) p.set('a', v.amount.toString());
  return p.toString();
}

export function decodeLink(query: string): PayLink {
  const p = new URLSearchParams(query);
  const need = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') throw new Error(`Link is missing "${k}"`);
    return v;
  };
  const a = p.get('a');
  if (a !== null && !/^\d{1,20}$/.test(a)) throw new Error('Bad amount');
  return validateLink({
    chainId: Number(need('c')),
    invoiceId: need('id') as Hex,
    salt: need('s') as Hex,
    memo: p.get('m') ?? '',
    amount: a === null ? undefined : BigInt(a),
  });
}

/** Where a link's details stand against the commitment stored on chain. */
export type DetailsCheck = 'verified' | 'modified';

export function checkDetails(l: PayLink, onChainHash: Hex): DetailsCheck {
  return detailsHashOf(l).toLowerCase() === onChainHash.toLowerCase() ? 'verified' : 'modified';
}
