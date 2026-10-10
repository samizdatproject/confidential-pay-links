#!/usr/bin/env bash
# Local demo chain: anvil + the cleartext FHEVM host contracts (via forge-fhevm) + ConfidentialPayLinks + a test
# ERC-20 and its ERC-7984 wrapper. Writes web/.env.development.local so `npm run dev` and `npm run e2e` find the contracts.
#
#   scripts/local-chain.sh            # starts anvil on :8545 if nothing is listening, then deploys
#   KEEP_ANVIL=1 scripts/local-chain.sh   # leave anvil running after the script exits (default: it keeps running)
#
# Uses only well-known anvil dev keys. Never point this at a real network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0
export PATH="$HOME/.foundry/bin:$PATH"

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Starting anvil on $RPC"
  nohup anvil --silent --port "${RPC##*:}" >/tmp/confidential-pay-links-anvil.log 2>&1 &
  for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
fi
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "Refusing: $RPC is not a local 31337 chain" >&2; exit 1; }

cd "$ROOT/contracts"
forge build >/dev/null 2>&1
# forge-fhevm's deploy-local.sh reads artifacts from its own out/; point it at ours (script/LocalFhevmHost.sol makes
# forge build emit the host contracts, including the CleartextFHEVMExecutor).
FF="$(ls -d dependencies/forge-fhevm-* | head -1)"
ln -sfn "$ROOT/contracts/out" "$FF/out"
if [ "$(cast code 0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D --rpc-url "$RPC")" = "0x" ]; then
  (cd "$FF" && RPC_URL="$RPC" ./deploy-local.sh --skip-build)
fi

forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEV_KEY" >/dev/null
RUN=broadcast/Deploy.s.sol/31337/run-latest.json
addr() { jq -r --arg n "$1" '[.transactions[] | select(.contractName == $n)][0].contractAddress' "$RUN"; }
LINKS=$(cast to-check-sum-address "$(addr ConfidentialPayLinks)")
USD=$(cast to-check-sum-address "$(addr MockUSD)")
CUSD=$(cast to-check-sum-address "$(addr MockConfidentialUSD)")
cat >"$ROOT/web/.env.development.local" <<ENV
# Written by scripts/local-chain.sh — local anvil only.
VITE_LOCAL_PAYLINKS=$LINKS
VITE_LOCAL_TOKEN=$CUSD
VITE_LOCAL_UNDERLYING=$USD
ENV
echo "ConfidentialPayLinks $LINKS"
echo "MockUSD              $USD"
echo "MockConfidentialUSD  $CUSD"
echo "Wrote web/.env.development.local. Next: cd web && npm run dev   (or npm run e2e)"
