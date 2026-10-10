// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title ConfidentialPayLinks
/// @notice Payment links for ERC-7984 confidential tokens (for example cUSDC / cUSDT on the Zama Protocol).
///
/// A merchant creates an invoice whose amount is encrypted client-side. A payer pays it with one
/// `confidentialTransferAndCall` on the invoice's token, passing the invoice id as `data`. In the transfer
/// callback the contract compares the received amount with the invoiced amount homomorphically and, without
/// ever learning either value:
///   - forwards the payment to the merchant when it matches exactly and the invoice was not already paid;
///   - otherwise forwards zero and returns an encrypted `false`, which makes the token refund the payer.
/// Both branches run the same code and emit the same events, so an observer cannot tell a payment from a refund.
///
/// What is public: invoice ids, merchant, token, the optional fixed payer, expiry, a commitment to the link details, who
/// attempted a payment and when. What is encrypted: the invoiced amount, every transferred amount, whether a
/// payment was accepted, and whether the invoice is paid. The merchant can decrypt everything about their
/// invoices, a payer can decrypt their own attempts, and the merchant can grant a viewer (an auditor, or a payer
/// who needs to see the amount) access to one invoice's amount and paid flag. The paid flag alone can be made
/// publicly decryptable to prove "paid" to anyone without revealing the amount.
///
/// Paged list views live in a separate stateless contract (PayLinksReader) to keep this contract's code small:
/// Sepolia prices deployed code high enough that a larger contract would not fit in one transaction.
///
/// There is no owner, no admin and no upgrade path. The set of accepted tokens is fixed at deployment (for example
/// Zama's cUSDC / cUSDT wrappers): a merchant-chosen token could otherwise feed arbitrary handles into the callback.
/// The contract never keeps payments: every accepted payment is forwarded in the same transaction. Tokens sent to
/// this contract with a plain `confidentialTransfer` (no callback) cannot be recovered.
///
/// "Paid" means "some address sent exactly the invoiced amount of the invoice's token through this contract". It
/// does not say who paid: a merchant can pay their own invoice. Consumers that care must check the payer address.
contract ConfidentialPayLinks is IERC7984Receiver, ZamaEthereumConfig, ReentrancyGuardTransient {
    /// @notice Maximum number of viewers (auditors, payers) per invoice, so payments stay cheap.
    uint256 public constant MAX_VIEWERS = 8;

    /// @notice ERC-7984 tokens invoices may be denominated in. Fixed in the constructor; there is no admin.
    mapping(address token => bool) public isAcceptedToken;

    struct Invoice {
        address merchant; // creator; receives the payment
        uint48 createdAt;
        uint48 expiresAt; // 0 = never expires
        address token; // the only ERC-7984 token accepted
        bool cancelled;
        address payer; // address(0) = anyone may pay
        bytes32 detailsHash; // commitment to the link details (memo, amount hint); they are never stored on chain
        euint64 amount; // encrypted amount due
        ebool paid; // encrypted: has an exact payment been accepted?
    }

    struct Payment {
        address payer;
        uint48 paidAt;
        euint64 received; // encrypted amount the token actually moved to this contract
        ebool accepted; // encrypted: forwarded to the merchant (true) or refunded (false)
    }

    struct PaymentRef {
        bytes32 invoiceId;
        uint256 index;
    }

    mapping(bytes32 invoiceId => Invoice) private _invoices;
    mapping(bytes32 invoiceId => Payment[]) private _payments;
    mapping(bytes32 invoiceId => address[]) private _viewers;
    mapping(bytes32 invoiceId => mapping(address => bool)) private _isViewer;
    mapping(address merchant => bytes32[]) private _merchantInvoices;
    mapping(address payer => PaymentRef[]) private _payerPayments;

    /// @notice Paid-flag handle the merchant made publicly decryptable, per invoice.
    mapping(bytes32 invoiceId => ebool) public publishedPaidHandle;
    /// @notice True once a KMS-signed public decryption proved the invoice paid. Never goes back to false.
    mapping(bytes32 invoiceId => bool) public paidConfirmed;

    event InvoiceCreated(
        bytes32 indexed invoiceId,
        address indexed merchant,
        address indexed token,
        address payer,
        uint48 expiresAt,
        bytes32 detailsHash,
        euint64 amount
    );
    event PaymentReceived(
        bytes32 indexed invoiceId, address indexed payer, uint256 index, euint64 received, ebool accepted
    );
    event InvoiceCancelled(bytes32 indexed invoiceId);
    event ViewerAdded(bytes32 indexed invoiceId, address indexed viewer);
    event PaidStatusPublished(bytes32 indexed invoiceId, ebool paidHandle);
    event PaidStatusConfirmed(bytes32 indexed invoiceId, bool paid);

    error InvoiceExists(bytes32 invoiceId);
    error UnknownInvoice(bytes32 invoiceId);
    error ZeroToken();
    error BadExpiry();
    error NotMerchant(bytes32 invoiceId);
    error WrongToken(bytes32 invoiceId, address token);
    error InvoiceIsCancelled(bytes32 invoiceId);
    error InvoiceExpired(bytes32 invoiceId);
    error NotInvoicePayer(bytes32 invoiceId, address payer);
    error BadPaymentData();
    error ZeroViewer();
    error TooManyViewers(bytes32 invoiceId);
    error TokenNotAccepted(address token);
    error NoTokens();
    error UnauthorizedHandle();
    error NothingPublished(bytes32 invoiceId);

    /// @param acceptedTokens ERC-7984 tokens invoices may use. Immutable after deployment.
    constructor(address[] memory acceptedTokens) {
        if (acceptedTokens.length == 0) revert NoTokens();
        for (uint256 i = 0; i < acceptedTokens.length; i++) {
            address t = acceptedTokens[i];
            if (t == address(0)) revert ZeroToken();
            isAcceptedToken[t] = true;
        }
    }

    /// @dev The invoice, if msg.sender is its merchant (one shared check keeps the bytecode small).
    function _merchantInvoice(bytes32 invoiceId) private view returns (Invoice storage inv) {
        inv = _invoices[invoiceId];
        if (inv.merchant == address(0)) revert UnknownInvoice(invoiceId);
        if (msg.sender != inv.merchant) revert NotMerchant(invoiceId);
    }

    // ------------------------------------------------------------------ ids

    /// @notice Id of `merchant`'s invoice with `nonce`, bound to this chain and this deployment, so a link for one
    ///         network or contract can never be satisfied by a payment on another. Mirrored in web/src/link.ts.
    function invoiceIdOf(address merchant, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), merchant, nonce));
    }

    // ------------------------------------------------------------------ merchant actions

    /// @notice Create an invoice. `encryptedAmount` must be encrypted by the merchant for this contract.
    /// @param nonce Random 32 bytes chosen by the merchant; the id is derived from it and from msg.sender.
    /// @param token ERC-7984 token the invoice must be paid in.
    /// @param payer Only this address may pay (and it can decrypt the amount); address(0) for an open link.
    /// @param expiresAt Unix time after which payments are rejected; 0 for no expiry.
    /// @param detailsHash Commitment to the off-chain link details (memo, optional amount hint) that the web app
    ///        checks before showing them (see web/src/link.ts). Opaque to this contract; may be zero.
    function createInvoice(
        bytes32 nonce,
        address token,
        address payer,
        uint48 expiresAt,
        bytes32 detailsHash,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (bytes32 invoiceId) {
        if (token == address(0)) revert ZeroToken();
        if (!isAcceptedToken[token]) revert TokenNotAccepted(token);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert BadExpiry();
        invoiceId = invoiceIdOf(msg.sender, nonce);
        Invoice storage inv = _invoices[invoiceId];
        if (inv.merchant != address(0)) revert InvoiceExists(invoiceId);

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);

        // "false", but as a handle derived from this invoice's own input: `FHE.asEbool(false)` is one global handle
        // shared by every invoice, so ACL grants on it would leak across invoices.
        ebool paid = FHE.ne(amount, amount);
        FHE.allowThis(paid);
        FHE.allow(paid, msg.sender);

        inv.merchant = msg.sender;
        // forge-lint: disable-next-line(unsafe-typecast)
        inv.createdAt = uint48(block.timestamp);
        inv.expiresAt = expiresAt;
        inv.token = token;
        inv.payer = payer;
        inv.detailsHash = detailsHash;
        inv.amount = amount;
        inv.paid = paid;
        _merchantInvoices[msg.sender].push(invoiceId);

        emit InvoiceCreated(invoiceId, msg.sender, token, payer, expiresAt, detailsHash, amount);
        // A fixed payer must be able to see what they are asked to pay.
        if (payer != address(0) && payer != msg.sender) _addViewer(invoiceId, inv, payer);
    }

    /// @notice Let `viewer` decrypt this invoice's amount and paid flag: an auditor, an accountant, or a payer of an
    ///         open link who needs to see the amount before paying. ACL grants cannot be revoked; a viewer keeps
    ///         access to the handles it was granted, and is also granted every later paid-flag update.
    function addViewer(bytes32 invoiceId, address viewer) external {
        Invoice storage inv = _merchantInvoice(invoiceId);
        if (viewer == address(0)) revert ZeroViewer();
        _addViewer(invoiceId, inv, viewer);
    }

    /// @notice Stop accepting payments. Already accepted payments are unaffected.
    function cancelInvoice(bytes32 invoiceId) external {
        _merchantInvoice(invoiceId).cancelled = true;
        emit InvoiceCancelled(invoiceId);
    }

    // ------------------------------------------------------------------ payment

    /// @notice ERC-7984 transfer callback. Pay an invoice with
    ///         `token.confidentialTransferAndCall(address(this), amount, proof, abi.encode(invoiceId))`.
    /// @dev Public conditions (unknown invoice, wrong token, cancelled, expired, wrong payer) revert, which reverts
    ///      the whole transfer. Encrypted conditions never revert: they select between forwarding and refunding.
    function onConfidentialTransferReceived(address, address from, euint64 amount, bytes calldata data)
        external
        nonReentrant
        returns (ebool)
    {
        if (data.length != 32) revert BadPaymentData();
        bytes32 invoiceId = abi.decode(data, (bytes32));
        Invoice storage inv = _invoices[invoiceId];
        if (inv.merchant == address(0)) revert UnknownInvoice(invoiceId);
        if (msg.sender != inv.token) revert WrongToken(invoiceId, msg.sender);
        if (inv.cancelled) revert InvoiceIsCancelled(invoiceId);
        if (inv.expiresAt != 0 && block.timestamp > inv.expiresAt) revert InvoiceExpired(invoiceId);
        if (inv.payer != address(0) && from != inv.payer) revert NotInvoicePayer(invoiceId, from);

        // The token must hold this handle itself (a real ERC-7984 transfer allows it); never compute on, or grant,
        // handles a caller merely names.
        if (!FHE.isAllowed(amount, msg.sender)) revert UnauthorizedHandle();

        ebool accepted = _forward(inv, amount);
        _record(invoiceId, inv, from, amount, accepted);

        // Returning false makes the token move `amount` back to `from`. We forwarded zero in that case, so the
        // refund is covered by the amount we just received.
        FHE.allowTransient(accepted, msg.sender);
        return accepted;
    }

    // ------------------------------------------------------------------ public proof of payment

    /// @notice Make the invoice's current paid flag publicly decryptable. Reveals only yes/no, never an amount.
    ///         Merchant only: publishing is the merchant's decision (it can also hint which attempt succeeded, since
    ///         attempts are public). Authorisation is by role, not by ACL, because ACL includes transient grants.
    function publishPaidStatus(bytes32 invoiceId) external {
        Invoice storage inv = _merchantInvoice(invoiceId);
        FHE.makePubliclyDecryptable(inv.paid);
        publishedPaidHandle[invoiceId] = inv.paid;
        emit PaidStatusPublished(invoiceId, inv.paid);
    }

    /// @notice Record the result of the public decryption of the published paid flag on chain, so other contracts
    ///         can read `paidConfirmed`. Anyone may submit; the KMS signatures are verified.
    /// @param abiEncodedCleartexts `abi.encode(bool)` as returned by the relayer's public decryption.
    function confirmPaidStatus(bytes32 invoiceId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof)
        external
        returns (bool paid)
    {
        ebool handle = publishedPaidHandle[invoiceId];
        if (!FHE.isInitialized(handle)) revert NothingPublished(invoiceId);
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = FHE.toBytes32(handle);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
        paid = abi.decode(abiEncodedCleartexts, (bool));
        if (paid) paidConfirmed[invoiceId] = true;
        emit PaidStatusConfirmed(invoiceId, paid);
    }

    // ------------------------------------------------------------------ views

    function getInvoice(bytes32 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function paymentCount(bytes32 invoiceId) external view returns (uint256) {
        return _payments[invoiceId].length;
    }

    function getPayment(bytes32 invoiceId, uint256 index) external view returns (Payment memory) {
        return _payments[invoiceId][index];
    }

    /// @notice Addresses the merchant added as viewers of this invoice (at most MAX_VIEWERS).
    function viewersOf(bytes32 invoiceId) external view returns (address[] memory) {
        return _viewers[invoiceId];
    }

    function invoiceCountOf(address merchant) external view returns (uint256) {
        return _merchantInvoices[merchant].length;
    }

    /// @notice The `index`-th invoice id of `merchant` (oldest first). Paged lists: see PayLinksReader.
    function merchantInvoiceAt(address merchant, uint256 index) external view returns (bytes32) {
        return _merchantInvoices[merchant][index];
    }

    function paymentCountBy(address payer) external view returns (uint256) {
        return _payerPayments[payer].length;
    }

    /// @notice The `index`-th payment `payer` made (oldest first). Paged lists: see PayLinksReader.
    function paymentRefAt(address payer, uint256 index) external view returns (PaymentRef memory) {
        return _payerPayments[payer][index];
    }

    // ------------------------------------------------------------------ internal

    /// @dev Forwards the payment to the merchant if it matches; returns whether the merchant really received it.
    function _forward(Invoice storage inv, euint64 amount) private returns (ebool accepted) {
        // want = amount == due && !paid && amount != 0   (all encrypted)
        ebool want = FHE.and(FHE.and(FHE.eq(amount, inv.amount), FHE.not(inv.paid)), FHE.ne(amount, uint64(0)));
        // Always transfer (possibly zero) so payments and refunds look the same on chain.
        euint64 forward = FHE.select(want, amount, FHE.asEuint64(0));
        FHE.allowTransient(forward, msg.sender);
        euint64 moved = IERC7984(msg.sender).confidentialTransfer(inv.merchant, forward);
        // Only count it as paid if the merchant received the whole amount.
        accepted = FHE.and(want, FHE.eq(moved, amount));
    }

    /// @dev Updates the paid flag and stores the attempt, with ACL grants for merchant, viewers and payer.
    function _record(bytes32 invoiceId, Invoice storage inv, address from, euint64 amount, ebool accepted) private {
        ebool paid = FHE.or(inv.paid, accepted);
        inv.paid = paid;
        FHE.allowThis(paid);
        FHE.allow(paid, inv.merchant);
        address[] storage viewers = _viewers[invoiceId];
        for (uint256 i = 0; i < viewers.length; i++) {
            FHE.allow(paid, viewers[i]);
        }

        FHE.allowThis(accepted);
        FHE.allow(accepted, inv.merchant);
        FHE.allow(accepted, from);
        // `amount` was checked to be held by the token (a real transfer result, already allowed to this contract and
        // to `from`); the merchant may see attempts too.
        FHE.allow(amount, inv.merchant);

        uint256 index = _payments[invoiceId].length;
        // uint48 seconds last for millions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 paidAt = uint48(block.timestamp);
        _payments[invoiceId].push(Payment({payer: from, paidAt: paidAt, received: amount, accepted: accepted}));
        _payerPayments[from].push(PaymentRef({invoiceId: invoiceId, index: index}));
        emit PaymentReceived(invoiceId, from, index, amount, accepted);
    }

    function _addViewer(bytes32 invoiceId, Invoice storage inv, address viewer) private {
        if (!_isViewer[invoiceId][viewer]) {
            if (_viewers[invoiceId].length >= MAX_VIEWERS) revert TooManyViewers(invoiceId);
            _isViewer[invoiceId][viewer] = true;
            _viewers[invoiceId].push(viewer);
            emit ViewerAdded(invoiceId, viewer);
        }
        FHE.allow(inv.amount, viewer);
        FHE.allow(inv.paid, viewer);
    }
}
