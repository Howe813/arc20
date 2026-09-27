#!/usr/bin/env node
// arc-20 market oracle — confirms listings whose escrow the indexer validated.
// Polls the indexer API and sends InscriptionMarket.confirm(id) via `cast`.
//
// Usage:
//   ORACLE_ACCOUNT=<cast keystore name> node oracle.mjs        # keystore (recommended)
//   ORACLE_PRIVATE_KEY=0x... node oracle.mjs                   # raw key (testing only)
// Optional: API_URL (default http://localhost:3000), RPC_URL, POLL_MS.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH || path.join(DIR, "config.json"), "utf8"));

const API = process.env.API_URL || `http://localhost:${cfg.port || 3000}`;
const RPC = process.env.RPC_URL || cfg.rpcUrl;
const MARKET = cfg.marketAddress;
const POLL_MS = Number(process.env.POLL_MS || 5000);
// Liveness heartbeat: the oracle writes the current epoch-ms after every poll
// cycle. healthcheck.sh alerts if this file goes stale — that catches a process
// that is "running" per systemd but wedged (RPC hang, stuck fetch), which
// Restart=always alone cannot detect.
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(DIR, "oracle.heartbeat");
// Timeouts so one hung cast (RPC black hole) or a stalled API connection can
// never wedge the whole loop forever — a timeout is treated like any other
// failure and the next poll retries.
const CAST_TIMEOUT_MS = Number(process.env.CAST_TIMEOUT_MS || 120000);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 10000);

// Liveness vs. usefulness: `at` proves the loop is running, `lastSuccessAt`
// proves it last DID something (a cast that sent or matched its on-chain
// effect). healthcheck.sh alerts when work is pending but lastSuccessAt is
// stale — "alive but idle". Seeded to now so a fresh restart gets a grace
// window instead of an instant false alarm.
let lastSuccessAt = Date.now();

function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ at: Date.now(), lastSuccessAt }));
  } catch {
    /* non-fatal */
  }
}

const auth = process.env.ORACLE_ACCOUNT
  ? ["--account", process.env.ORACLE_ACCOUNT]
  : process.env.ORACLE_PRIVATE_KEY
    ? ["--private-key", process.env.ORACLE_PRIVATE_KEY]
    : null;
if (!auth) {
  console.error("Set ORACLE_ACCOUNT (cast keystore) or ORACLE_PRIVATE_KEY.");
  process.exit(1);
}

const confirmed = new Set(); // avoid re-sending within this process lifetime

console.log(`arc-20 oracle — market ${MARKET}, api ${API}`);
const settled = new Set(); // bid ids already settled this process lifetime

// Absolute path recommended (e.g. CAST_BIN=/usr/local/bin/cast): a bare "cast"
// depends on PATH, which systemd sandboxes (ProtectHome hides /root/.foundry).
const CAST_BIN = process.env.CAST_BIN || "cast";

// Returns true when the send landed or its on-chain effect was already in
// place (BadState = already confirmed/settled/cancelled) — i.e. real progress,
// which is what refreshes lastSuccessAt.
function castSend(args, doneSet, key, label) {
  try {
    execFileSync(CAST_BIN, ["send", MARKET, ...args, "--rpc-url", RPC, ...auth], {
      stdio: "pipe",
      timeout: CAST_TIMEOUT_MS,
    });
    doneSet.add(key);
    console.log(label);
    return true;
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (msg.includes("BadState")) {
      doneSet.add(key); // already confirmed/settled/cancelled on-chain
      return true;
    }
    console.error(`${label} failed:`, msg.slice(0, 200));
    return false;
  }
}

for (;;) {
  let didWork = false;
  try {
    const res = await fetch(`${API}/api/oracle/pending`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    const { confirmable, settleable } = await res.json();
    for (const id of confirmable) {
      if (confirmed.has(id)) continue;
      if (castSend(["confirm(uint256)", String(id)], confirmed, id, `confirmed listing ${id}`)) didWork = true;
    }
    for (const { id, seller } of settleable || []) {
      // consensus v4: `seller` is the indexer's accept-escrow owner, which is
      // the same address the market bound as pendingSeller on-chain (both come
      // from the same BidAccepted event) — so settleBid's binding check passes.
      if (settled.has(id)) continue;
      if (castSend(["settleBid(uint256,address)", String(id), seller], settled, id, `settled bid ${id} → ${seller}`))
        didWork = true;
    }
  } catch (err) {
    console.error("oracle poll error:", err.message);
  }
  if (didWork) lastSuccessAt = Date.now();
  writeHeartbeat();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
