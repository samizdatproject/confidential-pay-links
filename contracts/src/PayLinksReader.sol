// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ConfidentialPayLinks} from "./ConfidentialPayLinks.sol";

/// @title PayLinksReader
/// @notice Stateless, read-only paging helpers for ConfidentialPayLinks. Holds no state and no privileges; any
///         number of copies can be deployed. Kept out of the main contract so that contract stays small enough to
///         deploy on Sepolia.
contract PayLinksReader {
    /// @notice Up to `limit` payments of an invoice starting at `offset` (oldest first).
    function getPayments(ConfidentialPayLinks links, bytes32 invoiceId, uint256 offset, uint256 limit)
        external
        view
        returns (ConfidentialPayLinks.Payment[] memory page)
    {
        uint256 end = _end(links.paymentCount(invoiceId), offset, limit);
        if (end <= offset) return page;
        page = new ConfidentialPayLinks.Payment[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = links.getPayment(invoiceId, i);
        }
    }

    /// @notice Up to `limit` invoice ids of `merchant` starting at `offset` (oldest first).
    function invoicesOf(ConfidentialPayLinks links, address merchant, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids)
    {
        uint256 end = _end(links.invoiceCountOf(merchant), offset, limit);
        if (end <= offset) return ids;
        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = links.merchantInvoiceAt(merchant, i);
        }
    }

    /// @notice Up to `limit` of `payer`'s payments starting at `offset` (oldest first).
    function paymentsBy(ConfidentialPayLinks links, address payer, uint256 offset, uint256 limit)
        external
        view
        returns (ConfidentialPayLinks.PaymentRef[] memory page)
    {
        uint256 end = _end(links.paymentCountBy(payer), offset, limit);
        if (end <= offset) return page;
        page = new ConfidentialPayLinks.PaymentRef[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = links.paymentRefAt(payer, i);
        }
    }

    function _end(uint256 total, uint256 offset, uint256 limit) private pure returns (uint256) {
        if (offset >= total) return offset;
        return limit > total - offset ? total : offset + limit;
    }
}
