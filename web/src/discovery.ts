import type { EIP1193Provider } from 'viem';

/**
 * EIP-6963 multi-injected-provider discovery. Several wallets (MetaMask, Phantom, Rabby, ...) fight over
 * `window.ethereum`; with EIP-6963 each announces itself and the user picks one. `window.ethereum` is only used when
 * no wallet announces.
 */
export type ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Announced = { info: ProviderInfo; provider: EIP1193Provider };

const STORE = 'confidential-pay-links:v1:wallet-rdns';
const announced = new Map<string, Announced>();
let started = false;

function isValidInfo(i: unknown): i is ProviderInfo {
  const o = i as Record<string, unknown> | null;
  return !!o && typeof o.uuid === 'string' && typeof o.name === 'string' && typeof o.rdns === 'string' && typeof o.icon === 'string';
}

/** Starts listening and asks wallets to announce themselves. Safe to call many times. */
export function startDiscovery(target: Window = window) {
  if (!started) {
    started = true;
    target.addEventListener('eip6963:announceProvider', (ev: Event) => {
      const d = (ev as CustomEvent).detail as { info?: unknown; provider?: EIP1193Provider } | undefined;
      if (!d || !isValidInfo(d.info) || typeof d.provider?.request !== 'function') return;
      announced.set(d.info.uuid, { info: d.info, provider: d.provider });
    });
  }
  target.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** Announced wallets, after giving them a moment to answer the request. */
export async function discoverProviders(waitMs = 300, target: Window = window): Promise<Announced[]> {
  startDiscovery(target);
  if (!announced.size) await new Promise((r) => setTimeout(r, waitMs));
  return [...announced.values()];
}

/** Only image data URIs are shown as wallet icons (no remote fetches, nothing scriptable such as SVG with script is
 *  injected as markup: the value only ever goes into an <img src>). */
export function safeIcon(icon: string): string | undefined {
  return /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(icon) ? icon : undefined;
}

export type Choice<T> = { kind: 'use'; provider: T } | { kind: 'ask'; options: T[] } | { kind: 'fallback' };

/** Pure choice logic: remembered wallet if still present, the only wallet if there is one, otherwise ask. */
export function choose<T extends { info: { rdns: string } }>(options: T[], savedRdns: string | null): Choice<T> {
  if (!options.length) return { kind: 'fallback' };
  const saved = savedRdns ? options.find((o) => o.info.rdns === savedRdns) : undefined;
  if (saved) return { kind: 'use', provider: saved };
  if (options.length === 1) return { kind: 'use', provider: options[0]! };
  return { kind: 'ask', options };
}

export function savedRdns(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

export function saveRdns(rdns: string | null) {
  try {
    if (rdns) localStorage.setItem(STORE, rdns);
    else localStorage.removeItem(STORE);
  } catch {
    // storage unavailable: the user is asked again next time
  }
}

/** Test hook: forget announcements (unit tests only). */
export function _resetDiscovery() {
  announced.clear();
  started = false;
}
