# Demo video script (3 minutes, in your own voice)

**Zama rule:** "AI-generated video or voice will not be considered." Record the narration yourself. Your normal speaking voice is fine, and so is imperfect English: Zama staff have said a real voice in imperfect English is fine and subtitles are encouraged. Add subtitles; the lines below can be the subtitle text. Do not use text-to-speech or voice cloning.

## Setup (before recording)

- The contract is deployed on Sepolia (see `docs/DEPLOY.md`) and the site is live on a host that sends COOP/COEP headers.
- Use two browser profiles, each with MetaMask on Sepolia holding a little Sepolia ETH:
  - **Merchant** (profile A).
  - **Payer** (profile B). Click **Get 100 test cUSDCMock** once before recording, so that the balance is ready.
- A third address to act as the **auditor** (it can be a third profile, or just an address you paste).
- Sign each wallet's first decryption permit once before recording, so that the popups do not take up screen time.
- Zoom the browser to 125%. Hide bookmarks, extensions and anything personal.

## Script

| Time | Screen | Say (in your own words; this is a guide) |
|---|---|---|
| 0:00–0:15 | Title slide or the home page | "This is Confidential Pay Links: payment links, like Stripe links, but for confidential tokens on the Zama Protocol. The amount stays encrypted end to end." |
| 0:15–0:35 | Point at an etherscan page of a normal USDC payment | "On a public chain every invoice is public: how much, who paid, and how much a merchant earns. ERC-7984 tokens hide balances, but checkout still needs matching a payment to an invoice, proving it was paid, and showing one receipt to an accountant. That's what this adds." |
| 0:35–1:00 | Profile A, `#/`: token cUSDCMock, amount 25, memo "Invoice #42 — logo design", expiry 7 days. Click **Create**. Show the "Encrypting the amount in your browser" state, then the wallet popup. | "The merchant types an amount. It's encrypted right here in the browser with Zama's SDK before it touches the chain. The contract only ever stores a ciphertext." |
| 1:00–1:10 | The link appears. Copy it. | "The link carries the memo and, optionally, the amount, after the hash sign, so no server sees them. A hash on chain detects any edit." |
| 1:10–1:40 | Profile B: open the link. Show "Payment request", the verified details and the balance (click **Show my balance**). Click **Pay 25 cUSDCMock** and confirm. | "The payer sees the request and their own encrypted balance, decrypted only for them. Paying is one confidentialTransferAndCall. The contract compares what arrived with the invoice homomorphically, without decrypting anything. If it matches, it forwards to the merchant. If not, the token refunds the payer, in the same transaction." |
| 1:40–1:55 | Receipt page: click **Decrypt my receipt** and show "accepted". | "Only the payer and the merchant can see whether it was accepted. To everyone else, a payment and a refund look exactly the same, same events and same gas." |
| 1:55–2:05 | Optional: edit `a=` in the URL and reload. Red "This link was modified", and Pay is disabled. | "If someone edits the amount in a link, the page catches it." |
| 2:05–2:30 | Profile A, `#/dashboard`: click **Decrypt all** and show the amount, "paid" and the payment row. Click **Add viewer** and paste the auditor address. | "The merchant decrypts all their invoices with one signature, and can export CSV for accounting. Here I give my accountant access to this one invoice. They can decrypt its amount and status, and nothing else." |
| 2:30–2:50 | Click **Publish paid status**, then open `#/check?…` in a private window with no wallet. Show "PAID", then click **Record this proof on chain** (from a profile). | "For a shop or a counterparty, I can publish just the paid flag. Anyone can check 'paid: yes', verified by Zama's KMS signatures, and record it on chain, without ever seeing the amount." |
| 2:50–3:00 | README or the repo | "No backend, no admin keys. The contract never holds funds. It's open source, built with Foundry and forge-fhevm, and tested with 49 contract tests plus end-to-end runs. Thanks!" |

## Tips

- If the Sepolia relayer is slow, the app shows "Retrying in N s…". You can cut that part out of the video. Do not fake the result.
- Show addresses, never seed phrases or private keys.
- Keep it under 3:00. Practise once with a timer.
- If you mention that AI helped build it, keep it short and true: "built with an AI coding assistant; I directed and reviewed it".
