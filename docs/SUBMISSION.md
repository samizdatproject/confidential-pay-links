# Zama Developer Program, Builder Track: submission draft

Status: **draft**. Season 5 has not been announced (as of 2026-10-10). When it opens, copy these answers into the season's form and adjust them to its fields. The Season 3 Builder form asked for a functioning dApp demo using the Zama Protocol, smart contract **and** frontend, clear documentation, and a 3-minute video pitch, deployed on Sepolia or mainnet.

Fill in the `⟨…⟩` placeholders after deploying.

---

**Project name:** Confidential Pay Links

**One-liner:** Stripe-style payment links for ERC-7984 confidential tokens: encrypted invoice amounts, homomorphic payment matching, private receipts, and selective disclosure to auditors.

**Description (short):**
A merchant creates an invoice whose amount is encrypted in the browser with the Zama SDK and gets a shareable link. The payer pays with a single `confidentialTransferAndCall` in cUSDC or cUSDT. In the ERC-7984 receiver hook the contract checks `received == invoiced` on ciphertexts and uses `FHE.select` to either forward the payment to the merchant or let the token refund the payer. It never reverts on encrypted conditions, so a payment and a refund are indistinguishable on chain. Merchant and payer decrypt their own receipts. The merchant can grant one auditor access to one invoice through the ACL, or publish only the encrypted "paid" flag so anyone can verify "paid: yes" with KMS signatures, on chain if needed, without learning the amount. There is no backend, no admin and no custody.

**What problem it solves:**
- Checkout on a public chain leaks every invoice amount, every customer and every merchant's revenue.
- ERC-7984 hides balances and transfers, but merchants still need three things:
  1. to match payments to invoices;
  2. to prove payment to a third party;
  3. to share individual receipts with an accountant.
- Reconciliation memos and auditor access are open gaps in the ecosystem (OpenZeppelin confidential-contracts issues #401 and #417). This project fills them at the app layer.

**How it uses the Zama Protocol:**
- Encrypted inputs: `externalEuint64` with input proofs, for the invoice amount and for the payment.
- ERC-7984 (OpenZeppelin confidential-contracts v0.5.3): payments through `confidentialTransferAndCall` and `IERC7984Receiver`, with refunds handled by the token when the hook returns an encrypted `false`.
- Homomorphic logic: `FHE.eq`, `FHE.ne`, `FHE.and`, `FHE.not`, `FHE.or`, `FHE.select`; an encrypted paid flag that resists double payment.
- ACL: per-invoice viewers (selective disclosure); payer-only access to each payment attempt; transient allowances to the token.
- Public decryption: `FHE.makePubliclyDecryptable` on the paid flag only, and `FHE.checkSignatures` in `confirmPaidStatus`.
- Frontend: `@zama-fhe/sdk` v3 (`web()` relayer on Sepolia), user decryption with EIP-712 permits, public decryption, retry and backoff for relayer and decryption outages, and COOP/COEP for multi-threaded WASM.
- Testing: forge-fhevm (real host contracts) and the SDK's `cleartext()` relayer against a local FHEVM, for end-to-end runs.

**Links:**
- Live app: ⟨https://…⟩ (Cloudflare Pages or Vercel, which serve COOP/COEP)
- Repo: ⟨https://github.com/samizdatproject/confidential-pay-links⟩
- Contract (Sepolia): `0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d` (ConfidentialPayLinks), `0x2d7003f996491F965C3Fb32355Cc42150FE5f94D` (PayLinksReader). Both verified on Blockscout.
- Example payments (Sepolia, cUSDCMock): exact payment accepted `0x20231adce065ed9a244038dd636fe3e88550b3e1d26eadeea744515045679ba1`; wrong amount refunded `0x3b04bc40ec81a4cec46044e648a1bcca768a4cfb298e01c141c1bf0fa7ea1b43`; public paid proof recorded on chain `0xaf733dbb50920acddb52bc3808fdc9d7f9ce13520b998d31eb15cd58efa19406`.
- Video (3 min, own voice): ⟨link⟩

**Tests:**
- 49 Foundry tests on forge-fhevm, including regressions for two independent security reviews, (happy path, under- and over-payment, double pay, wrong token, ACL for merchant/payer/auditor/stranger, invoice id binding, reentrancy, public proof, fuzz).
- 19 web unit tests.
- A Node end-to-end run and a headless-browser end-to-end run against a local FHEVM with the real SDK.
- A live Sepolia end-to-end run with the real relayer and KMS: accepted payment, refunded payment, public proof confirmed on chain, auditor access.

**Team:** samizdatproject (solo builder). ⟨Choose whether to be credited by GitHub/X or to stay anonymous; the form offers "No, I prefer to be anonymous".⟩

**AI disclosure:** Built with an AI coding assistant (Claude) under my direction and review; see the README. The video narration is my own voice.

**What's next:**
- Partial-payment and overpayment change handling (refund the excess instead of everything).
- An optional merchant webhook relayer that user-decrypts receipts server-side.
- Payroll and batch invoices.
- A Merkl or indexer integration.
- An audit before mainnet use.
