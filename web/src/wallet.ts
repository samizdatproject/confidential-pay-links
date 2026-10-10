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

/** Connects the injected wallet (MetaMask, Rabby, ...) and makes sure it is on `chain`. */
export async function connectWallet(chain: Chain): Promise<{ wallet: WalletClient; account: Address }> {
  const provider = window.ethereum;
  if (!provider) throw new Error('No browser wallet found. Install MetaMask or Rabby, then reload.');
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
  return { wallet, account };
}
