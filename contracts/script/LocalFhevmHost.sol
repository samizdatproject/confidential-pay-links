// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Not deployed by itself. Importing these makes `forge build` emit the artifacts that forge-fhevm's
// deploy-local.sh needs to install the cleartext FHEVM host stack on a local anvil (see scripts/local-chain.sh).
import {ERC1967Proxy} from "@openzeppelin-contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {EmptyUUPSProxyACL} from "@fhevm/host-contracts/contracts/emptyProxyACL/EmptyUUPSProxyACL.sol";
import {EmptyUUPSProxy} from "@fhevm/host-contracts/contracts/emptyProxy/EmptyUUPSProxy.sol";
import {ACL} from "@fhevm/host-contracts/contracts/ACL.sol";
import {CleartextFHEVMExecutor} from "forge-fhevm/cleartext/CleartextFHEVMExecutor.sol";
import {KMSVerifier} from "@fhevm/host-contracts/contracts/KMSVerifier.sol";
import {InputVerifier} from "@fhevm/host-contracts/contracts/InputVerifier.sol";
import {HCULimit} from "@fhevm/host-contracts/contracts/HCULimit.sol";
import {PauserSet} from "@fhevm/host-contracts/contracts/immutable/PauserSet.sol";
