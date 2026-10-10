/**
 * Explicit gas limits for every write. Wallets estimate on their own, but FHE calls on Sepolia cost far more than a
 * plain eth_estimateGas through a smart-account wrapper suggests (a real createInvoice from an EIP-7702 MetaMask
 * account ran out of gas at 1.83M). So the app estimates from the connected account and sends
 * max(estimate x 1.5, floor), capped below the 16,777,216 per-transaction limit (EIP-7825).
 *
 * Floors: gas measured on Sepolia in the live run (e2e-results/sepolia-live.json) x ~1.25, plus ~300k for
 * smart-account / delegation wrappers.
 */
export const TX_GAS_CAP = 16_777_216n;

export const GAS_FLOORS: Record<string, bigint> = {
  createInvoice: 2_800_000n, // measured 1.41M-1.50M open invoice; a fixed payer also adds a viewer (+~0.6M)
  confidentialTransferAndCall: 6_500_000n, // pay: measured 4.81M first payment to a merchant, 4.50M later
  mint: 300_000n, // measured 141k
  approve: 300_000n, // measured 128k
  wrap: 1_500_000n, // measured 916k
  addViewer: 1_100_000n, // measured 603k
  cancelInvoice: 300_000n, // storage write + event
  publishPaidStatus: 700_000n, // measured 264k
  confirmPaidStatus: 900_000n, // measured 466k
};
const DEFAULT_FLOOR = 1_000_000n;

export function gasLimitFor(functionName: string, estimate: bigint | undefined): bigint {
  const floor = GAS_FLOORS[functionName] ?? DEFAULT_FLOOR;
  const padded = estimate === undefined ? 0n : (estimate * 3n) / 2n;
  const g = padded > floor ? padded : floor;
  return g < TX_GAS_CAP ? g : TX_GAS_CAP - 1n;
}

/** A revert that used (nearly) all its gas was most likely out of gas rather than a logic error. */
export function looksOutOfGas(gasUsed: bigint, gasLimit: bigint | undefined): boolean {
  return gasLimit !== undefined && gasLimit > 0n && gasUsed * 100n >= gasLimit * 95n;
}
