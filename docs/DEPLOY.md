# Deploy and host

## 1. Contract on Sepolia

The deploy script fixes the token allowlist to Zama's `cUSDCMock` and `cUSDTMock` (see `contracts/script/Deploy.s.sol`). It cannot be changed later, because there is no admin.

You need a little Sepolia ETH. Deploying costs about 2.3M gas; at the ~0.001 gwei Sepolia gas price seen on 2026-10-10 that is about 0.0000025 ETH, so **0.01 Sepolia ETH covers the deploy and hundreds of demo payments**.

**Option A: the throwaway deployer that was prepared locally.**
- Address: `0x881C873cd0dc9a72E4e164e08084D51CeeeE1cf5`.
- It is an encrypted Foundry keystore in `../confidential-pay-links-secrets/ks/cpl-sepolia-deployer`, outside the repo. Its random password is in `../confidential-pay-links-secrets/password`.
- Fund it from any Sepolia faucet. Most faucets need an account, a captcha or some mainnet ETH, which is why this was not done automatically.

```bash
S=../confidential-pay-links-secrets
ETH_KEYSTORE=$S/ks/cpl-sepolia-deployer ETH_PASSWORD=$S/password DRY_RUN=1 scripts/deploy-sepolia.sh   # checks only
ETH_KEYSTORE=$S/ks/cpl-sepolia-deployer ETH_PASSWORD=$S/password scripts/deploy-sepolia.sh
```

**Option B: your own key**, imported into an encrypted keystore. The key never appears on a command line:

```bash
cast wallet import cpl-sepolia-deployer --interactive
scripts/deploy-sepolia.sh
```

`deploy-sepolia.sh` does the following:
- refuses any RPC whose chain id is not 11155111;
- checks the balance;
- runs Foundry from the keystore;
- prints the explorer links and the verify command.

Afterwards:

1. Verify the source on Blockscout (no key needed):
   `forge verify-contract <addr> src/ConfidentialPayLinks.sol:ConfidentialPayLinks --chain-id 11155111 --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/`
2. Put the address in `web/src/chains.ts` (`payLinks` of `sepolia`), or build with `VITE_SEPOLIA_PAYLINKS=<addr>`.
3. Make one demo payment with `cUSDCMock`:
   - open your link, click **Get 100 test cUSDCMock** (this mints the public mock USDC and wraps it), then pay;
   - keep the tx hash for the submission.

**Redeploying invalidates every outstanding link,** because the invoice id includes the contract address. Deploy once.

## 2. Hosting: COOP/COEP headers

The Zama SDK runs FHE in WASM. With these two headers, browsers expose `SharedArrayBuffer` and the SDK encrypts on several threads:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the SDK falls back to one thread. The app still works but is slower, and `src/fhe.ts` selects single-thread mode itself when `crossOriginIsolated` is false.

| Host | How | Status |
|---|---|---|
| **Cloudflare Pages** | `web/public/_headers` is copied into `dist/`, and Pages applies it | recommended (free, no account beyond Cloudflare) |
| **Netlify** | same `_headers` file | works |
| **Vercel** | `web/vercel.json` | works; set the project root to `web/` |
| GitHub Pages | cannot set headers | works single-threaded only; a `coi-serviceworker` shim could add isolation, but it is not included |
| `npm run dev` / `npm run preview` | `vite.config.ts` sends both headers | tested: `crossOriginIsolated === true` |

Build: `cd web && npm ci && npm run build`. The output is in `web/dist/` and it is a static site. A production build offers no localhost or anvil network: the local chain is only offered by `vite build --mode development` with `web/.env.development.local`. The SDK's own chain presets, which include a hardhat entry, are still bundled but unused.

## 3. Content-Security-Policy

Production builds get a CSP `<meta>` tag (see `vite.config.ts`):
- `script-src 'self' 'wasm-unsafe-eval'`: the SDK compiles WASM.
- `worker-src 'self' blob:`: the SDK's encryption worker.
- `connect-src`: only the Sepolia RPC (`ethereum-sepolia-rpc.publicnode.com`), the Zama testnet relayer (`relayer.testnet.zama.org`) and the S3 bucket that the relayer's `/v2/keyurl` points to for the FHE public key and CRS.

If Zama moves the key bucket, update `connect-src`. The symptom is a CSP violation in the console during the first encryption.

`frame-ancestors` cannot be set from a `<meta>` tag. If you want anti-framing on Cloudflare or Vercel, add `Content-Security-Policy: frame-ancestors 'none'` as a header.
