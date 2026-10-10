// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST ONLY. A 6-decimal ERC-20 with a public, capped `mint`, shaped like Zama's Sepolia mock USDC
///         (`mint(address,uint256)`, at most 1,000,000 tokens per call). Used for local demos and tests.
contract MockUSD is ERC20 {
    uint256 public constant MAX_MINT = 1_000_000e6;

    error MintTooLarge();

    constructor() ERC20("Mock USD (test only)", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, amount);
    }
}
