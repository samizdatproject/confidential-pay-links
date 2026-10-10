import type { Hex } from 'viem';
import { decodeLink, type PayLink } from './link';

// Links created in this browser. The memo and salt exist only in the link, so this list is the merchant's copy.
// Kept in localStorage only; nothing is sent anywhere.
const KEY = 'confidential-pay-links:v1:links';

export function savedLinkQueries(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveLinkQuery(q: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([q, ...savedLinkQueries().filter((x) => x !== q)].slice(0, 500)));
  } catch {
    // storage unavailable: the link still works, it just is not remembered here
  }
}

/** Saved link for an invoice id, if this browser created it. */
export function savedLinkFor(chainId: number, invoiceId: Hex): PayLink | undefined {
  for (const q of savedLinkQueries()) {
    try {
      const l = decodeLink(q);
      if (l.chainId === chainId && l.invoiceId.toLowerCase() === invoiceId.toLowerCase()) return l;
    } catch {
      // ignore malformed entries
    }
  }
  return undefined;
}
