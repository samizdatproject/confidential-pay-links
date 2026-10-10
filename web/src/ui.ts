import { BaseError } from 'viem';
import { fheErrorText } from './fhe';
import { ZamaError } from '@zama-fhe/sdk';

// Tiny DOM helpers. Everything goes through textContent/attributes, so link data can never inject HTML.
export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const app = () => document.getElementById('app')!;

export function render(...nodes: Child[]) {
  app().replaceChildren(...(nodes.filter(Boolean) as (Node | string)[]));
}

export function errText(e: unknown): string {
  if (e instanceof ZamaError) return fheErrorText(e);
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message : String(e);
}

export function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function extLink(href: string | undefined, text: string) {
  return href ? h('a', { href, target: '_blank', rel: 'noopener' }, text) : h('span', {}, text);
}

export function row(label: string, value: Child) {
  return h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value));
}

export function badge(text: string, kind: 'ok' | 'open' | 'bad' | 'lock' | '' = '') {
  return h('span', { class: `badge ${kind}`.trim() }, text);
}

export function card(...children: Child[]) {
  return h('section', { class: 'card' }, ...children);
}

export function fmtTime(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** A status line that can show progress, an error with a Retry button, or a success message. */
export function statusLine() {
  const el = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  return {
    el,
    info(msg: string) {
      el.className = 'status';
      el.replaceChildren(msg);
    },
    pending(msg: string) {
      el.className = 'status pending';
      el.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), msg);
    },
    ok(msg: string) {
      el.className = 'status good';
      el.replaceChildren(msg);
    },
    error(e: unknown, retry?: () => void) {
      el.className = 'status error';
      el.replaceChildren(errText(e));
      const url = (e as { explorerUrl?: string } | null)?.explorerUrl;
      if (url) el.append(' ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'View in explorer'));
      if (retry) el.append(' ', h('button', { type: 'button', class: 'ghost small', onclick: retry }, 'Retry'));
    },
    clear() {
      el.className = 'status';
      el.replaceChildren();
    },
  };
}

export function testBanner(name: string) {
  return h('div', { class: 'testnet-banner', role: 'note' }, `${name} — test tokens only, no real money`);
}

export async function copy(text: string, fallback?: HTMLInputElement) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    fallback?.select();
    return false;
  }
}
