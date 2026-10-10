import { defineChain, type Address, type Chain } from 'viem';
import { sepolia as viemSepolia } from 'viem/chains';

/** A confidential (ERC-7984) token the app offers, plus the public ERC-20 it wraps when there is one. */
export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  /** Underlying ERC-20 with a public `mint(address,uint256)` (test tokens only), for the "get test tokens" button. */
  mintableUnderlying?: Address;
};

export type Network = {
  chain: Chain;
  /** ConfidentialPayLinks deployment on this chain, if any. */
  payLinks?: Address;
  /** PayLinksReader (stateless paging helper) on this chain. */
  reader?: Address;
  tokens: TokenInfo[];
  /** 'sepolia' uses Zama's hosted testnet relayer; 'local' uses the SDK's cleartext relayer against anvil. */
  relayer: 'sepolia' | 'local';
  rpc: string;
};

// Zama's public Sepolia RPC default (the same one the SDK's chain preset uses).
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export const sepolia: Network = {
  chain: defineChain({ ...viemSepolia, rpcUrls: { default: { http: [SEPOLIA_RPC] } } }),
  // Deployed 2026-10-10 with scripts/deploy-sepolia.sh (accepted tokens: cUSDCMock, cUSDTMock). A build can override
  // them with VITE_SEPOLIA_PAYLINKS / VITE_SEPOLIA_READER. Redeploying invalidates every outstanding link.
  payLinks: (import.meta.env.VITE_SEPOLIA_PAYLINKS as Address | undefined) || '0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d',
  reader: (import.meta.env.VITE_SEPOLIA_READER as Address | undefined) || '0x2d7003f996491F965C3Fb32355Cc42150FE5f94D',
  // https://docs.zama.org/protocol/protocol-apps/addresses/testnet/sepolia (mock wrappers with public mint)
  tokens: [
    {
      address: '0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639',
      symbol: 'cUSDCMock',
      decimals: 6,
      mintableUnderlying: '0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF',
    },
    {
      address: '0x4E7B06D78965594eB5EF5414c357ca21E1554491',
      symbol: 'cUSDTMock',
      decimals: 6,
      mintableUnderlying: '0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0',
    },
  ],
  relayer: 'sepolia',
  rpc: SEPOLIA_RPC,
};

export const networks: Record<number, Network> = { [sepolia.chain.id]: sepolia };

/**
 * A local anvil chain (cleartext FHEVM, see scripts/local-chain.sh) is only built in when its contract addresses
 * are supplied at build time. These are literal `import.meta.env.*` reads so production bundles drop it entirely.
 */
if (import.meta.env.VITE_LOCAL_PAYLINKS) {
  networks[31337] = {
    chain: defineChain({
      id: 31337,
      name: 'Local (anvil, cleartext FHE)',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
      testnet: true,
    }),
    payLinks: import.meta.env.VITE_LOCAL_PAYLINKS as Address,
    reader: import.meta.env.VITE_LOCAL_READER as Address,
    tokens: [
      {
        address: import.meta.env.VITE_LOCAL_TOKEN as Address,
        symbol: 'cmUSD',
        decimals: 6,
        mintableUnderlying: import.meta.env.VITE_LOCAL_UNDERLYING as Address,
      },
    ],
    relayer: 'local',
    rpc: 'http://127.0.0.1:8545',
  };
}

export function networkOf(chainId: number): Network {
  const n = networks[chainId];
  if (!n) throw new Error(`Unsupported network (chain ${chainId})`);
  return n;
}

export function payLinksOf(chainId: number): Address {
  const a = networkOf(chainId).payLinks;
  if (!a) throw new Error(`ConfidentialPayLinks is not deployed on ${networkOf(chainId).chain.name} yet.`);
  return a;
}

export function readerOf(chainId: number): Address {
  const a = networkOf(chainId).reader;
  if (!a) throw new Error(`PayLinksReader is not deployed on ${networkOf(chainId).chain.name} yet.`);
  return a;
}

export function defaultChainId(): number {
  if (networks[31337]) return 31337;
  return sepolia.chain.id;
}

/** Known token metadata, or undefined for a token this app does not list. */
export function tokenInfo(chainId: number, token: Address): TokenInfo | undefined {
  return networks[chainId]?.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase());
}

export function explorerTx(chainId: number, hash: string): string | undefined {
  const base = networks[chainId]?.chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : undefined;
}

export function explorerAddress(chainId: number, addr: string): string | undefined {
  const base = networks[chainId]?.chain.blockExplorers?.default.url;
  return base ? `${base}/address/${addr}` : undefined;
}
