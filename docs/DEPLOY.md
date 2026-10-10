# Deploy and host

## 1. Contract on Sepolia

The deploy script fixes the token allowlist to Zama's `cUSDCMock` and `cUSDTMock` (see `contracts/script/Deploy.s.sol`). It cannot be changed later, because there is no admin.

You need a little Sepolia ETH. The deploy takes two transactions.

| Contract | Sepolia `eth_estimateGas` | Gas limit sent (+20%) |
|---|---|---|
| ConfidentialPayLinks | 12,867,663 | 15,441,195 |
| PayLinksReader (stateless paging views) | 3,374,791 | 4,049,749 |

These are far above a local simulation (1.86M on anvil), because Sepolia charges about 1,600 gas per byte of deployed code. Each transaction is also capped at 16,777,216 gas (EIP-7825). For both reasons the script does not use `forge script --broadcast`, whose limits come from a local simulation. Instead it sends each create with `cast send --gas-limit <Sepolia estimate + 20%>`, and it refuses to send if a limit would exceed the cap. `DRY_RUN=1` prints the estimates.

At ~0.0001 gwei, both deploys together cost well under 0.00001 ETH, and **0.01 Sepolia ETH is plenty**.

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
- refuses any RPC whose chain id is not 11155111 (`LOCAL_TEST=1` allows anvil, to test the broadcast path; tested);
- checks the balance;
- estimates each create with Sepolia's `eth_estimateGas` and sends it with `cast send --keystore` (limit: estimate + 20%, kept below the per-transaction cap);
- prints the explorer links and the exact verify commands.

Afterwards:

1. Verify both contracts on Blockscout with the verify commands the script prints (no key needed). They include `--constructor-args` for the token list, and the reader.
2. Put both addresses in `web/src/chains.ts` (`payLinks` and `reader` of `sepolia`), or build with `VITE_SEPOLIA_PAYLINKS=<addr> VITE_SEPOLIA_READER=<addr>`.
3. Make one demo payment with `cUSDCMock`:
   - open your link, click **Get 100 test cUSDCMock** (this mints the public mock USDC and wraps it), then pay;
   - keep the tx hash for the submission.

**Deployment history (Sepolia, 2026-10-10):**
- `0x972bdbd2857fafc6b9f62eb3b3b595dd508efc16990b4ba132ddb8b011a47147`: `forge script`, 3.36M gas limit, out of gas.
- `0x598036736c2fa296558ab5ed16d9a6810c7a14135a921c74eaa9fcd5813a7adb`: `forge script`, 5.16M gas limit, out of gas.
- `0x9f81825cb0af86afec0459a089cf3d1515c6362d3c3377d50150780c29064c0a`: ConfidentialPayLinks `0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d`, deployed by `deploy-sepolia.sh`.
- `0xac5636fdc5a235ee6cf9dec3e7688c5788418ad040fdf3a9e7730253c207ead8`: PayLinksReader `0x2d7003f996491F965C3Fb32355Cc42150FE5f94D`.

Both contracts are verified on Blockscout as a partial match: the builds carry no metadata hash, and the runtime bytecode is identical. The two failed attempts used `forge script`, before the switch to `cast send`.

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
