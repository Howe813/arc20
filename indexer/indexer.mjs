#!/usr/bin/env node
// arc-20 platform indexer — canonical accounting for all ticks (see ../PROTOCOL.md)
// Zero dependencies; requires Node 18+ (built-in fetch).
//
// Usage:
//   node indexer.mjs            # scan continuously + serve HTTP API / web app
//   node indexer.mjs --once     # catch up to (head - confirmations), then exit
//   RPC_URL=... node indexer.mjs

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { keccak256, powCheck } from "./public/keccak.mjs";
const execFileP = promisify(execFile);

// The mainnet Blockscout host fingerprints/blocks Node's TLS ClientHello (both undici
// and node:https get RST / connect-timeout), while system curl passes. Route explorer
// reads through curl so holders/price metrics work on mainnet. Falls back to fetch if
// curl is unavailable. RPC/IPFS stay on fetch (those hosts don't block Node).
async function explorerJson(url, timeoutSec = 8) {
  try {
    const { stdout } = await execFileP("curl", ["-sS", "--max-time", String(timeoutSec), url], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutSec * 1000) });
    return r.json();
  }
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(DIR, "config.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || cfg.rpcUrl;
const HUB = cfg.hubAddress.toLowerCase();
const MARKET = cfg.marketAddress.toLowerCase();
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
// Memes launchpad factory (optional). When set, TokenLaunched events are indexed
// into state.coins and served at /api/memes; the address is exposed via /api/status.
const LAUNCHPAD = (cfg.launchpadAddress || ZERO_ADDR).toLowerCase();
// Token addresses to hide from /api/memes (e.g. internal test launches). The
// deploy-time verification seed is a standalone TaxedToken with no TokenLaunched
// event, so it never needs listing here.
const EXCLUDED_TOKENS = new Set((cfg.excludedTokens || []).map((a) => String(a).toLowerCase()));
// Shared V4TaxHook — its V4TaxCollected events give per-coin trade volume.
const HOOK = (cfg.hookAddress || ZERO_ADDR).toLowerCase();
// v4 pool price for live market-cap: read Slot0 straight from the PoolManager via
// extsload (StateView is just a wrapper and isn't reliably deployed here). WETH for
// the price side; explorer API for holder counts.
const POOL_MANAGER = (cfg.poolManager || ZERO_ADDR).toLowerCase();
const STATE_VIEW = (cfg.stateView || ZERO_ADDR).toLowerCase(); // legacy fallback
const WETH_ADDR = (cfg.weth || ZERO_ADDR).toLowerCase();
const EXPLORER_API = (cfg.explorerApi || "").replace(/\/$/, "");
// Addresses the single eth_getLogs sweep watches (zero/unset ones are dropped).
const SCAN_ADDRESSES = [HUB, MARKET, LAUNCHPAD, HOOK].filter((a) => a && a !== ZERO_ADDR);
// Inscriptions live in tx calldata (not logs), so they need every block fetched.
// Launchpad-only deployments (Hub+Market unset) can fast-path off eth_getLogs alone.
const INSCRIPTION_MODE = HUB !== ZERO_ADDR || MARKET !== ZERO_ADDR;
const STATE_PATH = path.resolve(DIR, cfg.stateFile || "state.json");
const EVENTS_PATH = path.resolve(DIR, cfg.eventsFile || "events.jsonl");
// Memes coin avatars are pinned to IPFS; the ipfs:// URI lives on-chain in the
// TokenLaunched event. The server can pin uploads via Pinata (PINATA_JWT) at
// /api/memes/pin, and rewrites ipfs:// to an HTTP gateway for the frontend.
const PINATA_JWT = process.env.PINATA_JWT || cfg.pinataJwt || "";
// Gateway used to build the http URL the FRONTEND <img> loads (our pins live on Pinata's gateway).
const IPFS_GATEWAY = (cfg.ipfsGateway || "https://gateway.pinata.cloud/ipfs/").replace(/\/?$/, "/");
// Gateways the SERVER tries (in order) when fetching metadata JSON — ipfs.io alone is too slow/flaky.
const IPFS_FETCH_GATEWAYS = (cfg.ipfsFetchGateways || [
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
]).map((g) => g.replace(/\/?$/, "/"));
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ipfsToHttp = (uri) =>
  typeof uri === "string" && uri.startsWith("ipfs://") ? IPFS_GATEWAY + uri.slice(7) : uri || null;

// Fetch an ipfs:// (or http) resource, trying each gateway until one responds.
async function fetchIpfs(uri, timeoutMs = 12000) {
  const cid = typeof uri === "string" && uri.startsWith("ipfs://") ? uri.slice(7) : null;
  const urls = cid ? IPFS_FETCH_GATEWAYS.map((g) => g + cid) : [uri];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return r;
    } catch {}
  }
  return null;
}
const CONFIRMATIONS = cfg.confirmations ?? 10;
const BATCH_BLOCKS = cfg.batchBlocks ?? 50;
const POLL_MS = cfg.pollMs ?? 3000;
const ENRICH_MS = Number(process.env.ENRICH_MS || 30000); // R16 enrichment cadence
const ONCE = process.argv.includes("--once");

// ---- arc-20 canonical forms ----
const TRANSFER_RE = /^data:,\{"p":"arc-20","op":"transfer","tick":"([a-z0-9]{1,8})","amt":"([1-9][0-9]{0,29})"\}$/;
const transferReceiptCache = new Map(); // tx.hash -> receipt (per-block, R16 receipt prefetch)
// op: accept is settled from the on-chain BidAccepted event since consensus v4;
// the legacy top-level calldata form is no longer part of the protocol.
// PoW mint form (on Hub calldata): amt matches amountPerMint (≤1e15), nonce 0..~2^132
const POW_MINT_RE = /^data:,\{"p":"arc-20","op":"mint","tick":"([a-z0-9]{1,8})","amt":"([1-9][0-9]{0,15})","nonce":"(0|[1-9][0-9]{0,39})"\}$/;

// event topic0 hashes (keccak256 of the signatures)
const T = {
  // Deployed(bytes32,address,string,uint64,uint128,uint32,uint8,uint32,uint32)
  Deployed: "0xb363d8386f269238977c02b7c22d41532ebac836321276f1618a677889f77947",
  Inscribed: "0xb83539c9454f41c8e951a8f786ba40870336cc9626d2775eea08db544f8c4ff5", // Inscribed(bytes32,address,uint64)
  // DifficultyRetargeted(bytes32,uint8)
  Retargeted: "0x855cb69ac03e2e5ea58de03bb8868d67bd2369b3e2ee67ff6f0f70cef075860e",
  Listed: "0x1844ca806b7e864dab5b4dcbe58d1a20b9047271da99368429ac5e0d82d7f720", // Listed(uint256,address,bytes32,string,uint256,uint256)
  Confirmed: "0xc13332a43e47b855337e607df3246f6827921cb8d114a3e933ec50107c72ca3d", // ListingConfirmed(uint256)
  Bought: "0xc54c8cc1c7525b424ec71b685c00d9355581a280488018c22005332ceb2fd406", // Bought(uint256,address)
  Cancelled: "0xc41d93b8bfbf9fd7cf5bfe271fd649ab6a6fec0ea101c23b82a2a28eca2533a9", // Cancelled(uint256)
  BidPlaced: "0xfaaf78085e2c2d821322f054efd5ee566d92fe1cbae9123a42ec9abf5169f998", // BidPlaced(uint256,address,bytes32,string,uint256,uint256)
  BidAccepted: "0xe8a61bd9439ac4bfa096185a4f13c80aee27dea8ca39d854e5ce829005297a3c", // BidAccepted(uint256,address,bytes32)
  BidFilled: "0xccaaec2a776da8d0eeb5f11e4d2be4d028082e9b5077028a178f921e92480abf", // BidFilled(uint256,address)
  BidCancelled: "0xc1546e394b1975212fe013e7e6995653585f44e568c407d1157483f7d4b94581", // BidCancelled(uint256)
  // TokenLaunched(address creator, address token, address baseAsset, address treasury, bytes32 poolId, uint24 fee, int24 tickSpacing, uint160 sqrtPriceX96, uint256 openingVirtualMarketCap, string imageURI)
  TokenLaunched: "0x4adf842742a001089c1b1320a9ae19e68569c50d433251fb61bf5bd37f6817d0",
  // V4TaxCollected(bytes32 poolId, address token, address sender, bool isBuy, uint256 grossAmount, uint256 taxAmount)
  V4TaxCollected: "0x5227059ceacf82773e91b09376ff0299d82a787e48b2b02403a727a797d89db9",
};

// ---- state ----
function freshState() {
  return {
    lastBlock: cfg.deployBlock - 1,
    lastBlockHash: null, // parent-hash continuity check (reorg detection)
    // ticks[tick] = {tickHash, deployer, maxMints, amountPerMint, walletLimit, mintPriceWei, totalMints, deployTx, deployBlock}
    ticks: {},
    tickByHash: {}, // tickHash -> tick
    balances: {}, // balances[tick][addr] = string
    mintsOf: {}, // mintsOf[tick][addr] = number — journal-derived (R15), rebuilt on boot, not snapshotted
    eventsOffset: 0, // R15: bytes of events.jsonl covered by this snapshot (byte-offset rewind)
    mintTimes: {}, // mintTimes[tick] = [epochMs, ...] newest-first, last 64 (mint-rate ETA)
    // listings[id] = {seller, tick, amt, price, chainStatus: pending|active|sold|cancelled,
    //                 escrow: valid|invalid|released, buyer?, listTx, block}
    listings: {},
    // bids[id] = {bidder, tick, amt, price, chainStatus: open|filled|cancelled,
    //             escrow: none|valid|released, accepter?, seller?, placeTx, block}
    bids: {},
    recentMints: [], // [{tick, n, minter, tx, block}]
    recentTrades: [], // [{id, tick, amt, price, seller, buyer, tx, block}] most-recent-first
    recentActivity: [], // unified feed: [{type, tick, ..., block, tx}] most-recent-first
    invalidTransfers: 0,
    // Memes launchpad: coins[tokenAddr] = {token, creator, name, symbol, treasury, poolId, image, tx, block, ts}
    coins: {},
    coinOrder: [], // token addresses, launch order (most-recent-first when served)
  };
}

let state;
// bumped once per scan batch / state reload; API caches (perTickMarket) key
// off it. Declared BEFORE reloadFromCheckpoint, which bumps it during early
// module init.
let ledgerEpoch = 0;
let mktCache = { epoch: -1, value: null };

/// Rewind to the last durable checkpoint: reload state.json and drop any
/// events.jsonl lines past it. Called at startup AND after a mid-batch scan
/// error, so a partially-applied block in memory (or a partially-logged batch
/// on disk) can never double-apply or duplicate events on the next attempt.
function reloadFromCheckpoint() {
  state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : freshState();
  // Backfill any top-level fields added since the checkpoint was written, so a
  // code upgrade that introduces new state (e.g. bids) can't crash on load.
  for (const [k, v] of Object.entries(freshState())) {
    if (state[k] === undefined) state[k] = v;
  }
  ledgerEpoch++; // state replaced wholesale — drop per-batch API caches
  // R15 byte-offset rewind (O(1), replaces the old full-file re-read+parse):
  // any journal bytes beyond the checkpointed offset belong to blocks AFTER
  // state.lastBlock (crash mid-append) — truncate them and let the scanner
  // re-emit those events. Old snapshots without eventsOffset are left alone
  // so an upgrade never throws away history it cannot account for.
  if (typeof state.eventsOffset === "number") {
    const cur = journalSize();
    if (cur > state.eventsOffset) {
      fs.truncateSync(EVENTS_PATH, state.eventsOffset);
      console.error(`rewound journal tail to checkpoint (dropped ${cur - state.eventsOffset} uncheckpointed bytes)`);
    }
  }
  // mintsOf is rebuilt from the journal right after this call (see main):
  state.mintsOf = {};
}
reloadFromCheckpoint();

let journalSeq = -1; // highest archived events-<seq>.jsonl segment (refreshed by journalSegments)

function saveState() {
  writeSnapshot();
  maybeRotateJournal();
}

function journalSize() {
  try { return fs.statSync(EVENTS_PATH).size; } catch { return 0; }
}

// R15 persistence model: events.jsonl is the incremental journal; state.json
// is a snapshot of the ACTIVE ledger only (mintsOf stripped — it is rebuilt
// from the journal on boot) plus `eventsOffset`, the journal byte length the
// snapshot covers. Recovery = load snapshot + truncate the journal tail back
// to eventsOffset (O(1) — the uncheckpointed tail is simply re-scanned).
function writeSnapshot() {
  const snap = { ...state, eventsOffset: journalSize() };
  delete snap.mintsOf; // journal-derived; rebuilt by rebuildMintsOfFromJournal()
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

const JOURNAL_ROTATE_BYTES = Number(cfg.eventsRotateBytes || 64 * 1024 * 1024);

function journalSegments() {
  // oldest→newest: archived segments (events-<seq>.jsonl) then the live file
  const dir = path.dirname(EVENTS_PATH);
  const segs = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^events-(\d+)\.jsonl$/);
    if (m) segs.push({ seq: Number(m[1]), file: f });
  }
  segs.sort((a, b) => a.seq - b.seq);
  if (segs.length) journalSeq = Math.max(journalSeq, segs[segs.length - 1].seq);
  return [...segs.map((x) => path.join(dir, x.file)), EVENTS_PATH];
}

function maybeRotateJournal() {
  const size = journalSize();
  if (size < JOURNAL_ROTATE_BYTES) return;
  journalSegments(); // refresh journalSeq from any existing archives
  const seq = ++journalSeq;
  const arch = path.join(path.dirname(EVENTS_PATH), `events-${seq}.jsonl`);
  try {
    fs.renameSync(EVENTS_PATH, arch);
  } catch {
    return;
  }
  writeSnapshot(); // re-point eventsOffset at the fresh (empty) live journal
  console.error(`journal rotated → ${path.basename(arch)} (${size} bytes); offset reset to 0`);
}

// Bounded memory: terminal orders (sold/cancelled) accumulate forever in the
// in-memory book. Keep the latest 2000 of each kind; the full history stays
// in events.jsonl (/api/trades) and a full re-scan rebuilds everything.
function pruneTerminalOrders() {
  const KEEP = 2000;
  const prune = (src, terminalKinds) => {
    const terminal = Object.entries(src)
      .filter(([, o]) => o.chainStatus === terminalKinds[0] || o.chainStatus === terminalKinds[1])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const excess = terminal.length - KEEP;
    for (let k = 0; k < excess; k++) delete src[terminal[k][0]];
  };
  prune(state.listings, ["sold", "cancelled"]);
  prune(state.bids, ["filled", "cancelled"]);
}

// R15: mintsOf is journal-derived — aggregated from every op:"mint" line
// (multi-segment aware). Called once during boot, before the server starts.
async function rebuildMintsOfFromJournal() {
  state.mintsOf = {};
  for (const seg of journalSegments()) {
    if (!fs.existsSync(seg)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(seg), crlfDelay: Infinity });
    for await (const line of rl) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.op !== "mint" || !e.tick || !e.minter) continue;
      (state.mintsOf[e.tick] ??= {});
      state.mintsOf[e.tick][e.minter] = (state.mintsOf[e.tick][e.minter] || 0) + 1;
    }
  }
}
const logEvent = (ev) => fs.appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n");

function pushActivity(item) {
  state.recentActivity.unshift(item);
  if (state.recentActivity.length > 300) state.recentActivity.pop();
}
// running per-tick volume + trade count (persisted), for discovery sorting
function addVolume(tick, priceWei) {
  const t = state.ticks[tick];
  if (!t) return;
  t.volumeWei = (BigInt(t.volumeWei || "0") + BigInt(priceWei)).toString();
  t.tradeCount = (t.tradeCount || 0) + 1;
}

// ---- JSON-RPC ----
let rpcId = 0;
async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (res.status === 429) throw new Error("rate limited");
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  } catch (err) {
    if (attempt >= 6) throw err;
    await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 15000)));
    return rpc(method, params, attempt + 1);
  }
}

const hexToNum = (h) => Number(BigInt(h));
const hexToBig = (h) => BigInt(h);
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64); // i-th 32-byte word of event data

function decodeAbiString(data, offsetWordIdx) {
  const off = Number(BigInt("0x" + word(data, offsetWordIdx)));
  const lenWord = data.slice(2 + off * 2, 2 + off * 2 + 64);
  const len = Number(BigInt("0x" + lenWord));
  const strHex = data.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2);
  return Buffer.from(strHex, "hex").toString("utf8");
}

function decodeUtf8(inputHex) {
  if (!inputHex || inputHex === "0x") return "";
  return Buffer.from(inputHex.slice(2), "hex").toString("utf8");
}

// ---- Memes coin avatars ----
// Detect a supported image by magic bytes (never trust a client-supplied mime).
function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp";
  return null;
}
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

function bal(tick, addr) {
  return BigInt(state.balances[tick]?.[addr] || "0");
}
// NOTE: the 100%-mined trade gate was removed per user request — the market is
// open from block one. Sellers can list/bid-accept as soon as they have mined
// balance. The balance check below is the only escrow gate.
function setBal(tick, addr, v) {
  state.balances[tick] ??= {};
  if (v === 0n) delete state.balances[tick][addr];
  else state.balances[tick][addr] = v.toString();
}

// ---- settlement rules (PROTOCOL.md) ----

// R16 decode-failure isolation: one malformed/truncated log used to throw,
// trip the scan-error path, get re-fetched next round and throw again — a
// deterministic decode error would wedge the scanner forever (the rpc()
// backoff only covers transport failures). Now the raw log is dumped to a
// forensic file and the entry is skipped; fatal() consensus stops still exit.
function applyLog(log, txHash, blockNum, blockTs) {
  try {
    applyLogInner(log, txHash, blockNum, blockTs);
  } catch (err) {
    try {
      fs.appendFileSync(path.join(path.dirname(EVENTS_PATH), "forensic-decode.log"), JSON.stringify({
        ts: new Date().toISOString(), where: "applyLog", error: String(err && err.message || err),
        tx: txHash, block: blockNum, log: { address: log.address, topics: log.topics, data: log.data },
      }) + "\n");
    } catch {}
    console.error(`decode failed for a log at block ${blockNum} — dumped to forensic-decode.log and skipped: ${err.message}`);
  }
}

function applyLogInner(log, txHash, blockNum, blockTs) {
  const addr = log.address.toLowerCase();
  const topic0 = log.topics[0];

  if (addr === HUB && topic0 === T.Deployed) {
    const tickHash = log.topics[1].toLowerCase();
    const deployer = topicAddr(log.topics[2]);
    const tick = decodeAbiString(log.data, 0);
    const maxMints = Number(BigInt("0x" + word(log.data, 1)));
    const amountPerMint = BigInt("0x" + word(log.data, 2)).toString();
    const walletLimit = Number(BigInt("0x" + word(log.data, 3)));
    const difficultyBits = Number(BigInt("0x" + word(log.data, 4)));
    const epochMints = Number(BigInt("0x" + word(log.data, 5)));
    const epochTargetSeconds = Number(BigInt("0x" + word(log.data, 6)));
    state.ticks[tick] = {
      tickHash, deployer, maxMints, amountPerMint, walletLimit, mintPriceWei: "0",
      totalMints: 0, volumeWei: "0", tradeCount: 0, deployTx: txHash, deployBlock: blockNum,
      pow: { difficultyBits, epochMints, epochTargetSeconds, epochMinted: 0, epochStart: blockTs },
    };
    state.tickByHash[tickHash] = tick;
    pushActivity({ type: "deploy", tick, actor: deployer, tx: txHash, block: blockNum });
    logEvent({ op: "deploy", tick, deployer, maxMints, amountPerMint, walletLimit, difficultyBits, epochMints, epochTargetSeconds, tx: txHash, block: blockNum });
    return;
  }

  if (addr === HUB && topic0 === T.Retargeted) {
    const tick = state.tickByHash[log.topics[1].toLowerCase()];
    if (!tick) return fatal(`DifficultyRetargeted for unknown tickHash ${log.topics[1]} at ${txHash}`);
    const difficultyBits = Number(BigInt(log.data === "0x" ? "0x0" : log.data));
    // The contract checks the epoch-filling mint's hash against the PRE-retarget
    // difficulty and only then emits this event — remember the old value so
    // verifyPowMint (same tx) validates against what the miner actually needed.
    retargetOldDiff.set(tick, state.ticks[tick].pow.difficultyBits);
    state.ticks[tick].pow.difficultyBits = difficultyBits;
    logEvent({ op: "retarget", tick, difficultyBits, tx: txHash, block: blockNum });
    return;
  }

  if (addr === HUB && topic0 === T.Inscribed) {
    const tick = state.tickByHash[log.topics[1].toLowerCase()];
    if (!tick) return fatal(`Inscribed for unknown tickHash ${log.topics[1]} at ${txHash}`);
    const minter = topicAddr(log.topics[2]);
    const n = Number(BigInt(log.data === "0x" ? "0x0" : log.data));
    const t = state.ticks[tick];
    if (n > t.maxMints) return fatal(`tick ${tick} over-minted (${n} > ${t.maxMints}) at ${txHash}`);
    t.totalMints = Math.max(t.totalMints, n);
    // per-tick mint timestamps (newest first, bounded window) → sold-out ETA
    const mt = (state.mintTimes[tick] ??= []);
    mt.unshift(blockTs);
    if (mt.length > 64) mt.pop();
    if (t.totalMints >= t.maxMints && !t.soldOutAt) {
      // first time 100% minted: record when + emit a discoverable soldout
      // activity/event (display-only — no trade gating, PROTOCOL.md)
      t.soldOutAt = blockTs || null;
      t.soldOutBlock = blockNum;
      pushActivity({ type: "soldout", tick, actor: minter, n, tx: txHash, block: blockNum });
      logEvent({ op: "soldout", tick, n, tx: txHash, block: blockNum });
    }
    state.mintsOf[tick] ??= {};
    state.mintsOf[tick][minter] = (state.mintsOf[tick][minter] || 0) + 1;
    setBal(tick, minter, bal(tick, minter) + BigInt(t.amountPerMint));
    state.recentMints.unshift({ tick, n, minter, tx: txHash, block: blockNum, ts: blockTs });
    if (state.recentMints.length > 100) state.recentMints.pop();
    pushActivity({ type: "mint", tick, n, actor: minter, amt: t.amountPerMint, tx: txHash, block: blockNum });
    logEvent({ op: "mint", tick, n, minter, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && topic0 === T.Listed) {
    const id = BigInt(log.topics[1]).toString();
    const seller = topicAddr(log.topics[2]);
    const tick = state.tickByHash[log.topics[3].toLowerCase()];
    const amt = BigInt("0x" + word(log.data, 1));
    const price = BigInt("0x" + word(log.data, 2)).toString();
    // escrow check: unknown tick or insufficient balance -> invalid
    let escrow = "invalid";
    if (tick && bal(tick, seller) >= amt) {
      setBal(tick, seller, bal(tick, seller) - amt);
      escrow = "valid";
    }
    state.listings[id] = {
      seller, tick: tick || null, amt: amt.toString(), price,
      chainStatus: "pending", escrow, listTx: txHash, block: blockNum,
    };
    if (tick) pushActivity({ type: "list", tick, id: Number(id), actor: seller, amt: amt.toString(), price, tx: txHash, block: blockNum });
    logEvent({ op: "list", id, seller, tick, amt: amt.toString(), price, escrow, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && (topic0 === T.Confirmed || topic0 === T.Bought || topic0 === T.Cancelled)) {
    const id = BigInt(log.topics[1]).toString();
    const l = state.listings[id];
    if (!l) return fatal(`market event for unknown listing ${id} at ${txHash}`);

    if (topic0 === T.Confirmed) {
      l.chainStatus = "active";
      if (l.escrow !== "valid") console.error(`WARNING: operator confirmed listing ${id} with ${l.escrow} escrow`);
    } else if (topic0 === T.Bought) {
      const buyer = topicAddr(log.topics[2]);
      l.chainStatus = "sold";
      l.buyer = buyer;
      l.soldTx = txHash;
      l.soldBlock = blockNum;
      if (l.escrow === "valid") {
        setBal(l.tick, buyer, bal(l.tick, buyer) + BigInt(l.amt));
        l.escrow = "released";
      } else {
        console.error(`CRITICAL: listing ${id} sold without valid escrow — buyer ${buyer} received nothing`);
      }
      if (l.tick) {
        state.recentTrades.unshift({
          id: Number(id), tick: l.tick, amt: l.amt, price: l.price,
          seller: l.seller, buyer, tx: txHash, block: blockNum, ts: blockTs,
        });
        if (state.recentTrades.length > 500) state.recentTrades.pop();
        addVolume(l.tick, l.price);
        pushActivity({ type: "trade", tick: l.tick, id: Number(id), actor: buyer, seller: l.seller, amt: l.amt, price: l.price, tx: txHash, block: blockNum });
        // standardized full trade event for /api/trades replay (R7): the old
        // op:"sold" line carried only the id/status, not the trade itself
        logEvent({ op: "trade", id, kind: "ask", tick: l.tick, amt: l.amt, price: l.price, seller: l.seller, buyer, tx: txHash, block: blockNum });
      }
    } else {
      l.chainStatus = "cancelled";
      if (l.escrow === "valid") {
        setBal(l.tick, l.seller, bal(l.tick, l.seller) + BigInt(l.amt));
        l.escrow = "released";
      }
    }
    logEvent({ op: l.chainStatus, id, tx: txHash, block: blockNum });
    return;
  }

  // ---- bids (buy orders) ----
  if (addr === MARKET && topic0 === T.BidPlaced) {
    const id = BigInt(log.topics[1]).toString();
    const bidder = topicAddr(log.topics[2]);
    const tick = decodeAbiString(log.data, 0); // first non-indexed arg is `string tick`
    const amt = BigInt("0x" + word(log.data, 1)).toString();
    const price = BigInt("0x" + word(log.data, 2)).toString();
    state.bids[id] = {
      bidder, tick, amt, price, chainStatus: "open", escrow: "none",
      accepter: null, placeTx: txHash, block: blockNum,
    };
    if (state.ticks[tick]) pushActivity({ type: "bid", tick, id: Number(id), actor: bidder, amt, price, tx: txHash, block: blockNum });
    logEvent({ op: "bid", id, bidder, tick, amt, price, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && topic0 === T.BidAccepted) {
    // consensus v4: the seller sends the accept inscription to the MARKET; the
    // contract binds bids[id].pendingSeller first-come-first-served and emits
    // this event (the on-chain delivery proof). The event fires only for Open,
    // unbound bids — settlement can pay this seller and nobody else. The
    // ledger-level escrow check (balance only — no sold-out gate) stays ours.
    const id = BigInt(log.topics[1]).toString();
    const seller = topicAddr(log.topics[2]);
    const b = state.bids[id];
    if (!b) return fatal(`BidAccepted for unknown bid ${id} at ${txHash}`);
    if (b.chainStatus !== "open" || b.escrow === "valid") {
      return fatal(`BidAccepted for non-open/already-bound bid ${id} at ${txHash}`);
    }
    const amt = BigInt(b.amt);
    if (bal(b.tick, seller) < amt) {
      // bound on-chain but rejected by the ledger — surfaced via API so the
      // frontend can show "bound but gated / waiting for the buyer to cancel"
      // instead of letting another seller burn gas on a doomed accept
      b.boundInvalid = seller;
      logEvent({ op: "accept", valid: false, reason: "insufficient-balance", bid: id, seller, tx: txHash, block: blockNum });
      return;
    }
    setBal(b.tick, seller, bal(b.tick, seller) - amt); // escrow the seller's inscription
    b.accepter = seller;
    b.escrow = "valid";
    logEvent({ op: "accept", valid: true, bid: id, seller, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && (topic0 === T.BidFilled || topic0 === T.BidCancelled)) {
    const id = BigInt(log.topics[1]).toString();
    const b = state.bids[id];
    if (!b) return fatal(`bid event for unknown bid ${id} at ${txHash}`);
    if (topic0 === T.BidFilled) {
      const seller = topicAddr(log.topics[2]);
      b.chainStatus = "filled";
      b.seller = seller;
      b.filledTx = txHash;
      b.filledBlock = blockNum;
      // the accepter's escrowed inscription is delivered to the bidder
      if (b.escrow === "valid" && b.tick) {
        setBal(b.tick, b.bidder, bal(b.tick, b.bidder) + BigInt(b.amt));
        b.escrow = "released";
        state.recentTrades.unshift({
          id: Number(id), kind: "bid", tick: b.tick, amt: b.amt, price: b.price,
          seller, buyer: b.bidder, tx: txHash, block: blockNum, ts: blockTs,
        });
        if (state.recentTrades.length > 500) state.recentTrades.pop();
        addVolume(b.tick, b.price);
        pushActivity({ type: "trade", tick: b.tick, id: Number(id), kind: "bid", actor: b.bidder, seller, amt: b.amt, price: b.price, tx: txHash, block: blockNum });
        // standardized full trade event for /api/trades replay (R7)
        logEvent({ op: "trade", id, kind: "bid", tick: b.tick, amt: b.amt, price: b.price, seller, buyer: b.bidder, tx: txHash, block: blockNum });
      } else {
        console.error(`CRITICAL: bid ${id} settled without valid accept escrow — seller ${seller} paid, buyer got nothing`);
      }
    } else {
      b.chainStatus = "cancelled";
      // release any pending accept escrow back to the accepter
      if (b.escrow === "valid" && b.tick && b.accepter) {
        setBal(b.tick, b.accepter, bal(b.tick, b.accepter) + BigInt(b.amt));
        b.escrow = "released";
      }
    }
    logEvent({ op: "bid-" + b.chainStatus, id, tx: txHash, block: blockNum });
  }

  // ---- Memes launchpad: a new coin was fair-launched ----
  if (addr === LAUNCHPAD && topic0 === T.TokenLaunched) {
    const token = topicAddr(log.topics[2]);
    if (state.coins[token]) return; // idempotent
    const creator = topicAddr(log.topics[1]);
    const treasury = "0x" + word(log.data, 1).slice(24); // data word 1 = treasury
    const poolId = "0x" + word(log.data, 2); // data word 2 = poolId (bytes32)
    // data word 7 = offset to the on-chain URI string (points to a metadata JSON, or a bare image for older launches)
    let metadataURI = "";
    try { metadataURI = decodeAbiString(log.data, 7); } catch {}
    state.coins[token] = {
      token, creator, treasury, poolId, metadataURI,
      image: null, twitter: null, website: null, telegram: null, metaResolved: false,
      name: null, symbol: null, // enriched via eth_call / IPFS after the scan batch
      volumeWei: "0", trades: 0, // accumulated from V4TaxCollected
      mcapWei: null, holders: null, metricsAt: 0, // refreshed periodically
      tx: txHash, block: blockNum, ts: blockTs,
    };
    state.coinOrder.push(token);
    pushActivity({ type: "launch", token, creator, tx: txHash, block: blockNum });
    logEvent({ op: "launch", token, creator, tx: txHash, block: blockNum });
  }

  // ---- Memes launchpad: a taxed swap → accumulate trade volume ----
  if (addr === HOOK && topic0 === T.V4TaxCollected) {
    const token = topicAddr(log.topics[2]); // indexed token
    const coin = state.coins[token];
    if (!coin) return; // volume only tracked for coins we know
    const grossAmount = BigInt("0x" + word(log.data, 1)); // data word 1 = grossAmount (WETH)
    coin.volumeWei = (BigInt(coin.volumeWei || "0") + grossAmount).toString();
    coin.trades = (coin.trades || 0) + 1;
  }
}

function fatal(msg) {
  console.error("FATAL:", msg);
  // Do NOT overwrite the canonical checkpoint: fatal() can fire mid-block (from
  // applyLog, after some txs of the block already mutated state but before
  // lastBlock advances). saveState() here would persist a partially-applied
  // block and, on restart, that block would be re-applied → double-counted.
  // Keep state.json at the last CLEAN block-boundary checkpoint; write a
  // forensic snapshot separately for debugging.
  try { fs.writeFileSync(STATE_PATH + ".corrupt", JSON.stringify(state, null, 2)); } catch { /* best effort */ }
  process.exit(1);
}

/// op: transfer — top-level calldata inscription to any non-system address.
/// `knownSuccess` skips the receipt fetch when the tx already proved success
/// (it emitted Hub/Market logs). op: accept is NOT scanned here anymore: since
/// consensus v4 it is an inscription to the MARKET that binds pendingSeller
/// on-chain and is settled from the BidAccepted event (see applyLog).
async function applyTransfer(tx, blockNum, knownSuccess) {
  const to = tx.to ? tx.to.toLowerCase() : null;
  if (to === null || to === HUB || to === MARKET) return;
  const text = decodeUtf8(tx.input ?? tx.data ?? "0x");
  const mt = TRANSFER_RE.exec(text);
  if (!mt) return;

  const from = tx.from.toLowerCase();
  const ensureSuccess = async () => {
    if (knownSuccess) return true;
    // R16: block-scoped prefetch cache first; a miss falls back to a direct
    // RPC fetch (bounded by the caller's own flow).
    let receipt = transferReceiptCache.get(tx.hash);
    if (!receipt) {
      try { receipt = await rpc("eth_getTransactionReceipt", [tx.hash]); } catch { receipt = null; }
      if (receipt) transferReceiptCache.set(tx.hash, receipt);
    }
    return receipt && receipt.status === "0x1";
  };

  const [, tick, amtStr] = mt;
  if (!state.ticks[tick]) return;
  if (!(await ensureSuccess())) return;
  const amt = BigInt(amtStr);
  if (bal(tick, from) < amt) {
    state.invalidTransfers += 1;
    logEvent({ op: "transfer", valid: false, tick, from, to, amt: amtStr, tx: tx.hash, block: blockNum });
    return;
  }
  setBal(tick, from, bal(tick, from) - amt);
  setBal(tick, to, bal(tick, to) + amt);
  logEvent({ op: "transfer", valid: true, tick, from, to, amt: amtStr, tx: tx.hash, block: blockNum });
}

/// Independent PoW verification: when a successful mint tx to the Hub carried a
/// PoW mint inscription, recompute keccak256(miner, tickHash, nonce, mintsOf)
/// and enforce the tick's current difficulty from the indexer's own state. A
/// mismatch means the contract and this indexer disagree on PoW rules — a
/// consensus bug — so stop instead of quietly trusting the ledger. Only EOA
/// mints reach here (contract callers revert on-chain), so
/// tx.from == msg.sender == tx.origin.
const retargetOldDiff = new Map(); // tick -> difficulty in force before this tx's retarget
function verifyPowMint(tx, txLogs) {
  const text = decodeUtf8(tx.input ?? tx.data ?? "0x");
  const m = POW_MINT_RE.exec(text);
  if (!m) return;
  const [, tick, , nonceStr] = m;
  const t = state.ticks[tick];
  if (!t || !t.pow) return; // such a mint reverts on an unknown tick — no log, nothing to verify
  const th = t.tickHash;
  const minted = txLogs.some((lg) => lg.topics[0] === T.Inscribed && lg.topics[1].toLowerCase() === th);
  if (!minted) return; // failed tx — on-chain state unchanged
  // the epoch-filling mint was hashed against the pre-retarget difficulty
  const d = retargetOldDiff.has(tick) ? retargetOldDiff.get(tick) : t.pow.difficultyBits;
  retargetOldDiff.delete(tick);
  // consensus v2: the PRE-mint count is part of the preimage (InscriptionHub
  // hashes mintsOf[th][miner] as uint64 big-endian). verifyPowMint runs AFTER
  // applyLog applied this tx's Inscribed event, which already incremented
  // mintsOf — so the count the contract hashed against is (current - 1).
  const from = tx.from.toLowerCase();
  const count = (state.mintsOf[tick]?.[from] ?? 0) - 1;
  if (!Number.isSafeInteger(count) || count < 0) {
    fatal(`PoW verification failed: mint count underflow for ${tick}/${from} at ${tx.hash}`);
  }
  if (!powCheck(from, th, BigInt(nonceStr), d, count)) {
    fatal(`PoW verification failed: tick ${tick} nonce ${nonceStr} below difficulty ${d} (miner count ${count}) at ${tx.hash}`);
  }
}

async function scanToTarget() {
  const head = hexToNum(await rpc("eth_blockNumber", []));
  const target = head - CONFIRMATIONS;
  while (state.lastBlock < target) {
    const from = state.lastBlock + 1;
    const to = Math.min(from + BATCH_BLOCKS - 1, target);

    // ONE eth_getLogs per batch captures every Hub/Market event regardless of
    // call path (direct tx, Safe/factory internal call, contract wrapper) —
    // logs only exist for successful txs, so no receipt checks are needed.
    const logs = await rpc("eth_getLogs", [
      { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: SCAN_ADDRESSES },
    ]);
    const logsByBlockTx = new Map(); // blockNum -> txIndex -> [logs in logIndex order]
    for (const lg of logs) {
      const b = hexToNum(lg.blockNumber);
      const ti = hexToNum(lg.transactionIndex);
      if (!logsByBlockTx.has(b)) logsByBlockTx.set(b, new Map());
      const byTx = logsByBlockTx.get(b);
      if (!byTx.has(ti)) byTx.set(ti, []);
      byTx.get(ti).push(lg);
    }
    for (const byTx of logsByBlockTx.values()) {
      for (const arr of byTx.values()) arr.sort((x, y) => hexToNum(x.logIndex) - hexToNum(y.logIndex));
    }

    const CONC = cfg.blockConcurrency ?? 20;
    if (!INSCRIPTION_MODE) {
      // Launchpad-only fast path: skip empty blocks entirely. Only blocks with logs
      // matter; fetch just their timestamps and apply logs in order. (No hash-chain
      // reorg check here — enable inscription mode for that.)
      const blocksWithLogs = [...logsByBlockTx.keys()].sort((a, b) => a - b);
      const tsByBlock = new Map();
      for (let i = 0; i < blocksWithLogs.length; i += CONC) {
        const chunk = blocksWithLogs.slice(i, i + CONC);
        const blks = await Promise.all(
          chunk.map((bn) => rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]))
        );
        chunk.forEach((bn, k) => { if (blks[k]) tsByBlock.set(bn, hexToNum(blks[k].timestamp)); });
      }
      for (const bn of blocksWithLogs) {
        const byTx = logsByBlockTx.get(bn);
        const blockTs = tsByBlock.get(bn) ?? 0;
        for (const ti of [...byTx.keys()].sort((a, b) => a - b)) {
          for (const lg of byTx.get(ti)) applyLog(lg, lg.transactionHash, bn, blockTs);
        }
      }
      state.lastBlock = to;
    } else {
      // Inscription mode: fetch every block (transfer/accept inscriptions live in
      // tx calldata, not logs) CONCURRENTLY, then APPLY strictly in order so the
      // ledger stays deterministic. Also chains block hashes for reorg detection.
      for (let base = from; base <= to; base += CONC) {
        const end = Math.min(base + CONC - 1, to);
        const cnt = end - base + 1;
        const blks = await Promise.all(
          Array.from({ length: cnt }, (_, k) => rpc("eth_getBlockByNumber", ["0x" + (base + k).toString(16), true]))
        );
        for (let k = 0; k < cnt; k++) {
          const b = base + k;
          const block = blks[k];
          if (!block) throw new Error(`block ${b} not available`);
          if (state.lastBlockHash && block.parentHash.toLowerCase() !== state.lastBlockHash) {
            fatal(
              `reorg detected at block ${b} (parentHash mismatch). ` +
                `Delete state.json and events.jsonl, then restart to replay from genesis (deterministic).`
            );
          }
          const byTx = logsByBlockTx.get(b);
          const blockTs = hexToNum(block.timestamp); // unix seconds, for trade time-ranges
          // R16: prefetch receipts for transfer-inscription candidates in this block
          // with bounded concurrency (8) — sequential per-tx awaits used to stretch
          // catch-up scans O(transfers).
          transferReceiptCache.clear();
          const candTx = block.transactions.filter((tx) => {
            const to = tx.to ? tx.to.toLowerCase() : null;
            if (to === null || to === HUB || to === MARKET) return false;
            return TRANSFER_RE.test(decodeUtf8(tx.input ?? tx.data ?? "0x"));
          });
          for (let ci = 0; ci < candTx.length; ci += 8) {
            await Promise.all(candTx.slice(ci, ci + 8).map(async (tx) => {
              try {
                const r = await rpc("eth_getTransactionReceipt", [tx.hash]);
                if (r) transferReceiptCache.set(tx.hash, r);
              } catch { /* ensureSuccess falls back to a direct fetch */ }
            }));
          }
          for (const tx of block.transactions) {
            const txLogs = byTx?.get(hexToNum(tx.transactionIndex));
            if (txLogs) for (const lg of txLogs) applyLog(lg, tx.hash, b, blockTs);
            // a tx can also be a top-level transfer inscription (mutually exclusive
            // with system-contract logs in practice; both applied deterministically)
            await applyTransfer(tx, b, Boolean(txLogs));
            // independent re-check of PoW mints (after events applied: retargets land first)
            if (txLogs && tx.to && tx.to.toLowerCase() === HUB) verifyPowMint(tx, txLogs);
          }
          state.lastBlock = b;
          state.lastBlockHash = block.hash.toLowerCase();
        }
      }
    }
    pruneTerminalOrders(); // R15: bound in-memory terminal orders (full history stays in the journal)
    saveState();
    maybeRotateJournal();
    ledgerEpoch++; // scan batch done: per-request caches (perTickMarket) are stale
    console.log(`scanned to ${state.lastBlock}/${target} — coins ${Object.keys(state.coins).length}`);
    sseBroadcast(state.lastBlock);
  }
}

// ---- HTTP API + web app ----
const sseClients = new Set();
function sseBroadcast(block) {
  for (const res of sseClients) {
    try {
      res.write(`data: ${block}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// One pass over listings+bids → floor / listedCount / bidCount / topBid per tick.
function perTickMarket() {
  const m = {};
  const get = (t) => (m[t] ??= { listedCount: 0, bidCount: 0, floor: null, topBid: null });
  const cheaper = (a, b) => BigInt(a.price) * BigInt(b.amt) < BigInt(b.price) * BigInt(a.amt);
  for (const l of Object.values(state.listings)) {
    if (l.chainStatus !== "active" || !l.tick) continue;
    const e = get(l.tick);
    e.listedCount++;
    if (!e.floor || cheaper(l, e.floor)) e.floor = { price: l.price, amt: l.amt };
  }
  for (const b of Object.values(state.bids)) {
    if (b.chainStatus !== "open" || !b.tick) continue;
    const e = get(b.tick);
    e.bidCount++;
    if (!e.topBid || cheaper(e.topBid, b)) e.topBid = { price: b.price, amt: b.amt };
  }
  return m;
}

const tradeCache = new Map(); // "tick|addr" -> { stamp, matched, total, size } — bounded, request-level

/// Stream the WHOLE journal (archive segments + live file, oldest→newest)
/// LINE-BY-LINE and collect the standardized trade events (op:"trade", emitted
/// for ask buys and bid settlements since R7). Memory holds only the matches;
/// files are never loaded whole. A request-level cache keyed on every segment's
/// mtime+size skips the rescan while all segments are unchanged (My-page
/// polling would otherwise sweep the whole journal on every refresh).
async function streamTrades({ tick, addr }) {
  const segs = journalSegments();
  const stampParts = [];
  let scannedBytes = 0;
  for (const f of segs) {
    try {
      const st = fs.statSync(f);
      stampParts.push(`${path.basename(f)}:${st.size}:${st.mtimeMs}`);
      scannedBytes += st.size;
    } catch {
      stampParts.push(`${path.basename(f)}:gone`);
    }
  }
  const stamp = stampParts.join("|");
  const key = `${tick || "*"}|${addr || "*"}`;
  const hit = tradeCache.get(key);
  if (hit && hit.stamp === stamp) return { trades: hit.matched, total: hit.total, scannedBytes: hit.size };
  const matched = [];
  for (const f of segs) {
    if (!fs.existsSync(f)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      let e;
      try { e = JSON.parse(line); } catch { continue; } // tolerate a torn final line
      if (!e || e.op !== "trade") continue;
      if (tick && e.tick !== tick) continue;
      if (addr && e.buyer !== addr && e.seller !== addr) continue;
      matched.push(e);
    }
  }
  tradeCache.set(key, { stamp, matched, total: matched.length, size: scannedBytes });
  if (tradeCache.size > 64) tradeCache.delete(tradeCache.keys().next().value);
  return { trades: matched, total: matched.length, scannedBytes };
}

/// O(all listings + bids). API fan-out (every /api/ticks request) must not
/// re-walk the whole book, so the result is cached per scan batch and
/// invalidated whenever the ledger advances (ledgerEpoch++).
function perTickMarketCached() {
  if (mktCache.epoch !== ledgerEpoch || !mktCache.value) {
    mktCache = { epoch: ledgerEpoch, value: perTickMarket() };
  }
  return mktCache.value;
}

function tickSummary(tick, mkt) {
  const t = state.ticks[tick];
  const e = (mkt && mkt[tick]) || {};
  // mint-rate ETA: mints/second over the recent timestamp window
  // (null = fewer than 2 samples or zero span — not enough data)
  const mt = state.mintTimes[tick] || [];
  const mintRate = mt.length >= 2 && mt[0] > mt[mt.length - 1]
    ? (mt.length - 1) / (mt[0] - mt[mt.length - 1])
    : null;
  const etaSeconds = mintRate != null && t.totalMints < t.maxMints
    ? Math.round((t.maxMints - t.totalMints) / mintRate)
    : null;
  return {
    tick, ...t,
    holders: Object.keys(state.balances[tick] || {}).length,
    soldOut: t.totalMints >= t.maxMints,
    soldOutAt: t.soldOutAt || null,
    soldOutBlock: t.soldOutBlock ?? null,
    mintRate,
    mintSamples: mt.length,
    etaSeconds,
    volumeWei: t.volumeWei || "0",
    tradeCount: t.tradeCount || 0,
    floor: e.floor || null,
    topBid: e.topBid || null,
    listedCount: e.listedCount || 0,
    bidCount: e.bidCount || 0,
    // PoW ticks: current difficulty + expected hashes per mint (2^difficultyBits)
    pow: t.pow
      ? { ...t.pow, expectedTries: (1n << BigInt(t.pow.difficultyBits)).toString() }
      : null,
  };
}

/// Exchange-style order book for one tick: active sell orders (asks) sorted by
/// unit price (price/amt) ascending, with cumulative depth, plus recent trades
/// and summary stats. Unit-price ordering is exact via BigInt cross-multiply.
function marketBook(tick) {
  const asks = Object.entries(state.listings)
    .filter(([, l]) => l.tick === tick && l.chainStatus === "active")
    .map(([id, l]) => ({ id: Number(id), seller: l.seller, amt: l.amt, price: l.price, listTx: l.listTx, block: l.block }));
  asks.sort((a, b) => {
    const l = BigInt(a.price) * BigInt(b.amt);
    const r = BigInt(b.price) * BigInt(a.amt);
    return l < r ? -1 : l > r ? 1 : a.id - b.id;
  });
  let cum = 0n;
  for (const a of asks) {
    cum += BigInt(a.amt);
    a.cumAmt = cum.toString();
  }
  // open bids (buy orders), best (highest unit price) first
  const bids = Object.entries(state.bids)
    .filter(([, b]) => b.tick === tick && b.chainStatus === "open")
    .map(([id, b]) => ({ id: Number(id), bidder: b.bidder, amt: b.amt, price: b.price, escrow: b.escrow, accepter: b.accepter || null, boundInvalid: b.boundInvalid || null }));
  bids.sort((a, b) => {
    const l = BigInt(a.price) * BigInt(b.amt);
    const r = BigInt(b.price) * BigInt(a.amt);
    return l > r ? -1 : l < r ? 1 : a.id - b.id;
  });
  let bidCum = 0n;
  for (const bd of bids) {
    bidCum += BigInt(bd.amt);
    bd.cumAmt = bidCum.toString();
  }

  const trades = state.recentTrades.filter((t) => t.tick === tick).slice(0, 400);
  return {
    tick,
    asks,
    bids,
    trades,
    listedCount: asks.length,
    bidCount: bids.length,
    totalForSale: cum.toString(),
    totalBidAmt: bidCum.toString(),
    floor: asks[0] ? { price: asks[0].price, amt: asks[0].amt } : null,
    topBid: bids[0] ? { price: bids[0].price, amt: bids[0].amt } : null,
    last: trades[0] ? { price: trades[0].price, amt: trades[0].amt } : null,
  };
}

const TICK_RE = /^[a-z0-9]{1,8}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

// Pin a base64 image (validated by magic bytes) to IPFS via Pinata, return its ipfs:// URI.
function pinAvatar(req, res, json) {
  if (!PINATA_JWT) return json(503, { error: "image pinning not configured (set PINATA_JWT)" });
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_AVATAR_BYTES * 2) req.destroy(); // base64 is ~1.33x the raw bytes
    else chunks.push(c);
  });
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const buf = Buffer.from(String(body.dataB64 || ""), "base64");
      const ext = detectImage(buf);
      if (!ext) return json(400, { error: "unsupported image (png/jpg/gif/webp only)" });
      if (buf.length > MAX_AVATAR_BYTES) return json(400, { error: "image too large (max 5MB)" });
      const form = new FormData();
      form.append("file", new Blob([buf], { type: IMG_MIME[ext] }), "avatar." + ext);
      const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: { authorization: "Bearer " + PINATA_JWT },
        body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.IpfsHash) return json(502, { error: "pin failed" });
      json(200, { cid: j.IpfsHash, ipfs: "ipfs://" + j.IpfsHash, url: IPFS_GATEWAY + j.IpfsHash });
    } catch (e) {
      json(400, { error: "bad pin request" });
    }
  });
  req.on("error", () => { try { json(400, { error: "upload error" }); } catch {} });
}

// Pin a small metadata JSON object to IPFS via Pinata.
function pinMetadataJson(req, res, json) {
  if (!PINATA_JWT) return json(503, { error: "pinning not configured (set PINATA_JWT)" });
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > 64 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const obj = body.json;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json(400, { error: "missing json object" });
      const r = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: { authorization: "Bearer " + PINATA_JWT, "content-type": "application/json" },
        body: JSON.stringify({ pinataContent: obj }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.IpfsHash) return json(502, { error: "pin failed" });
      json(200, { cid: j.IpfsHash, ipfs: "ipfs://" + j.IpfsHash, url: IPFS_GATEWAY + j.IpfsHash });
    } catch (e) {
      json(400, { error: "bad json pin" });
    }
  });
  req.on("error", () => { try { json(400, { error: "upload error" }); } catch {} });
}

function startServer() {
  const pub = path.join(DIR, "public");
  // Never let a request kill the process — the scanner lives here too.
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      try {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"bad request"}');
      } catch {}
    }
  });
  server.on("clientError", (err, socket) => socket.destroy());

  function handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    // CORS: same-origin echo only (the web app is served from this very origin)
    // — never `*`, so foreign pages cannot read the API cross-origin.
    const corsOrigin = () => {
      const o = req.headers.origin;
      if (!o) return null;
      try {
        return new URL(o).host === (req.headers.host || "") ? o : null;
      } catch {
        return null;
      }
    };
    const json = (code, obj) => {
      const headers = { "content-type": "application/json" };
      const co = corsOrigin();
      if (co) headers["access-control-allow-origin"] = co;
      res.writeHead(code, headers);
      res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") {
      const headers = {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-pin-token",
      };
      const co = corsOrigin();
      if (co) headers["access-control-allow-origin"] = co;
      res.writeHead(204, headers);
      return res.end();
    }
    const p = url.pathname;

    // ---- pin endpoints spend the OPERATOR's Pinata quota: guard them ----
    // A cross-site page can fire a "simple request" (text/plain body, no CORS
    // preflight) at localhost:3000 from any visitor's browser, so both pin
    // endpoints require: (a) a same-origin request (Origin header matching the
    // Host) — or, for server-to-server callers, the PIN_TOKEN shared secret —
    // and (b) an application/json content-type.
    if (req.method === "POST" && (p === "/api/memes/pin" || p === "/api/memes/pin-json")) {
      const token = process.env.PIN_TOKEN || cfg.pinToken || "";
      const o = req.headers.origin;
      let sameOrigin = false;
      if (o) {
        try {
          sameOrigin = new URL(o).host === (req.headers.host || "");
        } catch {}
      }
      // Semantics: same-origin is ALWAYS allowed (the web UI keeps working);
      // setting PIN_TOKEN does not lock browsers out — it additionally unlocks
      // cross-origin server-to-server callers presenting the shared secret.
      if (!(sameOrigin || (token && req.headers["x-pin-token"] === token))) {
        return json(403, { error: "pin rejected: same-origin request or valid x-pin-token required" });
      }
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        return json(415, { error: "pin rejected: content-type must be application/json" });
      }
    }

    // ---- Memes avatar: pin an uploaded image to IPFS, return its ipfs:// URI ----
    if (req.method === "POST" && p === "/api/memes/pin") {
      return pinAvatar(req, res, json);
    }
    // ---- Memes metadata: pin a coin's metadata JSON (image + socials) to IPFS ----
    if (req.method === "POST" && p === "/api/memes/pin-json") {
      return pinMetadataJson(req, res, json);
    }

    if (p === "/api/status") {
      // 24h mining heat, bounded by the recentMints window (latest 100 mints)
      const cutoff = Math.floor(Date.now() / 1000) - 86400;
      const recent24 = state.recentMints.filter((m) => (m.ts || 0) >= cutoff);
      const activeMiners = new Set(recent24.map((m) => m.minter)).size;
      json(200, {
        hub: HUB, market: MARKET,
        launchpad: LAUNCHPAD === ZERO_ADDR ? null : LAUNCHPAD,
        lastBlock: state.lastBlock,
        tickCount: Object.keys(state.ticks).length, recentMints: state.recentMints.slice(0, 30),
        coinCount: Object.keys(state.coins).filter((t) => !EXCLUDED_TOKENS.has(t)).length,
        mints24h: recent24.length, activeMiners24h: activeMiners,
        // machine-readable honesty marker: the 24h figures are computed over
        // the bounded recentMints window, so they are a LOWER BOUND whenever
        // the window is saturated (aligned with /api/activity windowed:true)
        mints24hWindow: state.recentMints.length, mints24hWindowed: true,
      });
    } else if (p === "/api/memes") {
      // Fair-launched coins, most-recent first. Paginated: the response must
      // not grow without bound as coins launch.
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const coins = state.coinOrder
        .slice().reverse()
        .map((t) => state.coins[t])
        .filter(Boolean)
        .filter((c) => !EXCLUDED_TOKENS.has(c.token))
        .map((c) => ({
          token: c.token, name: c.name, symbol: c.symbol, creator: c.creator,
          treasury: c.treasury, poolId: c.poolId, tx: c.tx, block: c.block, ts: c.ts,
          image: c.image || null, // ipfs:// image URI (resolved from the on-chain metadata)
          imageUrl: ipfsToHttp(c.image), // gateway URL for direct <img> use
          twitter: c.twitter || null, website: c.website || null, telegram: c.telegram || null,
          mcapWei: c.mcapWei || null, volumeWei: c.volumeWei || "0", holders: c.holders ?? null, trades: c.trades || 0,
        }));
      json(200, { launchpad: LAUNCHPAD === ZERO_ADDR ? null : LAUNCHPAD, ethUsd, coins: coins.slice(offset, offset + limit), total: coins.length, offset, limit });
    } else if (p === "/api/ticks") {
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const mkt = perTickMarketCached(); // cached per scan batch — see perTickMarketCached
      const all = Object.keys(state.ticks).map((t) => tickSummary(t, mkt)).sort((a, b) => b.deployBlock - a.deployBlock);
      json(200, { ticks: all.slice(offset, offset + limit), total: all.length, offset, limit });
    } else if (p === "/api/activity") {
      const type = url.searchParams.get("type");
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
      const filtered = state.recentActivity.filter((a) => !type || a.type === type);
      // total semantics: count within the in-memory WINDOW (latest 300
      // activity events) — NOT all history. windowed:true tells the frontend
      // older records exist via /api/trades + events.jsonl instead.
      json(200, { activity: filtered.slice(offset, offset + limit), total: filtered.length, windowed: true });
    } else if (p === "/api/trades") {
      // Full paginated trade replay from events.jsonl (streamed line-by-line).
      const tickF = url.searchParams.get("tick");
      const addrF = (url.searchParams.get("addr") || "").toLowerCase();
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
      streamTrades({ tick: tickF, addr: addrF })
        .then(({ trades, total, scannedBytes }) => {
          // newest-first presentation over the oldest→newest file order
          json(200, { trades: trades.slice().reverse().slice(offset, offset + limit), total, offset, limit, scannedBytes: scannedBytes || 0 });
        })
        .catch(() => json(200, { trades: [], total: 0, offset, limit, scannedBytes: 0 }));
    } else if (p === "/api/stream") {
      const headers = {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      };
      const co = corsOrigin();
      if (co) headers["access-control-allow-origin"] = co;
      res.writeHead(200, headers);
      res.write(`data: ${state.lastBlock}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    } else if (p.startsWith("/api/tick/") && p.endsWith("/holders")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      const holders = Object.entries(state.balances[tick] || {})
        .map(([address, balance]) => ({ address, balance }))
        .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1)).slice(0, 100);
      json(200, { holders });
    } else if (p.startsWith("/api/tick/")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      // ?miner=0x.. → minerMints: that address's COMPLETED mint count for this
      // tick — the 4th preimage segment of the consensus-v2 PoW (the browser
      // miner must mine with it; served here so the worker needs no RPC).
      const miner = (url.searchParams.get("miner") || "").toLowerCase();
      const minerMints = ADDR_RE.test(miner) ? (state.mintsOf[tick]?.[miner] ?? 0) : undefined;
      json(200, {
        ...tickSummary(tick),
        recentMints: state.recentMints.filter((m) => m.tick === tick).slice(0, 20),
        ...(minerMints !== undefined ? { minerMints } : {}),
      });
    } else if (p.startsWith("/api/market/")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      json(200, marketBook(tick));
    } else if (p.startsWith("/api/balances/")) {
      const addr = p.slice("/api/balances/".length).toLowerCase();
      if (!ADDR_RE.test(addr)) return json(400, { error: "bad address" });
      const out = {};
      const mints = {};
      for (const tick of Object.keys(state.ticks)) {
        const b = state.balances[tick]?.[addr];
        if (b) out[tick] = b;
        const m = state.mintsOf[tick]?.[addr];
        if (m) mints[tick] = m;
      }
      json(200, { address: addr, balances: out, mints });
    } else if (p === "/api/miners") {
      // Miner leaderboard from the per-address mintsOf ledger (mirrors public
      // on-chain values). tick= scopes the board to one tick.
      const tickF = url.searchParams.get("tick");
      if (tickF != null && (!TICK_RE.test(tickF) || !state.ticks[tickF])) return json(404, { error: "unknown tick" });
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      let rows;
      if (tickF != null) {
        rows = Object.entries(state.mintsOf[tickF] || {}).map(([address, count]) => ({ address, count }));
      } else {
        const agg = {};
        for (const per of Object.values(state.mintsOf))
          for (const [address, count] of Object.entries(per)) agg[address] = (agg[address] || 0) + count;
        rows = Object.entries(agg).map(([address, count]) => ({ address, count }));
      }
      rows.sort((a, b) => b.count - a.count || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
      json(200, { miners: rows.slice(offset, offset + limit), total: rows.length, offset, limit });
    } else if (p === "/api/listings") {
      const tick = url.searchParams.get("tick");
      const status = url.searchParams.get("status");
      const items = Object.entries(state.listings)
        .map(([id, l]) => ({ id: Number(id), ...l }))
        .filter((l) => (!tick || l.tick === tick) && (!status || l.chainStatus === status))
        .sort((a, b) => b.id - a.id).slice(0, 200);
      json(200, { listings: items });
    } else if (p === "/api/bids") {
      const addr = (url.searchParams.get("bidder") || "").toLowerCase();
      const items = Object.entries(state.bids)
        .map(([id, b]) => ({ id: Number(id), ...b }))
        .filter((b) => !addr || b.bidder === addr)
        .sort((a, b) => b.id - a.id).slice(0, 200);
      json(200, { bids: items });
    } else if (p === "/api/oracle/pending") {
      // listings to confirm: on-chain Pending w/ valid escrow.
      // bids to settle: on-chain Open w/ a valid accept escrow (→ settleBid(id, accepter)).
      const confirmable = Object.entries(state.listings)
        .filter(([, l]) => l.chainStatus === "pending" && l.escrow === "valid")
        .map(([id]) => Number(id));
      const settleable = Object.entries(state.bids)
        .filter(([, b]) => b.chainStatus === "open" && b.escrow === "valid" && b.accepter)
        .map(([id, b]) => ({ id: Number(id), seller: b.accepter }));
      json(200, { confirmable, settleable });
    } else {
      // static web app
      const file = p === "/" ? "index.html" : p.replace(/^\//, "");
      const full = path.join(pub, path.normalize(file));
      // segment-aware prefix check: `public-backup` startsWith `public` would
      // otherwise pass a bare startsWith(pub) and leak sibling directories
      if (
        (full !== pub && !full.startsWith(pub + path.sep)) ||
        !fs.existsSync(full) ||
        !fs.statSync(full).isFile()
      ) {
        return json(404, { error: "not found" });
      }
      const mime = full.endsWith(".html") ? "text/html; charset=utf-8"
        : full.endsWith(".js") || full.endsWith(".mjs") ? "text/javascript" : full.endsWith(".css") ? "text/css"
        : full.endsWith(".svg") ? "image/svg+xml"
        : full.endsWith(".png") ? "image/png"
        : full.endsWith(".jpg") || full.endsWith(".jpeg") ? "image/jpeg"
        : full.endsWith(".webp") ? "image/webp"
        : full.endsWith(".ico") ? "image/x-icon" : "application/octet-stream";
      // code/markup: always revalidate so deploys take effect immediately (no
      // stale JS/CSS from the browser cache). Images can be cached briefly.
      const cache = /\.(png|jpg|jpeg|webp|ico|svg)$/.test(full) ? "public, max-age=3600" : "no-cache";
      res.writeHead(200, { "content-type": mime, "cache-control": cache });
      res.end(fs.readFileSync(full));
    }
  }

  server.listen(cfg.port || 3000, () => console.log(`arc-20 platform on http://localhost:${cfg.port || 3000}`));
}

// ---- Memes: fill in name/symbol for freshly-launched coins (one eth_call each) ----
const NAME_SEL = "0x06fdde03";
const SYMBOL_SEL = "0x95d89b41";
async function ethCallString(to, selector) {
  const ret = await rpc("eth_call", [{ to, data: selector }, "latest"]);
  if (!ret || ret === "0x") return "";
  try {
    return decodeAbiString(ret, 0);
  } catch {
    return "";
  }
}
// Resolve a coin's on-chain URI: fetch the metadata JSON from IPFS for image + socials.
// Falls back to treating the URI as a bare image (older launches / non-JSON payloads).
async function resolveMetadata(c) {
  if (c.metaResolved) return false;
  if (!c.metadataURI) { c.metaResolved = true; return true; }
  const r = await fetchIpfs(c.metadataURI);
  if (!r) return false; // all gateways slow/down — retry on the next scan
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/")) {
    c.image = c.metadataURI;
  } else {
    let parsed = false;
    try {
      const j = JSON.parse(await r.text());
      c.image = typeof j.image === "string" ? j.image : c.metadataURI;
      if (typeof j.twitter === "string") c.twitter = j.twitter;
      if (typeof j.website === "string") c.website = j.website;
      if (typeof j.telegram === "string") c.telegram = j.telegram;
      parsed = true;
    } catch {}
    if (!parsed) c.image = c.metadataURI; // not JSON — treat the URI itself as the image
  }
  c.metaResolved = true;
  return true;
}

async function enrichCoins() {
  let changed = false;
  for (const token of Object.keys(state.coins)) {
    const c = state.coins[token];
    if (c.name === null || c.symbol === null) {
      try {
        c.name = await ethCallString(token, NAME_SEL);
        c.symbol = await ethCallString(token, SYMBOL_SEL);
        changed = true;
      } catch (err) {
        console.error(`coin meta fetch failed for ${token}: ${err.message}`);
      }
    }
    if (await resolveMetadata(c)) changed = true;
  }
  if (changed) saveState();
}

// ---- Memes metrics: live market cap (v4 pool price via PoolManager.extsload) + holders ----
const SEL_GET_SLOT0 = "0xc815641c"; // getSlot0(bytes32) — StateView (legacy fallback)
const SEL_EXTSLOAD = "0x1e2eaeaf"; // extsload(bytes32) — PoolManager singleton storage read
const POOLS_SLOT = 6n; // storage slot of PoolManager._pools mapping (v4 StateLibrary)
const MASK160 = (1n << 160n) - 1n;
const Q192 = 1n << 192n;
const TOTAL_SUPPLY_WEI = 1_000_000_000n * (10n ** 18n); // fixed 1e27

// keccak256 lives in ./public/keccak.mjs (shared with the browser miner + e2e).
// Used here to derive a pool's Slot0 storage slot: keccak256(abi.encodePacked(poolId, POOLS_SLOT)).
const bytes32ToU8 = (hex) => { const h = hex.replace(/^0x/, "").padStart(64, "0"); const u = new Uint8Array(32); for (let i = 0; i < 32; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };
// v4 StateLibrary: a pool's state lives at keccak256(abi.encodePacked(poolId, uint256(POOLS_SLOT))); Slot0 is the first word.
function poolSlot0StorageSlot(poolId) {
  const packed = new Uint8Array(64);
  packed.set(bytes32ToU8(poolId), 0);
  packed.set(bytes32ToU8("0x" + POOLS_SLOT.toString(16)), 32);
  return keccak256(packed);
}
let ethUsd = null; // cached ETH/USD (null on chains without a price feed, e.g. testnet)
let ethUsdAt = 0;

async function refreshEthPrice() {
  if (!EXPLORER_API || Date.now() - ethUsdAt < 300_000) return;
  ethUsdAt = Date.now();
  try {
    const p = parseFloat((await explorerJson(EXPLORER_API + "/api/v2/stats")).coin_price);
    ethUsd = isFinite(p) && p > 0 ? p : null;
  } catch {}
}

// Market cap in WETH wei = (current token price in WETH) × fixed supply, from the v4 pool.
async function coinMcapWei(c) {
  if (WETH_ADDR === ZERO_ADDR || !c.poolId) return null;
  try {
    let sqrtPriceX96;
    if (POOL_MANAGER !== ZERO_ADDR) {
      // Read Slot0 directly from the PoolManager singleton via extsload.
      const slot = poolSlot0StorageSlot(c.poolId);
      const ret = await rpc("eth_call", [{ to: POOL_MANAGER, data: SEL_EXTSLOAD + slot.slice(2) }, "latest"]);
      if (!ret || ret === "0x") return null;
      sqrtPriceX96 = BigInt(ret) & MASK160; // Slot0 packs sqrtPriceX96 in the low 160 bits
    } else if (STATE_VIEW !== ZERO_ADDR) {
      const ret = await rpc("eth_call", [{ to: STATE_VIEW, data: SEL_GET_SLOT0 + c.poolId.slice(2) }, "latest"]);
      if (!ret || ret === "0x") return null;
      sqrtPriceX96 = BigInt("0x" + ret.slice(2, 66));
    } else {
      return null;
    }
    if (sqrtPriceX96 === 0n) return null;
    const tokenIsC0 = c.token.toLowerCase() < WETH_ADDR;
    return tokenIsC0
      ? (sqrtPriceX96 * sqrtPriceX96 * TOTAL_SUPPLY_WEI) / Q192
      : (Q192 * TOTAL_SUPPLY_WEI) / (sqrtPriceX96 * sqrtPriceX96);
  } catch {
    return null;
  }
}

async function coinHolders(c) {
  if (!EXPLORER_API) return null;
  try {
    const j = await explorerJson(EXPLORER_API + "/api/v2/tokens/" + c.token + "/counters");
    const h = parseInt(j.token_holders_count, 10);
    return isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

async function refreshMetrics() {
  await refreshEthPrice();
  const now = Date.now();
  let changed = false;
  for (const token of Object.keys(state.coins)) {
    const c = state.coins[token];
    if (now - (c.metricsAt || 0) < 20_000) continue; // per-coin throttle
    const mc = await coinMcapWei(c);
    const h = await coinHolders(c);
    if (mc !== null) c.mcapWei = mc.toString();
    if (h !== null) c.holders = h;
    c.metricsAt = now;
    changed = true;
  }
  if (changed) saveState();
}

// One-time launchpad backfill: when the factory is first configured, the indexer's
// checkpoint (state.lastBlock) is usually already past the factory deploy block, so
// the forward sweep would never see the TokenLaunched events that already happened.
// Scan [launchpadDeployBlock .. lastBlock] ONCE for launchpad logs and replay them
// through applyLog (idempotent for coins), guarded by state.launchpadBackfilledTo so
// a restart can't re-run it and double-count V4TaxCollected volume. After this, the
// forward sweep owns everything above lastBlock.
async function backfillLaunchpadOnce() {
  if (LAUNCHPAD === ZERO_ADDR) return;
  if (state.launchpadBackfilledTo !== undefined) return; // already backfilled once
  const startBlock = cfg.launchpadDeployBlock ?? cfg.deployBlock ?? 0;
  const upTo = state.lastBlock;
  const addrs = [LAUNCHPAD, HOOK].filter((a) => a !== ZERO_ADDR);
  const coinsBefore = Object.keys(state.coins).length;
  for (let from = startBlock; from <= upTo; from += BATCH_BLOCKS) {
    const to = Math.min(from + BATCH_BLOCKS - 1, upTo);
    const logs = await rpc("eth_getLogs", [{
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
      address: addrs, topics: [[T.TokenLaunched, T.V4TaxCollected]],
    }]);
    const byBlock = new Map();
    for (const lg of logs) {
      const b = hexToNum(lg.blockNumber);
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(lg);
    }
    for (const bn of [...byBlock.keys()].sort((a, b) => a - b)) {
      const blk = await rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
      const blockTs = blk ? hexToNum(blk.timestamp) : 0;
      const arr = byBlock.get(bn).sort((x, y) =>
        hexToNum(x.transactionIndex) - hexToNum(y.transactionIndex) || hexToNum(x.logIndex) - hexToNum(y.logIndex));
      for (const lg of arr) applyLog(lg, lg.transactionHash, bn, blockTs);
    }
  }
  state.launchpadBackfilledTo = upTo;
  saveState();
  const added = Object.keys(state.coins).length - coinsBefore;
  if (startBlock <= upTo) console.log(`launchpad backfill [${startBlock}..${upTo}] — ${added} coin(s) recovered`);
}

// ---- main ----
console.log(`arc-20 indexer — hub ${HUB}, market ${MARKET}, launchpad ${LAUNCHPAD}, rpc ${RPC_URL}, from block ${state.lastBlock + 1}`);
// R15: mintsOf lives in the journal, not the snapshot — rebuild it (streamed,
// multi-segment) BEFORE anything that reads miner counts or serves HTTP.
await rebuildMintsOfFromJournal();
await backfillLaunchpadOnce();
if (ONCE) {
  await backfillLaunchpadOnce();
  await scanToTarget();
  await enrichCoins();
  await refreshMetrics();
  saveState();
  console.log("done (--once)");
} else {
  // R16: bind HTTP FIRST — even if the RPC is down, /api/status answers and
  // orchestration can see the process; backfill failures are logged, not fatal.
  startServer();
  try {
    await backfillLaunchpadOnce();
  } catch (err) {
    console.error("launchpad backfill failed:", err.message);
  }
  // R16: enrichment/metrics run on their own timer with a re-entrancy guard —
  // coin-count growth no longer throttles block ingestion (O(N) decoupled).
  let enriching = false;
  const enrichLoop = async () => {
    if (enriching) return;
    enriching = true;
    try {
      await enrichCoins();
      await refreshMetrics();
      saveState();
    } catch (err) {
      console.error("enrich error:", err.message);
    }
    enriching = false;
  };
  await enrichLoop();
  setInterval(enrichLoop, ENRICH_MS);
  for (;;) {
    try {
      await scanToTarget();
    } catch (err) {
      console.error("scan error:", err.message);
      // A block may have been half-applied in memory before the error —
      // rewind to the last durable checkpoint so the retry can't double-apply.
      reloadFromCheckpoint();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
