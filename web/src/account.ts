import { isAddress, type Address } from 'viem';

/** First account in an `accountsChanged` / `eth_accounts` payload, or undefined (disconnected or malformed). */
export function firstAccount(accs: unknown): Address | undefined {
  const a = Array.isArray(accs) ? accs[0] : undefined;
  return typeof a === 'string' && isAddress(a, { strict: false }) ? (a as Address) : undefined;
}

/** Chain id from a `chainChanged` payload (hex string), or undefined. */
export function chainIdFrom(id: unknown): number | undefined {
  if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id)) return undefined;
  return Number.parseInt(id, 16);
}

export function sameAccount(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
