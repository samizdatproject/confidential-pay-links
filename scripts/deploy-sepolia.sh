#!/usr/bin/env bash
# Deploy ConfidentialPayLinks + PayLinksReader to Sepolia from an encrypted Foundry keystore. No private key is ever
# passed on a command line or written to a shell variable.
#
#   scripts/deploy-sepolia.sh            # checks, then deploys (two transactions)
#   DRY_RUN=1 scripts/deploy-sepolia.sh  # every check incl. Sepolia gas estimates, no broadcast
#
# Env:
#   ETH_KEYSTORE   keystore file (default ~/.foundry/keystores/cpl-sepolia-deployer)
#   ETH_PASSWORD   optional path to a file holding the keystore password (otherwise you are prompted)
#   SEPOLIA_RPC    RPC override (default: the public node the Zama SDK uses); the chain id is still checked
#   LOCAL_TEST=1   with SEPOLIA_RPC=http://127.0.0.1:8545: test the whole script against anvil
#
# Why not `forge script --broadcast`: Sepolia charges far more per byte of deployed code than Foundry's local
# simulation assumes (~1,600 gas/byte), so forge's gas limits run out of gas. Each create is sent with `cast send`
# and a limit of Sepolia's own eth_estimateGas + 20%, which must stay under the 16,777,216 per-tx cap (EIP-7825).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
CHAIN=11155111
EXPLORER=https://sepolia.etherscan.io
TX_CAP=16777216
# Token allowlist, fixed forever at deployment (no admin): Zama's Sepolia cUSDCMock and cUSDTMock wrappers.
TOKENS='[0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639,0x4E7B06D78965594eB5EF5414c357ca21E1554491]'
export ETH_KEYSTORE=${ETH_KEYSTORE:-$HOME/.foundry/keystores/cpl-sepolia-deployer}

# LOCAL_TEST=1 lets this script run against a local anvil (chain 31337) to test the broadcast path itself.
[[ "${LOCAL_TEST:-}" == 1 ]] && CHAIN=31337
GOT=$(cast chain-id --rpc-url "$RPC")
[[ "$GOT" == "$CHAIN" ]] || { echo "RPC $RPC is chain $GOT, not Sepolia ($CHAIN). Refusing to deploy." >&2; exit 1; }
[[ -f "$ETH_KEYSTORE" ]] || { echo "No keystore at $ETH_KEYSTORE (see docs/DEPLOY.md)." >&2; exit 1; }

DEPLOYER=$(cast wallet address)
forge build >/dev/null 2>&1
LINKS_INIT="$(jq -r .bytecode.object out/ConfidentialPayLinks.sol/ConfidentialPayLinks.json)$(cast abi-encode 'f(address[])' "$TOKENS" | cut -c3-)"
READER_INIT="$(jq -r .bytecode.object out/PayLinksReader.sol/PayLinksReader.json)"

estimate() { cast estimate --rpc-url "$RPC" --from "$DEPLOYER" --create "$1"; }
LINKS_EST=$(estimate "$LINKS_INIT")
READER_EST=$(estimate "$READER_INIT")
LINKS_GAS=$(( LINKS_EST * 12 / 10 ))
READER_GAS=$(( READER_EST * 12 / 10 ))
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
PRICE=$(cast gas-price --rpc-url "$RPC")
read -r COST OK < <(python3 -I -c 'import sys; b,g,p=map(int,sys.argv[1:]); c=g*p*2; print(c, int(b>c))' "$BAL" "$(( LINKS_GAS + READER_GAS ))" "$PRICE")

echo "network:   Sepolia (chain $CHAIN, $RPC)"
echo "deployer:  $DEPLOYER"
echo "balance:   $(cast from-wei "$BAL") ETH"
echo "ConfidentialPayLinks: eth_estimateGas $LINKS_EST gas -> limit $LINKS_GAS (+20%), initcode $(( (${#LINKS_INIT} - 2) / 2 )) bytes"
echo "PayLinksReader:       eth_estimateGas $READER_EST gas -> limit $READER_GAS (+20%)"
echo "budget:    $(( LINKS_GAS + READER_GAS )) gas @ 2x $(cast from-wei "$PRICE" gwei) gwei = ~$(cast from-wei "$COST") ETH"
for g in "$LINKS_GAS" "$READER_GAS"; do
  (( g < TX_CAP )) || { echo "A deploy needs $g gas, above the $TX_CAP per-transaction cap. Shrink the contract." >&2; exit 1; }
done
[[ "$OK" == 1 ]] || { echo "Balance too low: send Sepolia ETH (0.01 is plenty) to $DEPLOYER." >&2; exit 1; }
if [[ "${DRY_RUN:-}" == 1 ]]; then echo "dry run: all checks passed, not broadcasting"; exit 0; fi

deploy() { # $1 initcode, $2 gas limit -> prints "address tx"
  local out
  out=$(cast send --rpc-url "$RPC" --keystore "$ETH_KEYSTORE" --gas-limit "$2" --create "$1" --json)
  [[ "$(jq -r .status <<<"$out")" == "0x1" ]] || { echo "deploy failed: $(jq -c '{status,transactionHash,gasUsed}' <<<"$out")" >&2; exit 1; }
  echo "$(cast to-check-sum-address "$(jq -r .contractAddress <<<"$out")") $(jq -r .transactionHash <<<"$out") $(cast to-dec "$(jq -r .gasUsed <<<"$out")")"
}
read -r LINKS LINKS_TX LINKS_USED < <(deploy "$LINKS_INIT" "$LINKS_GAS")
echo "ConfidentialPayLinks $LINKS  tx $LINKS_TX  gas used $LINKS_USED"
read -r READER READER_TX READER_USED < <(deploy "$READER_INIT" "$READER_GAS")
echo "PayLinksReader       $READER  tx $READER_TX  gas used $READER_USED"
echo
echo "  $EXPLORER/tx/$LINKS_TX"
echo "  $EXPLORER/tx/$READER_TX"
echo
echo "Next:"
echo "  1. Verify (no key needed):"
echo "     forge verify-contract $LINKS src/ConfidentialPayLinks.sol:ConfidentialPayLinks --chain-id $CHAIN --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/ --constructor-args $(cast abi-encode 'f(address[])' "$TOKENS")"
echo "     forge verify-contract $READER src/PayLinksReader.sol:PayLinksReader --chain-id $CHAIN --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/"
echo "  2. Build the site with VITE_SEPOLIA_PAYLINKS=$LINKS VITE_SEPOLIA_READER=$READER (or set them in web/src/chains.ts)."
