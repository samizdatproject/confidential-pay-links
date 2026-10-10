import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { networkOf } from './chains';
import { chainIdFrom, firstAccount, sameAccount } from './account';
import { choose, discoverProviders, safeIcon, saveRdns, savedRdns, type Announced } from './discovery';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const publicClients = new Map<number, PublicClient>();

export function publicClientFor(chainId: number): PublicClient {
  let c = publicClients.get(chainId);
  if (!c) {
    const net = networkOf(chainId);
    c = createPublicClient({ chain: net.chain, transport: http(net.rpc) }) as PublicClient;
    publicClients.set(chainId, c);
  }
  return c;
}

type Selected = { name: string; icon?: string; rdns?: string; provider: EIP1193Provider };
let selected: Selected | undefined;

/** Lets the user pick one of several announced wallets. Built with DOM APIs only (names/icons come from wallets). */
function pickWallet(options: Announced[]): Promise<Announced> {
  return new Promise((resolve, reject) => {
    const close = (fn: () => void) => {
      dialog.remove();
      fn();
    };
    const dialog = document.createElement('div');
    dialog.className = 'wallet-picker';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Choose a wallet');
    const box = document.createElement('div');
    box.className = 'card';
    const title = document.createElement('h2');
    title.textContent = 'Choose a wallet';
    box.append(title);
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost wallet-option';
      const icon = safeIcon(o.info.icon);
      if (icon) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        img.width = 24;
        img.height = 24;
        b.append(img);
      }
      b.append(document.createTextNode(o.info.name.slice(0, 40)));
      b.addEventListener('click', () => close(() => resolve(o)));
      box.append(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost small';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(() => reject(new Error('No wallet chosen'))));
    box.append(cancel);
    dialog.append(box);
    document.body.append(dialog);
    (box.querySelector('button') as HTMLButtonElement | null)?.focus();
  });
}

let pending: Promise<Selected> | undefined;

/** One selection at a time: concurrent connects share the same picker. */
function selectProvider(): Promise<Selected> {
  if (selected) return Promise.resolve(selected);
  pending ??= resolveProvider().finally(() => (pending = undefined));
  return pending;
}

async function resolveProvider(): Promise<Selected> {
  const c = choose(await discoverProviders(), savedRdns());
  if (c.kind === 'fallback') {
    if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby, then reload.');
    selected = { name: 'Browser wallet', provider: window.ethereum };
  } else {
    const a = c.kind === 'use' ? c.provider : await pickWallet(c.options);
    saveRdns(a.info.rdns);
    selected = { name: a.info.name, icon: safeIcon(a.info.icon), rdns: a.info.rdns, provider: a.provider };
  }
  return selected;
}

// ---------------------------------------------------------------- account state

/** Fired on window whenever the wallet's account or chain changes, or the user switches wallet/account. */
export const WALLET_CHANGED = 'cpl:wallet-changed';

type Listener = (...args: unknown[]) => void;
type Evented = EIP1193Provider & { on?: (e: string, l: Listener) => void; removeListener?: (e: string, l: Listener) => void };

let current: { account?: Address; chainId?: number } = {};
let unsubscribe: (() => void) | undefined;

function changed() {
  window.dispatchEvent(new Event(WALLET_CHANGED));
}

/** Follow the wallet's account and chain, so a switch in MetaMask never leaves the app signing as the old account. */
function follow(sel: Selected) {
  unsubscribe?.();
  const p = sel.provider as Evented;
  const onAccounts: Listener = (accs) => {
    const a = firstAccount(accs);
    if (a ? sameAccount(a, current.account) : !current.account) return;
    current = { ...current, account: a };
    showConnected(a ? { name: sel.name, icon: sel.icon, account: a } : undefined);
    changed();
  };
  const onChain: Listener = (id) => {
    current = { ...current, chainId: chainIdFrom(id) };
    changed();
  };
  p.on?.('accountsChanged', onAccounts);
  p.on?.('chainChanged', onChain);
  unsubscribe = () => {
    p.removeListener?.('accountsChanged', onAccounts);
    p.removeListener?.('chainChanged', onChain);
  };
}

/** The account the selected wallet exposes right now (no prompt), or undefined. */
export async function currentAccount(): Promise<Address | undefined> {
  if (!selected) return undefined;
  return firstAccount(await selected.provider.request({ method: 'eth_accounts' }));
}

/** Forget the chosen wallet; the next connection asks again. */
export function switchWallet() {
  unsubscribe?.();
  unsubscribe = undefined;
  selected = undefined;
  current = {};
  saveRdns(null);
  showConnected(undefined);
  changed();
}

/** Ask the wallet to choose (or connect) another account: MetaMask shows its account chooser. */
export async function switchAccount() {
  const sel = await selectProvider();
  await sel.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] } as never);
  const a = firstAccount(await sel.provider.request({ method: 'eth_requestAccounts' }));
  current = { ...current, account: a };
  showConnected(a ? { name: sel.name, icon: sel.icon, account: a } : undefined);
  changed();
}

function link(text: string, onClick: () => void) {
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = text;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return a;
}

function showConnected(info: { name: string; icon?: string; account: Address } | undefined) {
  const el = document.getElementById('wallet-status');
  if (!el) return;
  el.replaceChildren();
  if (!info) return;
  if (info.icon) {
    const img = document.createElement('img');
    img.src = info.icon;
    img.alt = '';
    img.width = 16;
    img.height = 16;
    el.append(img);
  }
  el.append(document.createTextNode(`${info.name} · `));
  const addr = document.createElement('code');
  addr.className = 'active-account';
  addr.title = info.account;
  addr.textContent = `${info.account.slice(0, 6)}…${info.account.slice(-4)}`;
  el.append(addr, ' · ', link('switch account', () => void switchAccount().catch(() => undefined)), ' · ', link('switch wallet', switchWallet));
}

/** On page load: if the remembered (or only) wallet is already connected to this site, follow it and show the
 *  account, without any prompt. */
export async function restoreWallet() {
  if (selected) return;
  const c = choose(await discoverProviders(), savedRdns());
  let sel: Selected | undefined;
  if (c.kind === 'use') sel = { name: c.provider.info.name, icon: safeIcon(c.provider.info.icon), rdns: c.provider.info.rdns, provider: c.provider.provider };
  else if (c.kind === 'fallback' && window.ethereum) sel = { name: 'Browser wallet', provider: window.ethereum };
  if (!sel) return;
  const a = firstAccount(await sel.provider.request({ method: 'eth_accounts' }).catch(() => []));
  if (!a || selected) return;
  selected = sel;
  current = { account: a };
  follow(sel);
  showConnected({ name: sel.name, icon: sel.icon, account: a });
}

/** Connects the chosen injected wallet (EIP-6963, else window.ethereum) and makes sure it is on `chain`. */
export async function connectWallet(chain: Chain): Promise<{ wallet: WalletClient; account: Address }> {
  const sel = await selectProvider();
  if (!unsubscribe) follow(sel);
  const provider = sel.provider;
  const probe = createWalletClient({ chain, transport: custom(provider) });
  // Always ask the wallet: the active account may have changed since the last action.
  const [account] = await probe.requestAddresses();
  if (!account) throw new Error('The wallet did not share an account');
  if ((await probe.getChainId()) !== chain.id) {
    try {
      await probe.switchChain({ id: chain.id });
    } catch (e) {
      // 4902: the wallet does not know this chain yet.
      if ((e as { code?: number }).code === 4902 || /unrecognized|not added|4902/i.test(String(e))) {
        await probe.addChain({ chain });
      } else {
        throw e;
      }
    }
  }
  // A fresh client bound to this account each time; the Zama SDK signs decryption permits with it.
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  current = { account, chainId: chain.id };
  showConnected({ name: sel.name, icon: sel.icon, account });
  return { wallet, account };
}
