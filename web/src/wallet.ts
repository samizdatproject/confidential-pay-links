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

/** Forget the chosen wallet; the next connection asks again. */
export function switchWallet() {
  selected = undefined;
  saveRdns(null);
  showConnected(undefined);
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
  el.append(document.createTextNode(`${info.name} · ${info.account.slice(0, 6)}…${info.account.slice(-4)} · `));
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = 'switch wallet';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    switchWallet();
  });
  el.append(a);
}

/** Connects the chosen injected wallet (EIP-6963, else window.ethereum) and makes sure it is on `chain`. */
export async function connectWallet(chain: Chain): Promise<{ wallet: WalletClient; account: Address }> {
  const sel = await selectProvider();
  const provider = sel.provider;
  const probe = createWalletClient({ chain, transport: custom(provider) });
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
  // The Zama SDK signs decryption permits with the wallet client's account, so bind it.
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  showConnected({ name: sel.name, icon: sel.icon, account });
  return { wallet, account };
}
