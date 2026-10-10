// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ConfidentialPayLinks} from "../src/ConfidentialPayLinks.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockConfidentialUSD} from "../src/mocks/MockConfidentialUSD.sol";

/// @dev A token that tries to re-enter the pay-links callback while the payment is being forwarded.
contract ReentrantToken is ERC7984, ZamaEthereumConfig {
    ConfidentialPayLinks public target;
    bytes32 public invoiceId;

    constructor() ERC7984("Reentrant", "RE", "") {}

    function arm(ConfidentialPayLinks t, bytes32 id) external {
        target = t;
        invoiceId = id;
    }

    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }

    function confidentialTransfer(address to, euint64 amount) public override returns (euint64) {
        if (address(target) != address(0) && msg.sender == address(target)) {
            // Pretend to deliver a second payment from inside the first one.
            FHE.allowTransient(amount, address(target));
            target.onConfidentialTransferReceived(address(this), tx.origin, amount, abi.encode(invoiceId));
        }
        return super.confidentialTransfer(to, amount);
    }
}

/// @dev A token that "forwards" by moving nothing to the merchant (skims the forward), to check that the contract
///      only counts a payment when the merchant really received it.
contract SkimmingToken is ERC7984, ZamaEthereumConfig {
    constructor() ERC7984("Skim", "SK", "") {}

    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }

    function confidentialTransfer(address to, euint64 amount) public override returns (euint64) {
        FHE.allowThis(amount);
        return super.confidentialTransfer(to, FHE.asEuint64(0));
    }
}

/// @dev Port of the review PoC: a fake "token" that hands the contract someone else's handle.
contract EvilToken {
    function fire(ConfidentialPayLinks t, bytes32 myInvoice, euint64 victimHandle) external {
        t.onConfidentialTransferReceived(address(this), msg.sender, victimHandle, abi.encode(myInvoice));
    }

    function confidentialTransfer(address, euint64) external returns (euint64 r) {}
}

contract ConfidentialPayLinksTest is FhevmTest {
    ConfidentialPayLinks internal links;
    MockUSD internal usd;
    MockConfidentialUSD internal cusd;
    MockUSD internal usd2;
    MockConfidentialUSD internal otherToken;

    uint256 internal constant MERCHANT_PK = 0xA11CE;
    uint256 internal constant PAYER_PK = 0xB0B;
    uint256 internal constant AUDITOR_PK = 0xA0D1;
    uint256 internal constant STRANGER_PK = 0x5757;
    address internal merchant;
    address internal payer;
    address internal auditor;
    address internal stranger;

    uint64 internal constant PRICE = 25_000_000; // 25.00 with 6 decimals
    uint64 internal constant FUNDS = 1_000_000_000; // 1,000.00

    function setUp() public override {
        super.setUp();
        merchant = vm.addr(MERCHANT_PK);
        payer = vm.addr(PAYER_PK);
        auditor = vm.addr(AUDITOR_PK);
        stranger = vm.addr(STRANGER_PK);

        usd = new MockUSD();
        cusd = new MockConfidentialUSD(usd, "Confidential Mock USD", "cmUSD");
        usd2 = new MockUSD();
        otherToken = new MockConfidentialUSD(usd2, "Other", "OTH");
        links = new ConfidentialPayLinks(_tokens(address(cusd), address(otherToken)));

        dealConfidential(IERC7984ERC20Wrapper(address(cusd)), payer, FUNDS);
        dealConfidential(IERC7984ERC20Wrapper(address(otherToken)), payer, FUNDS);
        dealConfidential(IERC7984ERC20Wrapper(address(cusd)), stranger, FUNDS);
    }

    // ------------------------------------------------------------------ helpers

    function _tokens(address a) internal pure returns (address[] memory t) {
        t = new address[](1);
        t[0] = a;
    }

    function _tokens(address a, address b) internal pure returns (address[] memory t) {
        t = new address[](2);
        t[0] = a;
        t[1] = b;
    }

    function _create(bytes32 nonce, address token, address fixedPayer, uint48 expiresAt, uint64 amount)
        internal
        returns (bytes32 id)
    {
        (externalEuint64 enc, bytes memory proof) = encryptUint64(amount, merchant, address(links));
        vm.prank(merchant);
        id = links.createInvoice(nonce, token, fixedPayer, expiresAt, keccak256("memo"), enc, proof);
    }

    function _createOpen(uint64 amount) internal returns (bytes32) {
        return _create(keccak256(abi.encode("open", amount, block.timestamp)), address(cusd), address(0), 0, amount);
    }

    function _pay(address from, MockConfidentialUSD token, bytes32 id, uint64 amount) internal {
        (externalEuint64 enc, bytes memory proof) = encryptUint64(amount, from, address(token));
        vm.prank(from);
        token.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
    }

    function _bal(MockConfidentialUSD token, address who) internal returns (uint64) {
        euint64 h = token.confidentialBalanceOf(who);
        return FHE.isInitialized(h) ? decrypt(h) : 0;
    }

    function _paid(bytes32 id) internal returns (bool) {
        return decrypt(links.getInvoice(id).paid);
    }

    function _accepted(bytes32 id, uint256 i) internal returns (bool) {
        return decrypt(links.getPayment(id, i).accepted);
    }

    /// @dev External wrapper so `vm.expectRevert` can observe a failed user decryption.
    function extUserDecrypt(bytes32 handle, address user, address contract_, bytes memory sig)
        external
        returns (uint256)
    {
        return userDecrypt(handle, user, contract_, sig);
    }

    /// @dev The plaintext tracker reads recorded logs; a reverted frame would swallow them, so flush first.
    function _assertNoAccess(bytes32 handle, address user, bytes memory sig) internal {
        decrypt(bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(UserNotAuthorizedForDecrypt.selector, handle, user));
        this.extUserDecrypt(handle, user, address(links), sig);
    }

    function _userDecrypt(uint256 pk, bytes32 handle) internal returns (uint256) {
        bytes memory sig = signUserDecrypt(pk, address(links));
        return userDecrypt(handle, vm.addr(pk), address(links), sig);
    }

    // ------------------------------------------------------------------ happy path

    function test_happyPath_forwardsToMerchant() public {
        bytes32 id = _createOpen(PRICE);
        assertFalse(_paid(id));

        _pay(payer, cusd, id, PRICE);

        assertEq(_bal(cusd, merchant), PRICE, "merchant received");
        assertEq(_bal(cusd, payer), FUNDS - PRICE, "payer debited");
        assertEq(_bal(cusd, address(links)), 0, "contract holds nothing");
        assertTrue(_paid(id));
        assertEq(links.paymentCount(id), 1);
        ConfidentialPayLinks.Payment memory p = links.getPayment(id, 0);
        assertEq(p.payer, payer);
        assertEq(decrypt(p.received), PRICE);
        assertTrue(decrypt(p.accepted));
        ConfidentialPayLinks.PaymentRef[] memory refs = links.paymentsBy(payer, 0, 10);
        assertEq(refs.length, 1);
        assertEq(refs[0].invoiceId, id);
    }

    function test_invoiceStoresPublicFields() public {
        uint48 exp = uint48(block.timestamp + 1 days);
        bytes32 id = _create(bytes32(uint256(7)), address(cusd), payer, exp, PRICE);
        ConfidentialPayLinks.Invoice memory inv = links.getInvoice(id);
        assertEq(inv.merchant, merchant);
        assertEq(inv.token, address(cusd));
        assertEq(inv.payer, payer);
        assertEq(inv.expiresAt, exp);
        assertEq(inv.detailsHash, keccak256("memo"));
        assertFalse(inv.cancelled);
        assertEq(decrypt(inv.amount), PRICE);
        assertEq(links.invoiceCountOf(merchant), 1);
        assertEq(links.invoicesOf(merchant, 0, 10)[0], id);
        assertEq(links.invoicesOf(merchant, 1, 10).length, 0);
    }

    // ------------------------------------------------------------------ wrong amounts

    function test_underpayment_isRefunded() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE - 1);
        assertEq(_bal(cusd, merchant), 0);
        assertEq(_bal(cusd, payer), FUNDS, "refunded in full");
        assertEq(_bal(cusd, address(links)), 0);
        assertFalse(_paid(id));
        assertFalse(_accepted(id, 0));
    }

    function test_overpayment_isRefunded() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE + 1);
        assertEq(_bal(cusd, merchant), 0);
        assertEq(_bal(cusd, payer), FUNDS);
        assertEq(_bal(cusd, address(links)), 0);
        assertFalse(_paid(id));
    }

    function test_insufficientBalance_movesNothing() public {
        bytes32 id = _createOpen(PRICE);
        address poor = vm.addr(0xD00D);
        dealConfidential(IERC7984ERC20Wrapper(address(cusd)), poor, PRICE - 1);
        _pay(poor, cusd, id, PRICE); // ERC-7984 transfers 0 when the balance is too low
        assertEq(_bal(cusd, merchant), 0);
        assertEq(_bal(cusd, poor), PRICE - 1);
        assertFalse(_paid(id));
        assertEq(decrypt(links.getPayment(id, 0).received), 0);
    }

    function test_zeroAmountInvoice_cannotBePaidWithNothing() public {
        bytes32 id = _createOpen(0);
        _pay(payer, cusd, id, 0);
        assertFalse(_paid(id));
    }

    function test_retryAfterUnderpayment_succeeds() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE - 5);
        _pay(payer, cusd, id, PRICE);
        assertTrue(_paid(id));
        assertFalse(_accepted(id, 0));
        assertTrue(_accepted(id, 1));
        assertEq(_bal(cusd, merchant), PRICE);
        assertEq(_bal(cusd, payer), FUNDS - PRICE);
    }

    // ------------------------------------------------------------------ double pay

    function test_doublePay_secondIsRefunded() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        _pay(stranger, cusd, id, PRICE);
        _pay(payer, cusd, id, PRICE);
        assertEq(_bal(cusd, merchant), PRICE, "merchant paid exactly once");
        assertEq(_bal(cusd, payer), FUNDS - PRICE);
        assertEq(_bal(cusd, stranger), FUNDS);
        assertEq(_bal(cusd, address(links)), 0);
        assertTrue(_paid(id));
        assertTrue(_accepted(id, 0));
        assertFalse(_accepted(id, 1));
        assertFalse(_accepted(id, 2));
    }

    // ------------------------------------------------------------------ public conditions revert

    function test_wrongToken_reverts() public {
        bytes32 id = _createOpen(PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(otherToken));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.WrongToken.selector, id, address(otherToken)));
        otherToken.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        assertEq(_bal(otherToken, payer), FUNDS);
        assertEq(links.paymentCount(id), 0);
    }

    function test_directCallback_reverts() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.WrongToken.selector, id, stranger));
        links.onConfidentialTransferReceived(stranger, stranger, euint64.wrap(bytes32(0)), abi.encode(id));
    }

    function test_unknownInvoice_reverts() public {
        bytes32 id = keccak256("nope");
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(cusd));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.UnknownInvoice.selector, id));
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
    }

    function test_badData_reverts() public {
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(cusd));
        vm.prank(payer);
        vm.expectRevert(ConfidentialPayLinks.BadPaymentData.selector);
        cusd.confidentialTransferAndCall(address(links), enc, proof, hex"01");
    }

    function test_cancelled_reverts() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotMerchant.selector, id));
        links.cancelInvoice(id);
        vm.prank(merchant);
        links.cancelInvoice(id);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(cusd));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.InvoiceIsCancelled.selector, id));
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
    }

    function test_expired_reverts() public {
        bytes32 id = _create(bytes32(uint256(1)), address(cusd), address(0), uint48(block.timestamp + 1 hours), PRICE);
        vm.warp(block.timestamp + 1 hours + 1);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(cusd));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.InvoiceExpired.selector, id));
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
    }

    function test_pastExpiry_rejectedAtCreation() public {
        vm.warp(1000);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, merchant, address(links));
        vm.prank(merchant);
        vm.expectRevert(ConfidentialPayLinks.BadExpiry.selector);
        links.createInvoice(bytes32(0), address(cusd), address(0), 999, bytes32(0), enc, proof);
    }

    function test_zeroToken_rejected() public {
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, merchant, address(links));
        vm.prank(merchant);
        vm.expectRevert(ConfidentialPayLinks.ZeroToken.selector);
        links.createInvoice(bytes32(0), address(0), address(0), 0, bytes32(0), enc, proof);
    }

    function test_fixedPayer_othersRevert() public {
        bytes32 id = _create(bytes32(uint256(2)), address(cusd), payer, 0, PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, stranger, address(cusd));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotInvoicePayer.selector, id, stranger));
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        _pay(payer, cusd, id, PRICE);
        assertTrue(_paid(id));
    }

    function test_operatorFlow_recordsHolderAsPayer() public {
        bytes32 id = _createOpen(PRICE);
        address operator = vm.addr(0x0EE);
        vm.prank(payer);
        cusd.setOperator(operator, uint48(block.timestamp + 1 hours));
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, operator, address(cusd));
        vm.prank(operator);
        cusd.confidentialTransferFromAndCall(payer, address(links), enc, proof, abi.encode(id));
        assertTrue(_paid(id));
        assertEq(links.getPayment(id, 0).payer, payer);
        assertEq(_bal(cusd, payer), FUNDS - PRICE);
    }

    // ------------------------------------------------------------------ invoice id binding

    function test_invoiceId_boundToChainContractMerchantNonce() public {
        bytes32 nonce = keccak256("n");
        bytes32 id = links.invoiceIdOf(merchant, nonce);
        assertEq(id, keccak256(abi.encode(block.chainid, address(links), merchant, nonce)));
        assertTrue(id != links.invoiceIdOf(payer, nonce), "merchant-bound");
        assertTrue(id != links.invoiceIdOf(merchant, keccak256("m")), "nonce-bound");
        ConfidentialPayLinks other = new ConfidentialPayLinks(_tokens(address(cusd)));
        assertTrue(id != other.invoiceIdOf(merchant, nonce), "contract-bound");
        uint256 chain = vm.getChainId();
        vm.chainId(11155111);
        assertTrue(id != links.invoiceIdOf(merchant, nonce), "chain-bound");
        vm.chainId(chain);
    }

    function test_invoiceId_vector() public pure {
        // Same vector is asserted in web/test/link.test.ts (chain 31337, contract and merchant below).
        assertEq(
            keccak256(
                abi.encode(
                    uint256(31337),
                    address(0x5FbDB2315678afecb367f032d93F642f64180aa3),
                    address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8),
                    bytes32(uint256(1))
                )
            ),
            0xcb10e8b297c3ee03508b03f6ce4ed47f9d6a903b794ebbab8689351b60962dbd
        );
    }

    function test_createdIdMatchesInvoiceIdOf() public {
        bytes32 nonce = bytes32(uint256(42));
        bytes32 id = _create(nonce, address(cusd), address(0), 0, PRICE);
        assertEq(id, links.invoiceIdOf(merchant, nonce));
    }

    function test_duplicateNonce_reverts() public {
        bytes32 nonce = bytes32(uint256(3));
        bytes32 id = _create(nonce, address(cusd), address(0), 0, PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, merchant, address(links));
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.InvoiceExists.selector, id));
        links.createInvoice(nonce, address(cusd), address(0), 0, bytes32(0), enc, proof);
    }

    function test_sameNonceOtherMerchant_isDifferentInvoice() public {
        bytes32 nonce = bytes32(uint256(4));
        bytes32 a = _create(nonce, address(cusd), address(0), 0, PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, stranger, address(links));
        vm.prank(stranger);
        bytes32 b = links.createInvoice(nonce, address(cusd), address(0), 0, bytes32(0), enc, proof);
        assertTrue(a != b);
        assertEq(links.getInvoice(a).merchant, merchant);
        assertEq(links.getInvoice(b).merchant, stranger);
    }

    function test_inputProofBoundToMerchant() public {
        // An encrypted amount made by someone else cannot be replayed into a merchant's invoice.
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, stranger, address(links));
        vm.prank(merchant);
        vm.expectRevert();
        links.createInvoice(bytes32(0), address(cusd), address(0), 0, bytes32(0), enc, proof);
    }

    // ------------------------------------------------------------------ ACL

    function test_acl_merchantDecryptsAmountAndPaid() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        ConfidentialPayLinks.Invoice memory inv = links.getInvoice(id);
        assertEq(_userDecrypt(MERCHANT_PK, euint64.unwrap(inv.amount)), PRICE);
        assertEq(_userDecrypt(MERCHANT_PK, ebool.unwrap(inv.paid)), 1);
        ConfidentialPayLinks.Payment memory p = links.getPayment(id, 0);
        assertEq(_userDecrypt(MERCHANT_PK, euint64.unwrap(p.received)), PRICE);
        assertEq(_userDecrypt(MERCHANT_PK, ebool.unwrap(p.accepted)), 1);
    }

    function test_acl_payerDecryptsOwnAttemptOnly() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        ConfidentialPayLinks.Payment memory p = links.getPayment(id, 0);
        assertEq(_userDecrypt(PAYER_PK, ebool.unwrap(p.accepted)), 1);
        assertEq(_userDecrypt(PAYER_PK, euint64.unwrap(p.received)), PRICE);

        ConfidentialPayLinks.Invoice memory inv = links.getInvoice(id);
        bytes memory sig = signUserDecrypt(PAYER_PK, address(links));
        // An open-link payer is not told the invoice amount or the invoice-level paid flag.
        _assertNoAccess(euint64.unwrap(inv.amount), payer, sig);
        _assertNoAccess(ebool.unwrap(inv.paid), payer, sig);
    }

    function test_acl_strangerCannotDecryptAnything() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        ConfidentialPayLinks.Invoice memory inv = links.getInvoice(id);
        ConfidentialPayLinks.Payment memory p = links.getPayment(id, 0);
        bytes memory sig = signUserDecrypt(STRANGER_PK, address(links));
        bytes32[4] memory hs =
            [euint64.unwrap(inv.amount), ebool.unwrap(inv.paid), euint64.unwrap(p.received), ebool.unwrap(p.accepted)];
        for (uint256 i = 0; i < hs.length; i++) {
            _assertNoAccess(hs[i], stranger, sig);
        }
    }

    function test_acl_fixedPayerSeesAmountBeforePaying() public {
        bytes32 id = _create(bytes32(uint256(5)), address(cusd), payer, 0, PRICE);
        assertEq(_userDecrypt(PAYER_PK, euint64.unwrap(links.getInvoice(id).amount)), PRICE);
        assertEq(links.viewersOf(id).length, 1);
        assertEq(links.viewersOf(id)[0], payer);
    }

    function test_acl_auditorGrantedSeesAmountAndFuturePaidFlag() public {
        bytes32 id = _createOpen(PRICE);
        bytes memory sig = signUserDecrypt(AUDITOR_PK, address(links));
        ConfidentialPayLinks.Invoice memory inv = links.getInvoice(id);
        _assertNoAccess(euint64.unwrap(inv.amount), auditor, sig);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotMerchant.selector, id));
        links.addViewer(id, auditor);

        vm.prank(merchant);
        links.addViewer(id, auditor);
        assertEq(_userDecrypt(AUDITOR_PK, euint64.unwrap(inv.amount)), PRICE);
        assertEq(_userDecrypt(AUDITOR_PK, ebool.unwrap(links.getInvoice(id).paid)), 0);

        _pay(payer, cusd, id, PRICE);
        // The paid flag is a new handle after the payment; the auditor is granted it too.
        assertEq(_userDecrypt(AUDITOR_PK, ebool.unwrap(links.getInvoice(id).paid)), 1);
        // ...but not the individual payment attempts.
        ConfidentialPayLinks.Payment memory p = links.getPayment(id, 0);
        _assertNoAccess(euint64.unwrap(p.received), auditor, sig);
    }

    function test_acl_auditorOfOneInvoiceCannotReadAnother() public {
        bytes32 a = _createOpen(PRICE);
        bytes32 b = _create(bytes32(uint256(6)), address(cusd), address(0), 0, PRICE + 1);
        vm.prank(merchant);
        links.addViewer(a, auditor);
        bytes memory sig = signUserDecrypt(AUDITOR_PK, address(links));
        bytes32 hb = euint64.unwrap(links.getInvoice(b).amount);
        _assertNoAccess(hb, auditor, sig);
    }

    function test_viewerLimit() public {
        bytes32 id = _createOpen(PRICE);
        vm.startPrank(merchant);
        for (uint256 i = 1; i <= links.MAX_VIEWERS(); i++) {
            links.addViewer(id, address(uint160(0x1000 + i)));
        }
        links.addViewer(id, address(uint160(0x1001))); // re-adding is a no-op, not a new slot
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.TooManyViewers.selector, id));
        links.addViewer(id, address(0xFFFF));
        vm.expectRevert(ConfidentialPayLinks.ZeroViewer.selector);
        links.addViewer(id, address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ public paid proof

    /// @dev Public decryption as the relayer returns it: cleartexts ABI-encoded as a tuple, plus the KMS proof.
    function _publishAndProve(bytes32 id) internal returns (bytes memory clear, bytes memory proof) {
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(links.publishedPaidHandle(id));
        (uint256[] memory cleartexts,) = publicDecrypt(handles); // reverts unless publicly decryptable
        clear = abi.encode(cleartexts[0] == 1);
        proof = buildDecryptionProof(handles, clear);
    }

    function test_publicProof_paid() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        vm.prank(merchant);
        links.publishPaidStatus(id);
        (bytes memory clear, bytes memory proof) = _publishAndProve(id);
        vm.prank(stranger); // anyone may submit the proof
        assertTrue(links.confirmPaidStatus(id, clear, proof));
        assertTrue(links.paidConfirmed(id));
        // The amount itself stays private.
        assertFalse(_acl.isAllowedForDecryption(euint64.unwrap(links.getInvoice(id).amount)));
        assertFalse(_acl.isAllowedForDecryption(euint64.unwrap(links.getPayment(id, 0).received)));
    }

    function test_publicProof_unpaidThenPaid() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(merchant);
        links.publishPaidStatus(id);
        (bytes memory clear, bytes memory proof) = _publishAndProve(id);
        assertFalse(links.confirmPaidStatus(id, clear, proof));
        assertFalse(links.paidConfirmed(id));

        _pay(payer, cusd, id, PRICE);
        // The old proof still says "not paid"; a fresh publication is needed.
        assertFalse(links.confirmPaidStatus(id, clear, proof));
        vm.prank(merchant);
        links.publishPaidStatus(id);
        (clear, proof) = _publishAndProve(id);
        assertTrue(links.confirmPaidStatus(id, clear, proof));
    }

    function test_publicProof_forgedCleartextRejected() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(merchant);
        links.publishPaidStatus(id);
        (, bytes memory proof) = _publishAndProve(id);
        vm.expectRevert();
        links.confirmPaidStatus(id, abi.encode(true), proof);
        assertFalse(links.paidConfirmed(id));
    }

    function test_publicProof_onlyAuthorizedPublish() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotAllowed.selector, id, stranger));
        links.publishPaidStatus(id);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NothingPublished.selector, id));
        links.confirmPaidStatus(id, abi.encode(true), "");
        // Publishing is the merchant's decision: viewers and fixed payers cannot publish.
        vm.prank(merchant);
        links.addViewer(id, auditor);
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotAllowed.selector, id, auditor));
        links.publishPaidStatus(id);
        vm.prank(merchant);
        links.publishPaidStatus(id);
    }

    // ------------------------------------------------------------------ reentrancy

    function test_reentrancy_blocked() public {
        ReentrantToken bad = new ReentrantToken();
        bad.mint(payer, FUNDS);
        links = new ConfidentialPayLinks(_tokens(address(bad)));
        bytes32 id = _create(bytes32(uint256(9)), address(bad), address(0), 0, PRICE);
        bad.arm(links, id);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(bad));
        vm.prank(payer, payer);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        bad.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        assertEq(links.paymentCount(id), 0);
    }

    // ------------------------------------------------------------------ privacy of outcome

    /// Accepted and refunded payments must produce the same sequence of event types from the same contracts.
    function test_paymentAndRefund_lookTheSameOnChain() public {
        bytes32 a = _createOpen(PRICE);
        bytes32 b = _create(bytes32(uint256(10)), address(cusd), address(0), 0, PRICE);

        // Warm-up: the merchant's first-ever receipt writes a fresh balance slot; compare like with like.
        _pay(payer, cusd, _create(bytes32(uint256(11)), address(cusd), address(0), 0, PRICE), PRICE);
        (externalEuint64 e1, bytes memory p1) = encryptUint64(PRICE, payer, address(cusd));
        (externalEuint64 e2, bytes memory p2) = encryptUint64(PRICE - 1, payer, address(cusd));
        vm.recordLogs();
        vm.prank(payer);
        uint256 g = gasleft();
        cusd.confidentialTransferAndCall(address(links), e1, p1, abi.encode(a)); // accepted
        uint256 gasOk = g - gasleft();
        Vm.Log[] memory ok = vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(payer);
        g = gasleft();
        cusd.confidentialTransferAndCall(address(links), e2, p2, abi.encode(b)); // refunded
        uint256 gasBad = g - gasleft();
        Vm.Log[] memory bad = vm.getRecordedLogs();
        emit log_named_uint("gas accepted", gasOk);
        emit log_named_uint("gas refunded", gasBad);
        // Same code path: gas may differ only by storage warm/cold noise, never by branch.
        assertApproxEqAbs(gasOk, gasBad, 1_000, "gas does not reveal the outcome");

        bytes32[] memory okSig = _appEvents(ok);
        bytes32[] memory badSig = _appEvents(bad);
        assertEq(okSig.length, badSig.length, "same number of token/pay-link events");
        for (uint256 i = 0; i < okSig.length; i++) {
            assertEq(okSig[i], badSig[i]);
        }
    }

    function _appEvents(Vm.Log[] memory logs) internal view returns (bytes32[] memory sigs) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(cusd) || logs[i].emitter == address(links)) n++;
        }
        sigs = new bytes32[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(cusd) || logs[i].emitter == address(links)) {
                sigs[n++] = keccak256(abi.encode(logs[i].emitter, logs[i].topics[0]));
            }
        }
    }

    // ------------------------------------------------------------------ review regressions

    /// N-1 / M-1: a fake token cannot be used, and even an accepted token cannot pass a handle it does not hold.
    function test_regression_fakeTokenCannotLeakVictimAmounts() public {
        bytes32 victim = _createOpen(PRICE);
        _pay(payer, cusd, victim, PRICE);
        euint64 victimAmount = links.getInvoice(victim).amount;

        EvilToken evil = new EvilToken();
        (externalEuint64 enc, bytes memory proof) = encryptUint64(1, stranger, address(links));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.TokenNotAccepted.selector, address(evil)));
        links.createInvoice(bytes32(uint256(99)), address(evil), address(0), 0, 0, enc, proof);

        // Defence in depth: deploy a contract that (wrongly) accepts the evil token; the handle check still holds.
        ConfidentialPayLinks weak = new ConfidentialPayLinks(_tokens(address(evil)));
        (enc, proof) = encryptUint64(1, stranger, address(weak));
        vm.prank(stranger);
        bytes32 mine = weak.createInvoice(bytes32(uint256(99)), address(evil), address(0), 0, 0, enc, proof);
        vm.prank(stranger);
        vm.expectRevert(ConfidentialPayLinks.UnauthorizedHandle.selector);
        evil.fire(weak, mine, victimAmount);

        bytes memory sig = signUserDecrypt(STRANGER_PK, address(links));
        _assertNoAccess(euint64.unwrap(victimAmount), stranger, sig);
        _assertNoAccess(euint64.unwrap(links.getPayment(victim, 0).received), stranger, sig);
    }

    /// N-1: the same attack through an accepted token's callback with someone else's handle.
    function test_regression_acceptedTokenCallerMustHoldHandle() public {
        bytes32 victim = _createOpen(PRICE);
        euint64 victimAmount = links.getInvoice(victim).amount;
        (externalEuint64 enc, bytes memory proof) = encryptUint64(1, stranger, address(links));
        vm.prank(stranger);
        bytes32 mine = links.createInvoice(bytes32(uint256(98)), address(cusd), address(0), 0, 0, enc, proof);
        vm.prank(address(cusd)); // even a call that really comes from the token address
        vm.expectRevert(ConfidentialPayLinks.UnauthorizedHandle.selector);
        links.onConfidentialTransferReceived(stranger, stranger, victimAmount, abi.encode(mine));
    }

    /// M-2: paid flags are per-invoice handles, and only the merchant may publish.
    function test_regression_paidFlagNotSharedAcrossInvoices() public {
        bytes32 a = _createOpen(PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(7, stranger, address(links));
        vm.prank(stranger);
        bytes32 b = links.createInvoice(bytes32(uint256(1)), address(cusd), address(0), 0, 0, enc, proof);
        assertTrue(ebool.unwrap(links.getInvoice(a).paid) != ebool.unwrap(links.getInvoice(b).paid));
        assertFalse(_paid(a));
        assertFalse(_paid(b));
        vm.prank(merchant); // merchant of A cannot publish B
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.NotAllowed.selector, b, merchant));
        links.publishPaidStatus(b);
        // ...nor decrypt B's flag through a shared handle.
        _assertNoAccess(ebool.unwrap(links.getInvoice(b).paid), merchant, signUserDecrypt(MERCHANT_PK, address(links)));
    }

    function test_regression_tokenAllowlist() public {
        vm.expectRevert(ConfidentialPayLinks.NoTokens.selector);
        new ConfidentialPayLinks(new address[](0));
        vm.expectRevert(ConfidentialPayLinks.ZeroToken.selector);
        new ConfidentialPayLinks(_tokens(address(0)));
        assertTrue(links.isAcceptedToken(address(cusd)));
        assertFalse(links.isAcceptedToken(address(usd)));
        assertEq(links.acceptedTokens().length, 2);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, merchant, address(links));
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.TokenNotAccepted.selector, address(usd)));
        links.createInvoice(bytes32(0), address(usd), address(0), 0, 0, enc, proof);
    }

    /// L-1: a token that does not deliver the forward is not counted as paid, and the payer is refunded.
    function test_regression_undeliveredForwardIsNotPaid() public {
        SkimmingToken skim = new SkimmingToken();
        skim.mint(payer, FUNDS);
        links = new ConfidentialPayLinks(_tokens(address(skim)));
        bytes32 id = _create(bytes32(uint256(12)), address(skim), address(0), 0, PRICE);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(skim));
        vm.prank(payer);
        skim.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        assertFalse(_paid(id));
        assertFalse(_accepted(id, 0));
        assertEq(decrypt(skim.confidentialBalanceOf(payer)), FUNDS, "refunded");
    }

    // ------------------------------------------------------------------ L-6 extra cases

    function test_merchantCanPayOwnInvoice_documentedLimitation() public {
        dealConfidential(IERC7984ERC20Wrapper(address(cusd)), merchant, FUNDS);
        bytes32 id = _createOpen(PRICE);
        _pay(merchant, cusd, id, PRICE);
        // "paid" means an address sent the exact amount; here it was the merchant. Consumers must check payer.
        assertTrue(_paid(id));
        assertEq(links.getPayment(id, 0).payer, merchant);
        assertEq(_bal(cusd, merchant), FUNDS);
    }

    function test_fixedPayer_operatorFlow() public {
        bytes32 id = _create(bytes32(uint256(13)), address(cusd), payer, 0, PRICE);
        address operator = vm.addr(0x0EE);
        vm.prank(payer);
        cusd.setOperator(operator, uint48(block.timestamp + 1 hours));
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, operator, address(cusd));
        vm.prank(operator);
        cusd.confidentialTransferFromAndCall(payer, address(links), enc, proof, abi.encode(id));
        assertTrue(_paid(id));
        assertEq(links.getPayment(id, 0).payer, payer);
    }

    function test_paymentExactlyAtExpiry_isAccepted() public {
        uint48 exp = uint48(block.timestamp + 1 hours);
        bytes32 id = _create(bytes32(uint256(14)), address(cusd), address(0), exp, PRICE);
        vm.warp(exp);
        _pay(payer, cusd, id, PRICE);
        assertTrue(_paid(id));
    }

    function test_cancelAfterAcceptance_rejectsLaterAttempts_keepsPaid() public {
        bytes32 id = _createOpen(PRICE);
        _pay(payer, cusd, id, PRICE);
        vm.prank(merchant);
        links.cancelInvoice(id);
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, stranger, address(cusd));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ConfidentialPayLinks.InvoiceIsCancelled.selector, id));
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        assertTrue(_paid(id));
        assertEq(_bal(cusd, stranger), FUNDS);
    }

    function test_stalePublishedFalse_afterAcceptedPayment_staysFalseUntilRepublished() public {
        bytes32 id = _createOpen(PRICE);
        vm.prank(merchant);
        links.publishPaidStatus(id);
        (bytes memory clear, bytes memory proof) = _publishAndProve(id);
        _pay(payer, cusd, id, PRICE);
        assertFalse(links.confirmPaidStatus(id, clear, proof));
        assertFalse(links.paidConfirmed(id));
        assertTrue(ebool.unwrap(links.publishedPaidHandle(id)) != ebool.unwrap(links.getInvoice(id).paid));
    }

    function test_spamAttempts_paginatedViews() public {
        bytes32 id = _createOpen(PRICE);
        for (uint256 i = 0; i < 12; i++) {
            _pay(stranger, cusd, id, 1);
        }
        assertEq(links.paymentCount(id), 12);
        assertEq(links.getPayments(id, 0, 5).length, 5);
        assertEq(links.getPayments(id, 10, 5).length, 2);
        assertEq(links.getPayments(id, 12, 5).length, 0);
        assertEq(links.paymentCountBy(stranger), 12);
        assertEq(links.paymentsBy(stranger, 11, 100).length, 1);
        // A legitimate payment after spam still costs about the same (no per-attempt loops in the payment path).
        (externalEuint64 enc, bytes memory proof) = encryptUint64(PRICE, payer, address(cusd));
        vm.prank(payer);
        uint256 g = gasleft();
        cusd.confidentialTransferAndCall(address(links), enc, proof, abi.encode(id));
        assertLt(g - gasleft(), 2_000_000);
        assertTrue(_paid(id));
        assertEq(_bal(cusd, stranger), FUNDS, "all spam refunded");
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_acceptsOnlyExactNonZero(uint64 due, uint64 sent) public {
        due = uint64(bound(due, 0, FUNDS));
        sent = uint64(bound(sent, 0, FUNDS));
        bytes32 id = _create(keccak256(abi.encode(due, sent)), address(cusd), address(0), 0, due);
        _pay(payer, cusd, id, sent);
        bool expectOk = sent == due && due != 0;
        assertEq(_paid(id), expectOk);
        assertEq(_bal(cusd, merchant), expectOk ? due : 0);
        assertEq(_bal(cusd, payer), expectOk ? FUNDS - due : FUNDS);
        assertEq(_bal(cusd, address(links)), 0);
    }
}
