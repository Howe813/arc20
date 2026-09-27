#!/usr/bin/env node
// rob-20 launchpad auto-verification keeper.
// Scans the LaunchpadFactory for TokenLaunched events and submits Blockscout
// source verification for every launched TaxedToken that isn't verified yet, so
// each coin is open-source without relying on Blockscout's flaky bytecode twin-match.
//
// Zero dependencies (Node 18+). Config via env or config.json (same file the
// indexer uses is fine — it reads its own keys):
//   RPC_URL / rpcUrl              chain RPC
//   launchpadAddress             LaunchpadFactory (required)
//   weth, poolManager            constants baked into every TaxedToken
//   verifyDeployBlock            block to scan TokenLaunched from (default launchpad deployBlock)
//   explorerApi                  Blockscout base (e.g. https://robinhoodchain.blockscout.com)
//   BLOCKSCOUT_API_KEY / blockscoutApiKey   Pro API key (avoids rate limits)
//   standardJson                 path to taxedtoken.standard.json (default alongside this file)
//   compilerVersion              e.g. v0.8.26+commit.8a97fa7a
//   verifyPollMs                 loop interval (default 60000); --once to run one pass

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(DIR, "config.json");
const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};

const RPC_URL = process.env.RPC_URL || cfg.rpcUrl;
const FACTORY = (cfg.launchpadAddress || "").toLowerCase();
const WETH = cfg.weth;
const POOL_MANAGER = cfg.poolManager;
const SUPPLY = 1_000_000_000n * 10n ** 18n; // fixed 1e27
const FROM_BLOCK = cfg.verifyDeployBlock ?? cfg.deployBlock ?? 0;
const EXPLORER = (cfg.explorerApi || "").replace(/\/$/, "");
const API_KEY = process.env.BLOCKSCOUT_API_KEY || cfg.blockscoutApiKey || "";
const STANDARD_JSON_PATH = cfg.standardJson || path.join(DIR, "taxedtoken.standard.json");
const COMPILER = cfg.compilerVersion || "v0.8.26+commit.8a97fa7a";
const CONTRACT_NAME = "src/TaxedToken.sol:TaxedToken";
const POLL_MS = cfg.verifyPollMs ?? 60000;
const ONCE = process.argv.includes("--once");
const BATCH = cfg.batchBlocks ?? 400;

const TOKENLAUNCHED = "0x4adf842742a001089c1b1320a9ae19e68569c50d433251fb61bf5bd37f6817d0";
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", creator: "0x02d05d3f", treasury: "0x61d027b3" };

if (!FACTORY || !WETH || !POOL_MANAGER || !EXPLORER) {
  console.error("verify-keeper: missing launchpadAddress / weth / poolManager / explorerApi in config");
  process.exit(1);
}
const STANDARD_JSON = fs.readFileSync(STANDARD_JSON_PATH, "utf8");

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
const hexToNum = (h) => Number(BigInt(h));
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

// ---- ABI encode TaxedToken constructor(string,string,address,uint256,address,address,address,address) ----
const abiWord = (v) => BigInt(v).toString(16).padStart(64, "0");
function abiStr(s) {
  const bytes = Buffer.from(s, "utf8");
  const hex = bytes.toString("hex");
  return { hex: abiWord(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), byteLen: 32 + Math.ceil(bytes.length / 32) * 32 };
}
function encodeCtor(name, symbol, supplyRecipient, supply, baseAsset, poolManager, creator, treasury) {
  const n = abiStr(name), s = abiStr(symbol);
  const off1 = 8 * 32;
  const off2 = off1 + n.byteLen;
  return abiWord(off1) + abiWord(off2) + abiWord(BigInt(supplyRecipient)) + abiWord(supply) +
    abiWord(BigInt(baseAsset)) + abiWord(BigInt(poolManager)) + abiWord(BigInt(creator)) + abiWord(BigInt(treasury)) +
    n.hex + s.hex;
}

function decodeAbiString(data) {
  if (!data || data === "0x") return "";
  const off = Number(BigInt("0x" + data.slice(2, 66)));
  const len = Number(BigInt("0x" + data.slice(2 + off * 2, 2 + off * 2 + 64)));
  return Buffer.from(data.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2), "hex").toString("utf8");
}
const callStr = async (to, sel) => decodeAbiString(await rpc("eth_call", [{ to, data: sel }, "latest"]));
const callAddr = async (to, sel) => "0x" + (await rpc("eth_call", [{ to, data: sel }, "latest"])).slice(26);

// Blockscout's mainnet host fingerprints/blocks Node's TLS ClientHello (undici AND
// node:https both get RST/connect-timeout), while system curl passes. So all explorer
// HTTP goes through curl. RPC stays on fetch (the RPC host doesn't block Node).
async function curlJson(args, timeoutSec = 30) {
  const { stdout } = await execFileP("curl", ["-sS", "--max-time", String(timeoutSec), ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function ex(params) {
  const url = new URL(EXPLORER + "/api");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (API_KEY) url.searchParams.set("apikey", API_KEY);
  return curlJson([url.toString()], 25);
}
async function isVerified(addr) {
  try {
    const j = await ex({ module: "contract", action: "getsourcecode", address: addr });
    const r = (j.result || [{}])[0];
    return !!(r.SourceCode && r.SourceCode.length > 0);
  } catch { return false; }
}
async function submitVerify(addr, ctorArgsHex) {
  const args = [
    "-X", "POST", EXPLORER + "/api",
    "--data-urlencode", "module=contract",
    "--data-urlencode", "action=verifysourcecode",
    "--data-urlencode", "codeformat=solidity-standard-json-input",
    "--data-urlencode", "contractaddress=" + addr,
    "--data-urlencode", "contractname=" + CONTRACT_NAME,
    "--data-urlencode", "compilerversion=" + COMPILER,
    "--data-urlencode", "constructorArguements=" + ctorArgsHex,
    "--data-urlencode", "sourceCode@" + STANDARD_JSON_PATH,
  ];
  if (API_KEY) args.push("--data-urlencode", "apikey=" + API_KEY);
  const j = await curlJson(args, 45);
  if (j.status !== "1") throw new Error("submit: " + JSON.stringify(j).slice(0, 160));
  return j.result; // guid
}
async function waitVerified(addr, guid) {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const j = await ex({ module: "contract", action: "checkverifystatus", guid });
    if (typeof j.result === "string" && j.result.startsWith("Pass")) return true;
    if (typeof j.result === "string" && j.result.startsWith("Fail")) throw new Error("verify failed: " + j.result);
    if (await isVerified(addr)) return true;
  }
  return await isVerified(addr);
}

async function findCoins() {
  const head = hexToNum(await rpc("eth_blockNumber", []));
  const tokens = [];
  for (let from = FROM_BLOCK; from <= head; from += BATCH) {
    const to = Math.min(from + BATCH - 1, head);
    const logs = await rpc("eth_getLogs", [{
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
      address: FACTORY, topics: [TOKENLAUNCHED],
    }]);
    for (const lg of logs) tokens.push(topicAddr(lg.topics[2]));
  }
  return tokens;
}

async function pass() {
  const tokens = await findCoins();
  let done = 0, already = 0, failed = 0;
  for (const token of tokens) {
    try {
      if (await isVerified(token)) { already++; continue; }
      const [name, symbol, creator, treasury] = await Promise.all([
        callStr(token, SEL.name), callStr(token, SEL.symbol),
        callAddr(token, SEL.creator), callAddr(token, SEL.treasury),
      ]);
      const args = encodeCtor(name, symbol, FACTORY, SUPPLY, WETH, POOL_MANAGER, creator, treasury);
      const guid = await submitVerify(token, args);
      const ok = await waitVerified(token, guid);
      if (ok) { done++; console.log(`verified ${token} (${symbol})`); }
      else { failed++; console.error(`still unverified ${token}`); }
    } catch (e) {
      failed++;
      console.error(`verify error ${token}: ${e.message}`);
    }
  }
  console.log(`verify pass: ${tokens.length} coins — ${done} newly verified, ${already} already, ${failed} failed`);
}

console.log(`rob-20 verify-keeper — factory ${FACTORY}, explorer ${EXPLORER}, from block ${FROM_BLOCK}`);
if (ONCE) {
  await pass();
} else {
  for (;;) {
    try { await pass(); } catch (e) { console.error("pass error:", e.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
