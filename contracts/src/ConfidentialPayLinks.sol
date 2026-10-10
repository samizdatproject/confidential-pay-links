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
/// There is no owner, no admin and no upgrade path. The contract never keeps payments: every accepted payment
/// is forwarded in the same transaction. Tokens sent to this contract with a plain `confidentialTransfer`
/// (no callback) cannot be recovered.
contract ConfidentialPayLinks is IERC7984Receiver, ZamaEthereumConfig, ReentrancyGuardTransient {
    /// @notice Maximum number of viewers (auditors, payers) per invoice, so payments stay cheap.
    uint256 public constant MAX_VIEWERS = 8;

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

    /// @notice Paid-flag handle the merchant (or a viewer) made publicly decryptable, per invoice.
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
    error NotAllowed(bytes32 invoiceId, address account);
    error NothingPublished(bytes32 invoiceId);

    modifier onlyMerchant(bytes32 invoiceId) {
        address merchant = _invoices[invoiceId].merchant;
        if (merchant == address(0)) revert UnknownInvoice(invoiceId);
        if (msg.sender != merchant) revert NotMerchant(invoiceId);
        _;
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
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert BadExpiry();
        invoiceId = invoiceIdOf(msg.sender, nonce);
        Invoice storage inv = _invoices[invoiceId];
        if (inv.merchant != address(0)) revert InvoiceExists(invoiceId);

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);

        ebool paid = FHE.asEbool(false);
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
    function addViewer(bytes32 invoiceId, address viewer) external onlyMerchant(invoiceId) {
        if (viewer == address(0)) revert ZeroViewer();
        _addViewer(invoiceId, _invoices[invoiceId], viewer);
    }

    /// @notice Stop accepting payments. Already accepted payments are unaffected.
    function cancelInvoice(bytes32 invoiceId) external onlyMerchant(invoiceId) {
        _invoices[invoiceId].cancelled = true;
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

        // accepted = amount == due && !paid && amount != 0   (all encrypted)
        ebool accepted = FHE.and(FHE.and(FHE.eq(amount, inv.amount), FHE.not(inv.paid)), FHE.ne(amount, uint64(0)));
        ebool paid = FHE.or(inv.paid, accepted);

        // Effects first.
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
        // The token already granted `amount` to this contract and to `from`; the merchant may see attempts too.
        FHE.allow(amount, inv.merchant);

        uint256 index = _payments[invoiceId].length;
        // uint48 seconds last for millions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 paidAt = uint48(block.timestamp);
        _payments[invoiceId].push(Payment({payer: from, paidAt: paidAt, received: amount, accepted: accepted}));
        _payerPayments[from].push(PaymentRef({invoiceId: invoiceId, index: index}));
        emit PaymentReceived(invoiceId, from, index, amount, accepted);

        // Interaction: always transfer (possibly zero) so payments and refunds look the same on chain.
        euint64 forward = FHE.select(accepted, amount, FHE.asEuint64(0));
        FHE.allowTransient(forward, msg.sender);
        // The returned handle is not needed: the forward can never exceed what this contract just received.
        // forge-lint: disable-next-line(unused-return)
        IERC7984(msg.sender).confidentialTransfer(inv.merchant, forward);

        // Returning false makes the token move `amount` back to `from`. We forwarded zero in that case, so the
        // refund is covered by the amount we just received.
        FHE.allowTransient(accepted, msg.sender);
        return accepted;
    }

    // ------------------------------------------------------------------ public proof of payment

    /// @notice Make the invoice's current paid flag publicly decryptable. Reveals only yes/no, never an amount.
    ///         Callable by anyone who can already decrypt the flag (the merchant, a fixed payer, or a viewer).
    function publishPaidStatus(bytes32 invoiceId) external {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.merchant == address(0)) revert UnknownInvoice(invoiceId);
        if (!FHE.isAllowed(inv.paid, msg.sender)) revert NotAllowed(invoiceId, msg.sender);
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

    function getPayments(bytes32 invoiceId) external view returns (Payment[] memory) {
        return _payments[invoiceId];
    }

    function viewersOf(bytes32 invoiceId) external view returns (address[] memory) {
        return _viewers[invoiceId];
    }

    function invoiceCountOf(address merchant) external view returns (uint256) {
        return _merchantInvoices[merchant].length;
    }

    /// @notice Up to `limit` invoice ids of `merchant`, newest last, starting at `offset`.
    function invoicesOf(address merchant, uint256 offset, uint256 limit) external view returns (bytes32[] memory ids) {
        bytes32[] storage all = _merchantInvoices[merchant];
        if (offset >= all.length) return new bytes32[](0);
        uint256 end = offset + limit > all.length ? all.length : offset + limit;
        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = all[i];
        }
    }

    function paymentsBy(address payer) external view returns (PaymentRef[] memory) {
        return _payerPayments[payer];
    }

    // ------------------------------------------------------------------ internal

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
