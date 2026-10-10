# Confidential Pay Links

Payment links for **ERC-7984 confidential tokens** (cUSDC, cUSDT, …) on the [Zama Protocol](https://www.zama.org). The amount is encrypted, the contract checks the payment **homomorphically**, and the merchant can show one receipt to an auditor without opening up anything else.

A merchant types an amount and a memo and gets a link. The payer opens it and pays with one `confidentialTransferAndCall`. The contract compares what arrived with what was invoiced **without decrypting either number**. An exact payment is forwarded to the merchant in the same transaction, and anything else is refunded by the token. Someone watching the chain sees that a payment attempt happened, but not the amount and not whether it was accepted.

- **Live app:** https://samizdatproject.github.io/confidential-pay-links/ (Sepolia, GitHub Pages)
- **Status:** live on Sepolia, verified, with a passing live end-to-end run (see [Status](#status)).
- **Networks:** Sepolia, using Zama's mock wrappers `cUSDCMock` and `cUSDTMock`. There is also a local anvil chain running the cleartext FHEVM, for development.

## Why FHE, and what is new here

Stripe-style payment links on a public chain leak every invoice amount, every customer and every merchant's revenue. ERC-7984 tokens hide balances and transfer amounts, but they do not cover the checkout itself: matching a payment against an invoice, proving that an invoice was paid, or sharing a single receipt with an accountant. This project covers those parts.

| | Plain ERC-20 link | This |
|---|---|---|
| Invoice amount | public | encrypted (`euint64`) |
| Amount paid | public | encrypted |
| Paid / refunded | public (revert or not) | encrypted (`ebool`); the outcome is chosen with `FHE.select`, and a payment and a refund look identical on chain |
| Proof of payment for a third party | show the tx (reveals the amount) | publish only the encrypted paid flag; the KMS-signed decryption reveals yes/no and is checkable on chain |
| Auditor access | everything is public | per-invoice ACL grant: the auditor decrypts this invoice's amount and status, nothing else |

## How it works

```
merchant (browser)                         payer (browser)                                  contract
------------------                         ---------------                                  --------
encrypt(amount) for ConfidentialPayLinks
createInvoice(nonce, token, payer?, expiry,
              detailsHash, encAmount, proof) ───────────────────────────────────────────►  store euint64 due, ebool paid=false
link: #/pay?c=<chain>&id=<invoiceId>&s=<salt>&m=<memo>[&a=<amount>]
                                           open link; check the details against detailsHash
                                           encrypt(amount) for the token
                                           token.confidentialTransferAndCall(
                                               payLinks, encAmount, proof, invoiceId) ──►  onConfidentialTransferReceived:
                                                                                             ok  = (got == due) & !paid & (got != 0)
                                                                                             paid = paid | ok
                                                                                             token.confidentialTransfer(merchant, select(ok, got, 0))
                                                                                             return ok  ─► the token refunds the payer if !ok
```

- **Invoice id** = `keccak256(abi.encode(chainId, contract, merchant, nonce))`. It is bound to the chain and to this deployment, so a link for one network or contract can never be satisfied by a payment somewhere else. It is also bound to the merchant, so nobody can squat on another merchant's id.
- **Link details.** The memo and the optional amount hint live **only in the link** (after `#`, so they are never sent to a server). The contract stores `detailsHash = keccak256(abi.encode(salt, memo, amountHint))`. The pay page recomputes it, and a link whose memo or amount was edited is shown as **modified** and cannot be paid from the UI. The random salt means short memos cannot be brute-forced from the hash.
- **Never revert on encrypted conditions.** Public conditions revert: unknown invoice, wrong token, cancelled, expired, or a payer other than the fixed payer. A wrong amount, a double payment or an insufficient balance (an ERC-7984 transfer then moves 0) all take the same code path and end in a refund.
- **ACL.**
  - Invoice amount: the merchant, the fixed payer (if any) and viewers.
  - Paid flag: the merchant and viewers. Viewers are re-granted on every update, because each update creates a new handle.
  - Each payment attempt (amount sent, accepted or not): the merchant and that payer.
  - Auditors get the invoice-level amount and paid flag, not the individual attempts.
- **Public proof.** `publishPaidStatus` (merchant only, authorised by role rather than by ACL) makes only the paid `ebool` publicly decryptable. Anyone can decrypt it through the relayer. The public check page then verifies the KMS signatures by simulating `confirmPaidStatus` before it shows a result. `confirmPaidStatus` verifies the KMS signatures on chain and sets `paidConfirmed[id] = true`, so other contracts can read a cleartext "paid" bit.
- **Token allowlist, fixed at deployment.** The constructor takes the accepted ERC-7984 tokens (on Sepolia: cUSDCMock and cUSDTMock). There is no admin to change it. The callback also requires the token to hold the handle it passes (`FHE.isAllowed(amount, msg.sender)`). Without both checks, a fake "token" could hand the contract someone else's encrypted handle and get it re-granted (fixed after review; see [Security review](#security-review)).
- **Paid means delivered.** A payment only counts if the token's return value shows the merchant received the whole amount.
- **"Paid" does not say who paid.** It means some address sent exactly the invoiced amount of the invoice's token. A merchant can pay their own invoice. Anyone relying on "paid" for something that matters should check the payer address on the payment.
- **No owner, no admin, no upgrade.** The contract never keeps payments. The hook is `nonReentrant`.

## Pages

| Route | Who | What |
|---|---|---|
| `#/` | merchant | Create a link. The amount is encrypted in the browser by the Zama SDK. Options: a fixed payer, an expiry, and whether to put the amount in the link |
| `#/pay?…` | payer | Shows a verified or modified state, the amount (from the link, or decrypted if the payer is allowed), the payer's balance (decrypted) and a test-token faucet on testnet; pays with one transaction |
| `#/receipt?c&id&i` | payer | Decrypts the payer's own attempt: accepted or refunded, and the amount |
| `#/receipts` | payer | The payer's payments, read from the chain |
| `#/dashboard` | merchant | All the merchant's invoices from the chain; "Decrypt all" with one signature; add a viewer, cancel, publish paid status, CSV export |
| `#/check?c&id` | anyone, no wallet | Public "paid?" check. Shows a status only if one was published, and never an amount. Can record the proof on chain |
| `#/audit?c&id` | auditor | Decrypts the one invoice the merchant shared |
| `#/how` | anyone | The privacy model in plain words |

**Wallets.** Wallets are discovered with EIP-6963. When several are installed (for example Phantom and MetaMask, which both claim `window.ethereum`), a picker shows each wallet's announced name and icon. The choice is remembered in localStorage, and a "switch wallet" link in the header forgets it. `window.ethereum` is used only when no wallet announces itself.

**Gas.** Every write sends an explicit gas limit: max(the connected account's `eth_estimateGas` × 1.5, a per-function floor), capped below 16,777,216 (`web/src/gas.ts`). The floors are Sepolia measurements × about 1.25 plus about 300k for smart-account wrappers. Examples: createInvoice 2.8M, pay 6.5M, wrap 1.5M. This was added after a real createInvoice from an EIP-7702 MetaMask account ran out of gas at a wallet-chosen limit of 1.83M. A reverted transaction shows an explorer link and says when it most likely ran out of gas.

**MetaMask can override the gas limit.** MetaMask may replace a dapp's gas limit with its own estimate, which has no margin. It does this for contracts that its address scan does not rate "Trusted", even when "Added protection" is off ([MetaMask/metamask-extension#46334](https://github.com/MetaMask/metamask-extension/issues/46334)).
- A real payment from an EIP-7702 MetaMask account was sent with a 4,505,130 limit and used 4,432,438 of it (98%), although the site suggested 6.5M.
- The app now shows the suggested limit in the confirm step and a gas hint near Pay. When a transaction reverts it names the limit the wallet actually sent.
- **If a transaction fails out of gas in MetaMask:** retry, and in the confirmation set Edit network fee → Advanced → Gas limit to the suggested value (at least 6,500,000 for a payment, 2,800,000 for createInvoice).

**Outages.** Relayer and decryption calls retry with backoff when the error is transient (HTTP 5xx or 429, network errors, `DECRYPTION_FAILED`). The UI shows "Retrying in N s…" and then a Retry button. Sepolia decryption had real outages in September 2026, and payments already on chain are unaffected by them.

## Privacy model: what is public

**Public:**
- invoice ids
- merchant address
- token
- the optional fixed payer
- expiry
- creation time
- `detailsHash`
- who sent a payment attempt to which invoice, and when
- gas used, which is the same for an accepted and a refunded payment (1,488,220 vs 1,488,291 gas in the test)
- whether a viewer was added (the `ViewerAdded` event)

**Encrypted:**
- invoice amounts
- amounts sent
- accepted or refunded
- paid status (unless it is published)
- token balances

**Off chain, in the link only:** the memo and, if the merchant chose, the amount. Treat a link like an invoice PDF: whoever has it can read it.

**Not hidden:** addresses. FHE hides values, not the transaction graph. A payer who wants to stay unlinkable should pay from a fresh address.

## Repository layout

```
contracts/                 Foundry + forge-fhevm (real FHEVM host contracts, mock KMS/input signers)
  src/ConfidentialPayLinks.sol
  src/PayLinksReader.sol   stateless paging views (kept out of the main contract to fit Sepolia's deploy gas)
  src/mocks/               MockUSD (public-mint ERC-20) + MockConfidentialUSD (OZ ERC7984ERC20Wrapper), local demos only
  test/ConfidentialPayLinks.t.sol
  script/Deploy.s.sol
web/                       Vite + TypeScript + viem + @zama-fhe/sdk (no framework)
  src/link.ts              invoice id + link details commitment (mirrors the contract)
  src/fhe.ts               SDK setup (web() on Sepolia, cleartext() locally), retry/backoff
  src/views.ts             the pages
  e2e/paylinks.e2e.ts      Node end-to-end against the local FHEVM, with the real SDK
  e2e/browser.mjs          headless Chrome end-to-end against the production build (CSP + COOP/COEP)
  e2e/sepolia-readonly.mjs real Sepolia check that spends nothing (see Tests)
scripts/local-chain.sh     anvil + cleartext FHEVM host + contracts, writes web/.env.development.local
scripts/deploy-sepolia.sh  guarded Sepolia deploy from an encrypted keystore (gas limits from Sepolia's eth_estimateGas +20%)
docs/                      DEPLOY.md (deploy and hosting headers), DEMO_SCRIPT.md, SUBMISSION.md
```

## Run it

```bash
# contracts
cd contracts && forge soldeer install && forge test

# local chain with the cleartext FHEVM (anvil on :8545)
scripts/local-chain.sh

# web
cd web && npm ci
npm run sync-contract   # ABI from contracts/out
npm test                # unit tests
npm run e2e             # end to end with the Zama SDK's cleartext relayer
npm run dev             # http://localhost:5173 (sends COOP/COEP headers)
```

In the browser, add the local chain to MetaMask (RPC `http://127.0.0.1:8545`, chain id 31337) and import an anvil dev key. Never use these keys anywhere else.

## Tests

- **Contract: 49 Foundry tests, including a 256-run fuzz test,** on forge-fhevm. They run the real ACL, executor and input-verifier contracts, with plaintext tracking.
  - Payment outcomes: the happy path; under- and over-payment refunded; insufficient balance; a zero-amount invoice cannot be paid with nothing; retry after an underpayment; a double payment (three payers) refunded; payment through an operator.
  - Public conditions that revert: wrong token, a direct call to the callback, unknown invoice, bad data, cancelled, expired, fixed payer.
  - Invoice id binding: chain, contract, merchant and nonce; a shared Solidity/TypeScript test vector; duplicate nonces; an input proof made for another user is rejected.
  - ACL: the merchant decrypts everything; a payer decrypts only their own attempt; a stranger decrypts nothing; a fixed payer sees the amount before paying; an auditor sees the amount and future paid flags but not the attempts, and only for that invoice; the viewer cap.
  - Public proof: paid; unpaid then paid (a stale proof stays "not paid"); a forged cleartext is rejected; only authorised accounts can publish; the amount is never publicly decryptable.
  - Reentrancy through a malicious token.
  - Review regressions:
    - a fake token cannot leak victims' handles (the ported PoC);
    - an accepted token cannot pass handles it does not hold;
    - paid flags are not shared across invoices;
    - the token allowlist;
    - an undelivered forward is not counted as paid.
  - Extra cases: a merchant paying their own invoice; a fixed payer paying through an operator; a payment exactly at expiry; cancelling after acceptance; a stale published "false"; 12 spam attempts with paginated views.
  - Accepted and refunded payments emit the same sequence of events, and their gas differs by under 1,000 (measured: 71).
  - Fuzz: accepted if and only if the amounts are exactly equal and non-zero, and balances are conserved.
- **Web unit tests (19).**
  - The invoice id vector shared with Solidity, and binding.
  - The details commitment: edits detected; an absent amount is committed.
  - Link round-trip and malformed links; hidden and bidi characters; memo byte limits.
  - Amount parsing with uint64 bounds.
  - That the ABI matches the Foundry build.
  - Retry classification and backoff with pending messages.
- **Node end to end (local cleartext FHEVM, real `@zama-fhe/sdk` 3.6).** The flow:
  1. Mint and wrap test tokens, and create an invoice with an SDK-encrypted amount.
  2. The details commitment verifies the link and rejects an edited one.
  3. A wrong payment is refunded, and the payer decrypts "refunded".
  4. The exact payment is forwarded, and the balances are checked by decrypting them.
  5. The merchant decrypts the amount and the paid flag.
  6. The auditor is denied, then granted, then decrypts; a stranger is denied.
  7. Publish, then public decrypt without a wallet, then `confirmPaidStatus` on chain; the amount is still not publicly decryptable.
- **Browser end to end (headless Chrome, production build with CSP and COOP/COEP; `crossOriginIsolated === true`; zero console errors).** A small injected EIP-1193 provider forwards to anvil dev accounts and stands in for MetaMask. The flow: create a link, use the faucet, decrypt the balance, pay, decrypt the receipt (accepted), check that a tampered link is blocked, decrypt everything in the dashboard, add a viewer, publish, check "PAID" publicly and record it on chain, decrypt as the auditor, and deny a stranger. Screenshots are in `e2e-results/screens/`.
- **Live Sepolia end to end** (`web/e2e/sepolia-live.mjs`): the real relayer, KMS and cUSDCMock. Results and tx hashes are under [Status](#status).
- **Real Sepolia, read-only, no funds.** The SDK's `node()` relayer encrypted an invoice amount against Zama's live testnet relayer. An `eth_call` of `createInvoice` then ran on Sepolia, with the contract injected through a state override, and the real InputVerifier accepted the proof. The same proof sent from another address was rejected. Result: `e2e-results/sepolia-readonly.json`.

## Status

- **Built and tested locally.** Everything in [Tests](#tests) passes.
- **Deployed on Sepolia** (2026-10-10, with `scripts/deploy-sepolia.sh`). Both contracts are verified on Blockscout.

  | Contract | Address | Deploy tx |
  |---|---|---|
  | ConfidentialPayLinks (accepted tokens: cUSDCMock, cUSDTMock) | [`0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d`](https://eth-sepolia.blockscout.com/address/0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d) | [`0x9f81825c…`](https://eth-sepolia.blockscout.com/tx/0x9f81825cb0af86afec0459a089cf3d1515c6362d3c3377d50150780c29064c0a) |
  | PayLinksReader | [`0x2d7003f996491F965C3Fb32355Cc42150FE5f94D`](https://eth-sepolia.blockscout.com/address/0x2d7003f996491F965C3Fb32355Cc42150FE5f94D) | [`0xac5636fd…`](https://eth-sepolia.blockscout.com/tx/0xac5636fdc5a235ee6cf9dec3e7688c5788418ad040fdf3a9e7730253c207ead8) |

  Sepolia charges about 1,600 gas per byte of deployed code and caps a transaction at 16,777,216 gas (EIP-7825). The original contract needed about 17.9M, and two early `forge script` attempts ran out of gas. To make it fit:
  - the paging views moved to the stateless `PayLinksReader`;
  - the compiler is set for size (`via_ir`, `optimizer_runs = 1`).

  Sepolia's `eth_estimateGas` now gives 12,867,663 gas for ConfidentialPayLinks and 3,374,791 for PayLinksReader.

  The only source change since deployment is one NatSpec comment above `viewersOf`. Builds carry no metadata hash, so the runtime bytecode is still byte-identical to the deployed code (checked).
- **Live Sepolia end to end: PASS** (`web/e2e/sepolia-live.mjs`, results in `e2e-results/sepolia-live.json`). It ran with the real Zama relayer and KMS and Zama's `cUSDCMock`, using throwaway testnet keys. No relayer retries were needed.
  - **Setup:** the payer minted the public mock USDC and wrapped 100 into cUSDCMock.
  - **(a) Exact payment, accepted.** Invoice for 25 ([`0x61158551…`](https://eth-sepolia.blockscout.com/tx/0x61158551cb20347f6d7bedc25c1a817458ebeeb7f08aae7f15d5ad64a3e4dcce)), paid 25 ([`0x20231adc…`](https://eth-sepolia.blockscout.com/tx/0x20231adce065ed9a244038dd636fe3e88550b3e1d26eadeea744515045679ba1)). The payer decrypts "accepted". Decrypted balances: payer 100 → 75, merchant 0 → 25. The merchant decrypts amount = 25 and paid = true.
  - **(b) Wrong amount, refunded.** Invoice for 25 ([`0xbf11b328…`](https://eth-sepolia.blockscout.com/tx/0xbf11b32865ab355609e42273497799a1e95007c4a10be8146c7f39435499213e)), paid 24 ([`0x3b04bc40…`](https://eth-sepolia.blockscout.com/tx/0x3b04bc40ec81a4cec46044e648a1bcca768a4cfb298e01c141c1bf0fa7ea1b43)). The payer decrypts "refunded". The payer's balance is restored to 75, the merchant's stays at 25, and the invoice is unpaid.
  - **(c) Public proof.** The merchant published (a)'s paid flag ([`0xb23603d5…`](https://eth-sepolia.blockscout.com/tx/0xb23603d5a736629fb7222c3787f3fb5af702d778e3b3e25751c6cc26af36f27b)). Public decryption returned `true`, and `confirmPaidStatus` ([`0xaf733dbb…`](https://eth-sepolia.blockscout.com/tx/0xaf733dbb50920acddb52bc3808fdc9d7f9ce13520b998d31eb15cd58efa19406)) set `paidConfirmed` to true on chain. The invoice amount is not publicly decryptable.
  - **(d) Auditor.** The auditor was denied before the grant. After `addViewer` ([`0x6b603dde…`](https://eth-sepolia.blockscout.com/tx/0x6b603ddeb60c08abf52242d4431cfedaa10f979b638e5bfa05d90fafbd552725)) they decrypt amount = 25 and paid = true, and they still cannot decrypt invoice (b).
  - **Gas.** On Sepolia a payment cost about 4.5–4.8M gas, compared with about 1.5M locally. The first payment to a merchant costs more because it creates their balance slot, and that happens whether the payment is accepted or refunded.
- **Not audited.** Use it on testnets.
- **Pre-submission checklist.** On Sepolia, make one exact payment (accepted and forwarded) and one wrong-amount payment (refunded) with cUSDCMock. Done by script, see (a) and (b) above. Repeat it once through the hosted UI with MetaMask.

## Trust assumptions

- **Zama's token wrappers.** Payments depend on the accepted tokens behaving like OpenZeppelin ERC-7984: they must grant the transferred handle to themselves (`allowThis` in `_update`), or the callback rejects the payment, and they must refund the payer when the callback returns false. On Sepolia these are Zama's `cUSDCMock` and `cUSDTMock` wrappers. Zama operates them, and they may be upgradeable, so this contract trusts Zama to keep that behaviour.
- **The Zama Protocol.** Decryption and the KMS signatures behind public proofs come from Zama's relayer, gateway and KMS.

## Security review

Two independent AI-agent reviews were run on 2026-10-10. They gave the verdict "safe for testnet demo, fix before relying on 'paid'". Everything they found is fixed in the commit after `8dc5a65`:

| ID | Issue | Fix |
|---|---|---|
| N-1 (critical) | Confused-deputy ACL leak. A fake token could call the callback with someone else's encrypted handle, and the contract re-granted it to the attacker's invoice merchant. | The callback requires `FHE.isAllowed(amount, msg.sender)`. The constructor sets an immutable token allowlist. The PoC is ported as a regression test. |
| M-1 | A merchant could forge "PAID" with a fake token. | Token allowlist. The docs and UI state that "paid" does not say who paid. |
| M-2 | `publishPaidStatus` was authorised by ACL (which includes transient grants), and every unpaid invoice shared the global `asEbool(false)` handle. | Merchant-only role check. The paid flag starts as `FHE.ne(amount, amount)`, which is unique to each invoice. |
| L-1 | The return value of the forward was ignored. | "Accepted" now also requires `moved == amount`. |
| L-2 | Payment arrays were unbounded. | Paged views live on the stateless `PayLinksReader` (`getPayments`, `invoicesOf`, `paymentsBy`); the main contract only has single-item getters and counts. The UI shows the latest 20. |
| L-3 | The public check trusted the relayer's cleartext. | The UI simulates `confirmPaidStatus` (on-chain KMS signature check) before showing a result. |
| L-4 | No anti-framing protection. | `frame-ancestors 'none'` and `X-Frame-Options: DENY` in `_headers` and `vercel.json`. |
| L-5 | Unlisted tokens were shown under their own name. | Shown as "UNLISTED (claims …)", and Pay stays disabled until the payer ticks an explicit acknowledgement. |
| L-6 | Missing test cases. | Added. |
| I-1 | Publishing paid status could hint which attempt succeeded. | Documented, warned in the UI, and publishing is merchant-only. |
| I-5 | Gaps in the hidden-character filter. | Extended: controls, variation selectors, line separators, Braille blank, and more. |
| I-6 | Receipt `tx` parameter not validated; CSV export could carry spreadsheet formulas. | `tx` is validated; CSV cells are quoted and formula-prefixed cells are neutralised. |

## Limitations

- **Exact-match payments.** An overpayment is refunded in full, not partially. The payer must know the amount: it comes from the link, from being the fixed payer, or from being added as a viewer.
- **Links are bearer data.** Whoever has the link reads its memo and amount hint. Leave the amount out of the link and add the payer as a viewer if that matters.
- **Tokens are fixed at deployment.** Adding cUSDC or cUSDT on mainnet later means a new deployment, because there is no admin. The pay page still flags tokens the app does not list.
- **ACL grants are permanent.** fhEVM cannot revoke access to a handle. A viewer keeps access to what they were granted, and also receives later paid-flag updates for that invoice.
- **Variation selectors are rejected in memos,** so emoji that need U+FE0F (for example ❤️) cannot be used. Plain emoji work.
- **Viewer cap.** At most 8 viewers per invoice, which keeps the gas of each payment bounded.
- **Tokens sent with a plain `confidentialTransfer`** (without the callback) to the contract cannot be recovered. There is no admin, by design.
- **Redeploying invalidates outstanding links.** The id includes the contract address.
- **"My links" is local.** The memo and salt exist only in the link and in this browser's localStorage. The dashboard still lists every invoice from the chain.
- **Relies on the Zama Protocol.** Decryption depends on Zama's relayer, gateway and KMS. Outages delay decryption, not payments.
- **Wrap and pay are separate steps.** Wrapping USDC into cUSDC moves a public ERC-20 amount, so doing it in the same transaction as the payment would reveal the invoice amount. The UI keeps wrapping separate (the testnet faucet button) on purpose.

## How this was built

This project was built with heavy AI assistance. An AI coding agent (Claude, by Anthropic) wrote most of the code, the tests and the docs, under the direction and review of the human author (samizdatproject). It used Zama's official docs and the `@zama-fhe/sdk` / forge-fhevm tooling. The architecture reuses the earlier [Arc Pay Links](https://github.com/samizdatproject/arc-pay-links) project and the lessons from its security review: invoice ids bound to chain and contract, honest "verified" states, hidden-character filtering, a strict CSP, and no admin.

## License

MIT
