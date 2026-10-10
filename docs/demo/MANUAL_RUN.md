# Manual two-wallet run on Sepolia (2026-10-10)

This run used real MetaMask wallets against the live site (https://samizdatproject.github.io/confidential-pay-links/). ConfidentialPayLinks is deployed at `0x195a67B3fd34Bb2372EdcaB465ed56F2E005653d`.

**Wallets:**
- Merchant: `0x63303434a68D715c0Ed3c4abAC4236588e460AF8`. This is a MetaMask EIP-7702 smart account, so its calls go through MetaMask's DelegationManager.
- Payer: `0x7178e85cE66fadE2eD97bcB81B4e955A4ec86eFb`

| Step | Result | Tx |
|---|---|---|
| Merchant creates "Order 1 – exact" (25 cUSDCMock) | created | 0x21cea74f250c… |
| Merchant creates "Order 2 – wrong amount" (25) | created | 0x943dd7a97f45… |
| Payer pays 25 on Order 1 | **accepted**, invoice paid | (payer account) |
| Payer pays 24 on Order 2 (test control) | **refunded**, invoice unpaid | (payer account) |
| Merchant publishes paid status for Order 1 | published | 0xbe334aeb93e5c62d12df8826ec6a25ea51664be1933a6ee6e4813191e3ef2a65 |
| Public check, no wallet | "PAID"; the KMS signatures are verified by simulating `confirmPaidStatus` | — |
| Record proof on chain | `paidConfirmed = true` | 0x3bb6b6296c54f2a9fb11e76a330f8f0f59ba6f5f17d54ee42a4333b1579ecf1a |

**Screenshots:**
- `merchant-dashboard-two-wallets.png`: the dashboard after "Decrypt all". It shows the accepted and refunded payments from the payer wallet.
- `public-check-paid.jpg`: the public check before the proof is recorded.
- `public-check-proven-on-chain.jpg`: the public check after recording. It shows "PAID — proven on chain", and no amount is shown anywhere.

**Lessons from this run, all fixed on the live site:**
- **Wallet picker:** Phantom took over `window.ethereum`, so the site now uses an EIP-6963 picker.
- **Gas limit:** MetaMask's smart-account path swapped in a gas limit that left no margin, so the site now suggests explicit gas limits and shows a hint to raise the limit if needed.
- **Account switching:** the site now follows `accountsChanged` and offers a "switch account" option.
- **Test tokens:** the pay page now has a test-token card and a test control for paying a different amount, to demonstrate refunds.
- **MetaMask confirmation window:** it can open behind Chrome, so if a step seems stuck on "Confirm in your wallet", open MetaMask.
