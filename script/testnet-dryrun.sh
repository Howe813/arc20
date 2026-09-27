#!/usr/bin/env bash
# Arc testnet (chain 5042002, gas = USDC, faucet https://faucet.circle.com) end-to-end dry-run.
# Deploys Hub+Market (incl. a PoW fair-launch tick), seeds ticks + real on-chain
# mined mints/listings/buys/sweep from throwaway wallets, and writes
# indexer/testnet-config.json. The deployer is owner+operator.
# Requires a funded deployer key (a few testnet USDC is plenty).
# NOTE: mint/listing prices are scaled down 10x for the testnet budget
#       (arc mint = 0.0001 USDC here; mainnet launch uses 0.001).
#
# Usage:
#   KEYFILE=/path/to/testnet-deployer.key bash script/testnet-dryrun.sh
set -euo pipefail

RPC="${RPC:-https://rpc.testnet.arc.io}"
KEYFILE="${KEYFILE:?set KEYFILE to the deployer private-key file}"
KEY="$(cat "$KEYFILE")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_CHAIN=5042002
EXPLORER="https://explorer.testnet.arc.io"
POW_DIFF=4 # testnet PoW difficulty: ~16 hashes per mint
cd "$ROOT"

cast chain-id --rpc-url "$RPC" | grep -qx "$EXPECTED_CHAIN" || { echo "✗ RPC chain-id mismatch, expected $EXPECTED_CHAIN (Arc testnet)"; exit 1; }
DEPLOYER="$(cast wallet address --private-key "$KEY")"
echo "▸ deployer / owner / operator: $DEPLOYER"
echo "▸ balance: $(cast to-unit "$(cast balance "$DEPLOYER" --rpc-url "$RPC")" ether) USDC"
echo

send() { cast send --rpc-url "$RPC" --private-key "$1" --json "${@:2}" \
  | node -e 'process.stdin.on("data",d=>{const r=JSON.parse(d);console.error("  tx "+r.transactionHash+"  block "+parseInt(r.blockNumber)+"  status "+r.status)})'; }
hexdata() { node -e 'console.log("0x"+Buffer.from(process.argv[1],"utf8").toString("hex"))' "$1"; }

echo "== 1. deploy contracts =="
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
HUB="$(forge create src/InscriptionHub.sol:InscriptionHub --rpc-url "$RPC" --private-key "$KEY" --broadcast 2>&1 | grep -i "Deployed to:" | awk '{print $3}')"
echo "  InscriptionHub:    $HUB"
MARKET="$(forge create src/InscriptionMarket.sol:InscriptionMarket --rpc-url "$RPC" --private-key "$KEY" --broadcast --constructor-args "$DEPLOYER" "$DEPLOYER" 2>&1 | grep -i "Deployed to:" | awk '{print $3}')"
echo "  InscriptionMarket: $MARKET"
[ -n "$HUB" ] && [ -n "$MARKET" ] || { echo "deploy failed"; exit 1; }
echo

echo "== 2. PoW genesis ticks =="
send "$KEY" "$HUB" "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" arc 21000 1000 10 $POW_DIFF 21000 600  # whole-supply epoch
send "$KEY" "$HUB" "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" test 100 500 20 $POW_DIFF 100 600
send "$KEY" "$HUB" "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" mine 100 500 20 $POW_DIFF 100 600     # flagship fair launch
echo

echo "== 3. fund two test wallets =="
S1_KEY="$(cast wallet new --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0].private_key))')"
S2_KEY="$(cast wallet new --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0].private_key))')"
S1="$(cast wallet address --private-key "$S1_KEY")"; S2="$(cast wallet address --private-key "$S2_KEY")"
send "$KEY" "$S1" --value 0.002ether
send "$KEY" "$S2" --value 0.002ether
echo "  wallet A: $S1"
echo "  wallet B: $S2"
echo

echo "== 4. mined mints (free, nonce must meet difficulty $POW_DIFF bits) =="
MINE_POW() { # mine a nonce for $1 (miner address) against tick $2 with amt $3, echo hex calldata
  node -e '
    import("./indexer/public/keccak.mjs").then(({ keccak256, powCheck }) => {
      const [miner, tick, amt] = process.argv.slice(1);
      const diff = Number(process.argv[4]);
      const th = keccak256(Buffer.from(tick, "utf8"));
      for (let n = 0; ; n++) if (powCheck(miner, th, n, diff)) {
        console.log("0x" + Buffer.from(`data:,{"p":"arc-20","op":"mint","tick":"${tick}","amt":"${amt}","nonce":"${n}"}`, "utf8").toString("hex"));
        return;
      }
    });
  ' "$1" "$2" "$3" "$POW_DIFF"
}
for i in 1 2 3; do send "$S1_KEY" "$HUB" "$(MINE_POW "$S1" arc 1000)"; done  # A: 3x arc -> 3000
for i in 1 2;   do send "$S2_KEY" "$HUB" "$(MINE_POW "$S2" arc 1000)"; done  # B: 2x arc -> 2000
send "$S1_KEY" "$HUB" "$(MINE_POW "$S1" test 500)"                            # A: 1x test -> 500
send "$S1_KEY" "$HUB" "$(MINE_POW "$S1" mine 500)"                            # A mines 1x mine -> 500
send "$S2_KEY" "$HUB" "$(MINE_POW "$S2" mine 500)"                            # B mines 1x mine -> 500
echo

echo "== 5. listings + operator confirm =="
send "$S1_KEY" "$MARKET" "$(hexdata 'data:,{"p":"arc-20","op":"list","tick":"arc","amt":"1000","price":"200000000000000"}')"  # id1 0.0002
send "$S2_KEY" "$MARKET" "$(hexdata 'data:,{"p":"arc-20","op":"list","tick":"arc","amt":"1000","price":"180000000000000"}')"  # id2 0.00018
send "$KEY" "$MARKET" "confirm(uint256)" 1
send "$KEY" "$MARKET" "confirm(uint256)" 2
echo

echo "== 6. buy single + sweep (real USDC) =="
# deployer buys cheapest single (id2 0.00018): +5% = 0.000189
send "$KEY" "$MARKET" "buy(uint256)" 2 --value 189000000000000
# two more listings, then sweep both in one tx
send "$S1_KEY" "$MARKET" "$(hexdata 'data:,{"p":"arc-20","op":"list","tick":"arc","amt":"1000","price":"150000000000000"}')"  # id3 0.00015
send "$S2_KEY" "$MARKET" "$(hexdata 'data:,{"p":"arc-20","op":"list","tick":"arc","amt":"1000","price":"160000000000000"}')"  # id4 0.00016
send "$KEY" "$MARKET" "confirm(uint256)" 3
send "$KEY" "$MARKET" "confirm(uint256)" 4
# sweep id3+id4: (0.00015+0.00016)*1.05 = 0.0003255
send "$KEY" "$MARKET" "sweep(uint256[])" "[3,4]" --value 325500000000000
echo

echo "== 6b. bids: place -> accept -> settle, and place -> cancel =="
# deployer bids to buy 1000 arc @ 0.0001 (escrow +5% = 0.000105)
send "$KEY" "$MARKET" "placeBid(string,uint128,uint128)" arc 1000 100000000000000 --value 105000000000000  # bid 1
# wallet A (holds arc) accepts by sending the accept inscription to the bidder (deployer)
send "$S1_KEY" "$DEPLOYER" "$(hexdata 'data:,{"p":"arc-20","op":"accept","tick":"arc","bid":"1"}')"
# operator (deployer) settles bid 1 to wallet A → A paid, deployer credited the arc in the ledger
send "$KEY" "$MARKET" "settleBid(uint256,address)" 1 "$S1"
# place bid 2 and cancel it (full refund)
send "$KEY" "$MARKET" "placeBid(string,uint128,uint128)" arc 500 80000000000000 --value 84000000000000  # bid 2
send "$KEY" "$MARKET" "cancelBid(uint256)" 2
echo

echo "== 7. write indexer/testnet-config.json =="
cat > indexer/testnet-config.json <<EOF
{
  "_comment": "Arc testnet (chain 5042002). Auto-written by script/testnet-dryrun.sh.",
  "rpcUrl": "$RPC",
  "chainId": $EXPECTED_CHAIN,
  "explorerApi": "$EXPLORER/api",
  "hubAddress": "$HUB",
  "marketAddress": "$MARKET",
  "deployBlock": $START_BLOCK,
  "confirmations": 2,
  "batchBlocks": 500,
  "pollMs": 3000,
  "port": 3000,
  "stateFile": "testnet-state.json",
  "eventsFile": "testnet-events.jsonl"
}
EOF
echo "  wrote indexer/testnet-config.json (deployBlock $START_BLOCK)"
echo
echo "✅ dry-run txs submitted."
echo "   Hub    $EXPLORER/address/$HUB"
echo "   Market $EXPLORER/address/$MARKET"
