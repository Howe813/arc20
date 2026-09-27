#!/usr/bin/env bash
# Health check for the arc-20 stack. Alerts (exit 1 + optional webhook) when:
#   - the indexer API is down
#   - the indexer has fallen too far behind the chain head (stuck/crashed scan)
#   - the oracle systemd service is not active
#   - there are confirmable listings / settleable bids piling up (oracle stalled)
# Run from cron every minute:
#   * * * * * /opt/arc20/ops/healthcheck.sh || curl -s -X POST "$SLACK_WEBHOOK" ...
set -uo pipefail

API="${API:-http://127.0.0.1:3000}"
RPC="${RPC:-https://rpc.mainnet.arc.io}"
MAX_LAG="${MAX_LAG:-30}"          # blocks behind head before alerting
MAX_PENDING="${MAX_PENDING:-25}"  # confirmable+settleable backlog before alerting
WEBHOOK="${WEBHOOK:-}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-/opt/arc20/indexer/oracle.heartbeat}"
MAX_HEARTBEAT_AGE="${MAX_HEARTBEAT_AGE:-90}"   # seconds since oracle last looped
MAX_IDLE="${MAX_IDLE:-300}"                    # seconds without a SUCCESSFUL send while work is pending
ORACLE_ADDR="${ORACLE_ADDR:-}"                 # oracle hot wallet; set to enable gas check
MIN_GAS_WEI="${MIN_GAS_WEI:-5000000000000000}" # 0.005 USDC — alert when oracle can't pay gas

fail() { echo "UNHEALTHY: $1"; [ -n "$WEBHOOK" ] && curl -s -X POST -H 'content-type: application/json' -d "{\"text\":\"arc-20 UNHEALTHY: $1\"}" "$WEBHOOK" >/dev/null 2>&1; exit 1; }

status="$(curl -sf --max-time 8 "$API/api/status")" || fail "indexer API down"
lastBlock="$(echo "$status" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).lastBlock))')"

head_hex="$(curl -sf --max-time 8 -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).result))')" || fail "RPC unreachable"
head=$((head_hex))
lag=$((head - lastBlock))
[ "$lag" -gt "$MAX_LAG" ] && fail "indexer lag $lag blocks (head $head, indexed $lastBlock)"

if command -v systemctl >/dev/null; then
  systemctl is-active --quiet arc20-oracle || fail "oracle service not active"
fi

pending="$(curl -sf --max-time 8 "$API/api/oracle/pending" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.confirmable?.length||0)+(j.settleable?.length||0))})')" || pending=0
[ "$pending" -gt "$MAX_PENDING" ] && fail "oracle backlog: $pending pending (confirm+settle) — oracle stalled?"

# Oracle heartbeat freshness — catches a wedged (running-but-not-looping) oracle
# that systemd's Restart=always cannot see. The heartbeat is a JSON object
# { at, lastSuccessAt }; a bare epoch-ms number is the LEGACY format, in which
# case the idle check below is skipped (success time unknown).
hb_age="n/a"
success_age="n/a"
if [ -f "$HEARTBEAT_FILE" ]; then
  read -r hb_ms success_ms <<<"$(node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8").trim();
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") {
        console.log(Number(j.at || 0), Number(j.lastSuccessAt || 0));
      } else {
        // LEGACY bare epoch-ms heartbeat (a valid JSON number): liveness only
        console.log(Number(j) || 0, 0);
      }
    } catch {
      console.log(0, 0); // unreadable heartbeat counts as stale
    }
  ' "$HEARTBEAT_FILE" 2>/dev/null || echo "0 0")"
  now_ms=$(( $(date +%s) * 1000 ))
  hb_age=$(( (now_ms - ${hb_ms:-0}) / 1000 ))
  [ "$hb_age" -gt "$MAX_HEARTBEAT_AGE" ] && fail "oracle heartbeat stale (${hb_age}s > ${MAX_HEARTBEAT_AGE}s) — oracle wedged?"
  if [ "${success_ms:-0}" -gt 0 ]; then
    success_age=$(( (now_ms - success_ms) / 1000 ))
  fi
else
  fail "oracle heartbeat file missing ($HEARTBEAT_FILE) — oracle not running?"
fi

# Alive but idle: work is pending while the oracle has had no successful send
# for a while — the signature of a broken key/RPC that plain liveness misses.
# (Only fires when lastSuccessAt is known, i.e. the JSON heartbeat format.)
if [ "$pending" -gt 0 ] && [ "$success_age" != "n/a" ] && [ "$success_age" -gt "$MAX_IDLE" ]; then
  fail "oracle idle: $pending pending but last successful send ${success_age}s ago (> ${MAX_IDLE}s) — broken key/RPC?"
fi

# Oracle wallet gas balance — an out-of-gas oracle fails silently (tx never lands).
gas="skip"
if [ -z "$ORACLE_ADDR" ]; then
  echo "WARN: ORACLE_ADDR not set — gas balance check skipped (set it to enable)"
elif command -v cast >/dev/null; then
  bal="$(cast balance "$ORACLE_ADDR" --rpc-url "$RPC" 2>/dev/null)" || bal=""
  if [ -n "$bal" ]; then
    gas="$bal"
    # bash can't compare 18-digit wei natively; use node for the big-int compare
    low="$(node -e "process.stdout.write(BigInt('$bal') < BigInt('$MIN_GAS_WEI') ? '1':'0')" 2>/dev/null || echo 0)"
    [ "$low" = "1" ] && fail "oracle wallet low on gas: $bal wei < $MIN_GAS_WEI (top up $ORACLE_ADDR)"
  fi
fi

echo "OK  head=$head indexed=$lastBlock lag=$lag pending=$pending hb=${hb_age}s idle=${success_age}s gas=$gas"
