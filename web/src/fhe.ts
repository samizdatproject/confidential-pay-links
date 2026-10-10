import {
  cleartext,
  createConfig,
  isRetryable,
  matchZamaError,
  retryAfterSeconds,
  ZamaError,
  ZamaSDK,
} from '@zama-fhe/sdk';
import { hardhat, sepolia as zamaSepolia, type FheChain } from '@zama-fhe/sdk/chains';
import { ViemProvider, ViemSigner } from '@zama-fhe/sdk/viem';
import { web } from '@zama-fhe/sdk/web';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { networkOf } from './chains';

/** Relayer requests give up after this long (the SDK default is one hour), so the UI can offer a retry instead. */
const RELAYER_TIMEOUT_MS = 90_000;

/**
 * One SDK per (chain, wallet). The SDK holds the user's transport key pair and decryption permits, so a new
 * wallet account always gets a fresh instance. Without a wallet the SDK can still do public decryption.
 */
const cache = new Map<string, ZamaSDK>();

export function fheFor(chainId: number, publicClient: PublicClient, walletClient?: WalletClient): ZamaSDK {
  const key = `${chainId}:${walletClient?.account?.address ?? '-'}`;
  let sdk = cache.get(key);
  if (sdk) return sdk;
  const net = networkOf(chainId);
  const chain: FheChain =
    net.relayer === 'local' ? { ...hardhat, network: net.rpc } : { ...zamaSepolia, network: net.rpc };
  const relayer = net.relayer === 'local' ? cleartext({ timeout: RELAYER_TIMEOUT_MS }) : web({ timeout: RELAYER_TIMEOUT_MS });
  sdk = new ZamaSDK(
    createConfig({
      chains: [chain],
      provider: new ViemProvider({ publicClient }),
      // No signer = read-only SDK: public decryption works, user decryption and encryption need a wallet.
      signer: walletClient ? new ViemSigner({ walletClient }) : undefined,
      relayers: { [chain.id]: relayer },
      // Pages served without COOP/COEP (e.g. GitHub Pages) cannot use SharedArrayBuffer; the SDK falls back to a
      // single thread on its own, this just avoids the warning when we already know.
      runtime: globalThis.crossOriginIsolated ? {} : { singleThread: true },
    }),
  );
  cache.set(key, sdk);
  return sdk;
}

export async function encryptU64(sdk: ZamaSDK, value: bigint, contractAddress: Address, userAddress: Address) {
  const { encryptedValues, inputProof } = await sdk.encrypt({
    values: [{ value, type: 'euint64' }],
    contractAddress,
    userAddress,
  });
  const handle = encryptedValues[0];
  if (!handle) throw new Error('Encryption returned no value');
  return { handle: handle as Hex, inputProof: inputProof as Hex };
}

// ---------------------------------------------------------------- outages, retries, pending states

/** What the UI shows while an FHE step runs or waits for a retry. */
export type Progress = (state: { attempt: number; waitingSeconds?: number; message: string }) => void;

/** True for failures worth retrying: SDK errors marked retryable, relayer 5xx/timeouts, and plain network errors. */
export function isTransient(e: unknown): boolean {
  if (isRetryable(e)) return true;
  if (e instanceof ZamaError) {
    const status = (e as { statusCode?: number }).statusCode;
    if (e.code === 'RELAYER_REQUEST_FAILED') return status === undefined || status >= 500 || status === 408 || status === 429;
    // A decryption can fail while the gateway or KMS is degraded (Sepolia outages happen); it is safe to retry.
    return e.code === 'DECRYPTION_FAILED' || e.code === 'DELEGATION_NOT_PROPAGATED';
  }
  const msg = String((e as Error)?.message ?? e);
  return /failed to fetch|networkerror|network request failed|timed? ?out|ECONNRESET|503|502|504/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an FHE relayer operation with bounded exponential backoff on transient failures. Terminal failures (user
 * rejected the signature, not entitled to decrypt, ...) are thrown immediately.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label: string; onProgress?: Progress },
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 3_000;
  for (let attempt = 1; ; attempt++) {
    opts.onProgress?.({ attempt, message: attempt === 1 ? `${opts.label}…` : `${opts.label} (attempt ${attempt} of ${attempts})…` });
    try {
      return await op();
    } catch (e) {
      if (attempt >= attempts || !isTransient(e)) throw e;
      const hinted = retryAfterSeconds(e);
      const waitMs = Math.min(60_000, hinted !== undefined ? hinted * 1000 : base * 2 ** (attempt - 1));
      opts.onProgress?.({
        attempt,
        waitingSeconds: Math.round(waitMs / 1000),
        message: `The Zama relayer did not answer (${shortError(e)}). Retrying in ${Math.round(waitMs / 1000)} s…`,
      });
      await sleep(waitMs);
    }
  }
}

/** Human message for an FHE/SDK error. */
export function fheErrorText(e: unknown): string {
  const routed = matchZamaError(e, {
    SIGNING_REJECTED: () => 'You declined the signature in your wallet.',
    NOT_ENTITLED: () => 'This wallet is not allowed to decrypt this value.',
    RELAYER_REQUEST_FAILED: (err) =>
      `The Zama relayer is unavailable right now (HTTP ${(err as { statusCode?: number }).statusCode ?? '?'}). Nothing was lost; try again in a few minutes.`,
    DECRYPTION_FAILED: () => 'Decryption failed on the Zama network. This is usually a temporary testnet outage; try again later.',
    ENCRYPTION_FAILED: () => 'Encryption failed in the browser. Reload the page and try again.',
    KEYPAIR_EXPIRED: () => 'Your decryption permit expired. Decrypt again to sign a new one.',
    _: (err) => (err as Error).message,
  });
  return routed ?? shortError(e);
}

function shortError(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}
