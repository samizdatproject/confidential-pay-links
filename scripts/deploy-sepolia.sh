#!/usr/bin/env bash
# Deploy ConfidentialPayLinks to Sepolia with Foundry from an encrypted keystore. No private key is ever passed on
# a command line or written to a shell variable.
#
#   One-time setup (or use the throwaway keystore described in docs/DEPLOY.md):
#     cast wallet import cpl-sepolia-deployer --interactive
#
#   scripts/deploy-sepolia.sh            # checks, then deploys
#   DRY_RUN=1 scripts/deploy-sepolia.sh  # every check, no broadcast
#
# Env:
#   ETH_KEYSTORE   keystore file (default ~/.foundry/keystores/cpl-sepolia-deployer)
#   ETH_PASSWORD   optional path to a file holding the keystore password (otherwise you are prompted)
#   SEPOLIA_RPC    RPC override (default: the public node the Zama SDK uses); the chain id is still checked
#
# Cost: ~2.3M gas. Sepolia gas has been ~0.001 gwei lately, i.e. well under 0.001 Sepolia ETH; testnet ETH only.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
CHAIN=11155111
EXPLORER=https://sepolia.etherscan.io
export ETH_KEYSTORE=${ETH_KEYSTORE:-$HOME/.foundry/keystores/cpl-sepolia-deployer}

GOT=$(cast chain-id --rpc-url "$RPC")
[[ "$GOT" == "$CHAIN" ]] || { echo "RPC $RPC is chain $GOT, not Sepolia ($CHAIN). Refusing to deploy." >&2; exit 1; }
[[ -f "$ETH_KEYSTORE" ]] || { echo "No keystore at $ETH_KEYSTORE (see docs/DEPLOY.md)." >&2; exit 1; }

DEPLOYER=$(cast wallet address)
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
forge build >/dev/null 2>&1
GAS=2600000 # measured 2.25M on a local FHEVM; eth_estimateGas on public Sepolia nodes overestimates this create
PRICE=$(cast gas-price --rpc-url "$RPC")
read -r COST NEED OK < <(python3 -I -c 'import sys; b,g,p=map(int,sys.argv[1:]); c=g*p*2; print(c, 2*c, int(b>2*c))' "$BAL" "$GAS" "$PRICE")
echo "network:   Sepolia (chain $CHAIN, $RPC)"
echo "deployer:  $DEPLOYER"
echo "balance:   $(cast from-wei "$BAL") ETH"
echo "budget:    $GAS gas @ 2x $(cast from-wei "$PRICE" gwei) gwei = ~$(cast from-wei "$COST") ETH"
[[ "$OK" == 1 ]] || { echo "Balance too low: send at least $(cast from-wei "$NEED") Sepolia ETH (0.01 is plenty) to $DEPLOYER." >&2; exit 1; }
if [[ "${DRY_RUN:-}" == 1 ]]; then echo "dry run: all checks passed, not broadcasting"; exit 0; fi

forge script script/Deploy.s.sol --rpc-url "$RPC" --keystore "$ETH_KEYSTORE" --sender "$DEPLOYER" --broadcast
RUN="broadcast/Deploy.s.sol/$CHAIN/run-latest.json"
ADDR=$(cast to-check-sum-address "$(jq -r '.transactions[0].contractAddress' "$RUN")")
TX=$(jq -r '.transactions[0].hash' "$RUN")
echo
echo "Deployed ConfidentialPayLinks at $ADDR"
echo "  $EXPLORER/tx/$TX"
echo "  $EXPLORER/address/$ADDR"
echo
echo "Next:"
echo "  1. Verify (no key needed): forge verify-contract $ADDR src/ConfidentialPayLinks.sol:ConfidentialPayLinks --chain-id $CHAIN --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/"
echo "  2. Build the site with VITE_SEPOLIA_PAYLINKS=$ADDR (or set payLinks in web/src/chains.ts)."
