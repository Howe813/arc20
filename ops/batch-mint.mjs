#!/usr/bin/env node
// arc-20 batch miner — one master wallet fans out to derived sub-wallets,
// funds them with gas, then each sub-wallet mines PoW nonces and mints
// (signed locally via cast, so no unlocked-node requirement).
//
// Usage:
//   node ops/batch-mint.mjs --hub 0xHub --tick mytick --key 0xMasterKey \
//     [--wallets 20] [--per-wallet 10] [--concurrency 8] \
//     [--rpc https://rpc.mainnet.arc.io] [--gas-native 0.02]
//
// The master key is ONLY used to derive sub-wallets and distribute gas;
// mining and minting happen entirely from the derived sub-wallets.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, powCheck } from "../indexer/public/keccak.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CAST = path.join(process.env.FOUNDRY_BIN || path.join(process.env.USERPROFILE || "", ".foundry", "bin"),
  process.platform === "win32" ? "cast.exe" : "cast");
const execFileP = promisify(execFile);

// ---- args ----
const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const HUB = arg("hub");
const TICK = arg("tick");
const MASTER_KEY = arg("key");
const N_WALLETS = Number(arg("wallets", "20"));
const AMOUNT = arg("amount", null);
const RPC = arg("rpc", "https://rpc.mainnet.arc.io");
const PER_WALLET = arg("per-wallet", null);
const CONC = Number(arg("concurrency", "8"));
const GAS_NATIVE = arg("gas-native", "0.02");
const COOLDOWN_MS = 30000;

if (!HUB || !TICK || !MASTER_KEY) {
  console.error("usage: node ops/batch-mint.mjs --hub 0x… --tick name --key 0x… [--wallets 20] [--per-wallet N] [--rpc url] [--gas-native 0.02]");
  process.exit(1);
}

const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tickHash = keccak256(Buffer.from(TICK, "utf8"));

// v2 preimage mining (must match the Hub exactly)
let DIFF = 20;
const mineFrom = (miner, count, from) => {
  for (let n = from; ; n++) if (powCheck(miner, tickHash, n, DIFF, count)) return n;
};

const castSend = async (args) => {
  const { stdout } = await execFileP(CAST, ["send", ...args, "--rpc-url", RPC], { encoding: "utf8", timeout: 60000 });
  // parse transactionHash from output
  const m = stdout.match(/transactionHash\s+(0x[0-9a-fA-F]+)/);
  return m ? m[1] : stdout;
};

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function receipt(h) {
  for (let i = 0; i < 120; i++) {
    const r = await rpc("eth_getTransactionReceipt", [h]);
    if (r) return r;
    await sleep(300);
  }
  throw new Error("receipt timeout: " + h);
}

async function readTickConfig() {
  const sel = "0x" + keccak256(Buffer.from("ticks(bytes32)", "utf8")).slice(2, 10);
  const ret = await rpc("eth_call", [{ to: HUB, data: sel + tickHash.slice(2) }, "latest"]);
  if (ret === "0x") throw new Error("tick not found: " + TICK);
  const word = (i) => BigInt("0x" + ret.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  return {
    maxMints: Number(word(1)),
    walletLimit: Number(word(3)),
    amountPerMint: word(4).toString(),
    difficultyBits: Number(word(5)),
  };
}

async function main() {
  console.log(`arc-20 batch miner — tick "${TICK}" @ ${RPC}`);
  const cfg = await readTickConfig();
  DIFF = cfg.difficultyBits;
  const perWallet = Number(PER_WALLET ?? cfg.walletLimit);
  const amt = AMOUNT ?? cfg.amountPerMint;
  console.log(`tick: maxMints=${cfg.maxMints} amountPerMint=${cfg.amountPerMint} walletLimit=${cfg.walletLimit} difficulty=${DIFF} bits → per wallet ${perWallet}, amount ${amt}`);

  // master wallet address
  const { stdout: master } = await execFileP(CAST, ["wallet", "address", "--private-key", MASTER_KEY]);
  const masterAddr = master.trim();
  const bal = await rpc("eth_getBalance", [masterAddr, "latest"]);
  console.log("master:", masterAddr, "balance:", (Number(BigInt(bal)) / 1e18).toFixed(4), "native");

  // derive sub-wallets deterministically: keccak(masterKeyBytes ++ index)
  const keyBytes = Buffer.from(MASTER_KEY.replace(/^0x/, ""), "hex");
  const wallets = [];
  for (let i = 0; i < N_WALLETS; i++) {
    const derived = keccak256(Buffer.concat([keyBytes, Buffer.from([i])]));
    const pk = "0x" + derived.replace(/^0x/, "");
    const { stdout: addrOut } = await execFileP(CAST, ["wallet", "address", "--private-key", pk]);
    wallets.push({ i, pk, addr: addrOut.trim(), mined: 0 });
  }
  console.log(`derived ${wallets.length} sub-wallets`);

  // distribute gas (master → each sub-wallet, serial via cast)
  const gasHex = "0x" + BigInt(Math.round(Number(GAS_NATIVE) * 1e18)).toString(16);
  for (const w of wallets) {
    await castSend([w.addr, "--value", gasHex, "--private-key", MASTER_KEY]);
  }
  console.log("gas distribution sent:", GAS_NATIVE, "native each");
  await sleep(2000);

  // mining + minting via cast send (locally signed by each sub-wallet's key)
  const state = new Map();
  const mineAndMint = async (w) => {
    const s = state.get(w.addr) || (state.set(w.addr, { count: 0, floor: 0 }), state.get(w.addr));
    let n = s.floor;
    while (!powCheck(w.addr, tickHash, n, DIFF, s.count)) n++;
    const data = hex(`data:,{"p":"arc-20","op":"mint","tick":"${TICK}","amt":"${amt}","nonce":"${n}"}`);
    const h = await castSend([HUB, data, "--private-key", w.pk]);
    const r = await receipt(h);
    if (r.status === "0x1") { s.count += 1; s.floor = n + 1; return true; }
    s.floor = n + 1;
    return false;
  };

  let total = 0;
  const t0 = Date.now();
  const TIMEOUT = 30 * 60 * 1000;
  let consecutiveFails = 0;
  while (total < perWallet * wallets.length && Date.now() - t0 < TIMEOUT) {
    const active = wallets.filter((w) => w.mined < perWallet);
    if (!active.length) break;
    const batch = active.slice(0, CONC);
    const results = await Promise.all(batch.map(async (w) => {
      try {
        const ok = await mineAndMint(w);
        if (ok) { w.mined++; total++; consecutiveFails = 0; return true; }
        consecutiveFails++;
        return false;
      } catch (e) {
        console.log(`✗ ${w.addr.slice(0, 10)}… ${String(e.message || e).slice(0, 80)}`);
        return false;
      }
    }));
    if (results.some(Boolean)) {
      console.log(`progress: ${total}/${perWallet * wallets.length} minted (${active.filter((w) => w.mined < perWallet).length} wallets still active)`);
    } else {
      console.log(`all ${batch.length} failed (consecutive: ${consecutiveFails}) — waiting 10s…`);
      await sleep(10000);
      if (consecutiveFails > 6) {
        console.log("too many consecutive failures — check difficulty/gas/chain and retry");
        break;
      }
    }
  }

  console.log(`\nDONE — ${total} minted across ${wallets.length} wallets in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
