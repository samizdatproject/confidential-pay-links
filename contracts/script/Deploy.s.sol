// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {ConfidentialPayLinks} from "../src/ConfidentialPayLinks.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockConfidentialUSD} from "../src/mocks/MockConfidentialUSD.sol";

/// @notice Deploys ConfidentialPayLinks with a fixed token allowlist (there is no admin to change it later).
///   - Sepolia: Zama's cUSDCMock and cUSDTMock wrappers (docs.zama.org protocol-apps/addresses/testnet/sepolia).
///   - Local 31337: deploys a test ERC-20 + ERC-7984 wrapper first and accepts that.
///
///   forge script script/Deploy.s.sol --rpc-url <url> --broadcast --account <keystore>
contract Deploy is Script {
    address constant SEPOLIA_CUSDC_MOCK = 0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639;
    address constant SEPOLIA_CUSDT_MOCK = 0x4E7B06D78965594eB5EF5414c357ca21E1554491;

    function run() external {
        address[] memory tokens;
        vm.startBroadcast();
        if (block.chainid == 11155111) {
            tokens = new address[](2);
            tokens[0] = SEPOLIA_CUSDC_MOCK;
            tokens[1] = SEPOLIA_CUSDT_MOCK;
        } else if (block.chainid == 31337) {
            MockUSD usd = new MockUSD();
            MockConfidentialUSD cusd = new MockConfidentialUSD(usd, "Confidential Mock USD (test only)", "cmUSD");
            console.log("MockUSD:", address(usd));
            console.log("MockConfidentialUSD:", address(cusd));
            tokens = new address[](1);
            tokens[0] = address(cusd);
        } else {
            revert("Deploy: unsupported chain (Sepolia or local only)");
        }
        ConfidentialPayLinks links = new ConfidentialPayLinks(tokens);
        console.log("ConfidentialPayLinks:", address(links));
        vm.stopBroadcast();
    }
}
