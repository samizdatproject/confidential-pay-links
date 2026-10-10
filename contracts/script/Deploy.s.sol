// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {ConfidentialPayLinks} from "../src/ConfidentialPayLinks.sol";
import {MockUSD} from "../src/mocks/MockUSD.sol";
import {MockConfidentialUSD} from "../src/mocks/MockConfidentialUSD.sol";

/// @notice Deploys ConfidentialPayLinks. On a local chain (31337) it also deploys a test ERC-20 and its ERC-7984
///         wrapper so the web app has a token to pay with. On Sepolia, use Zama's cUSDCMock / cUSDTMock instead.
///
///   forge script script/Deploy.s.sol --rpc-url <url> --broadcast --account <keystore>
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        ConfidentialPayLinks links = new ConfidentialPayLinks();
        console.log("ConfidentialPayLinks:", address(links));
        if (block.chainid == 31337) {
            MockUSD usd = new MockUSD();
            MockConfidentialUSD cusd = new MockConfidentialUSD(usd, "Confidential Mock USD (test only)", "cmUSD");
            console.log("MockUSD:", address(usd));
            console.log("MockConfidentialUSD:", address(cusd));
        }
        vm.stopBroadcast();
    }
}
