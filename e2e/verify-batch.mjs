// 本地验证 batch-mint:anvil 部署 Hub + mine tick + batch-mint 挖 3 钱包 × 2 张
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, powCheck } from "../indexer/public/keccak.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8545";
const D = 8;
const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const castExe = path.join(process.env.USERPROFILE || "", ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
const forgeExe = path.join(process.env.USERPROFILE || "", ".foundry", "bin", process.platform === "win32" ? "forge.exe" : "forge");

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
async function send(tx) {
  const h = await rpc("eth_sendTransaction", [tx]);
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [h]);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 150));
  }
  throw new Error("timeout");
}
const calldata = (...a) => execFileSync(castExe, ["calldata", ...a]).toString().trim();
const pad = (a) => a.slice(2).padStart(64, "0");

for (let i = 0; i < 60; i++) {
  try { await rpc("eth_chainId", []); break; } catch { await new Promise((s) => setTimeout(s, 300)); }
}
const accounts = await rpc("eth_accounts", []);
const a0 = accounts[0];
execFileSync(forgeExe, ["build"], { cwd: ROOT, stdio: "ignore" });
const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), "utf8")).bytecode.object;

const hub = (await send({ from: a0, data: art("InscriptionHub") })).contractAddress;
console.log("Hub:", hub);

// anvil 主账户私钥(索引 0)
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
fs.writeFileSync(path.join(ROOT, "e2e/anvil-accounts.json"), JSON.stringify([ANVIL_KEY]));

// mine tick: 500 × 100, 10/wallet, 8 bits, 500/600s
await send({ from: a0, to: hub, data: calldata("deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)", "mine", "500", "100", "10", "8", "500", "600") });
console.log("mine tick deployed");

// 用 batch-mint 挖 3 钱包 × 2 张
const tickHash = keccak256(Buffer.from("mine", "utf8"));
console.log("batch-mint starting…");
execFileSync(process.execPath, [
  path.join(ROOT, "ops/batch-mint.mjs"),
  "--hub", hub, "--tick", "mine", "--key", ANVIL_KEY,
  "--wallets", "3", "--per-wallet", "2",
  "--rpc", RPC, "--gas-native", "0.01",
], { encoding: "utf8", cwd: ROOT, stdio: "inherit", timeout: 120000 });

// 验证:索引器无关——直接查链上余额(mintsOf)
const sel = "0x" + keccak256(Buffer.from("mintsOf(bytes32,address)", "utf8")).slice(2, 10);
const th = keccak256(Buffer.from("mine", "utf8"));
let totalMinted = 0;
for (let i = 0; i < 3; i++) {
  const derived = keccak256(Buffer.concat([Buffer.from(ANVIL_KEY.slice(2), "hex"), Buffer.from([i])]));
  const addr = "0x" + keccak256(Buffer.from(derived, "hex")).slice(-40);
  const ret = await rpc("eth_call", [{ to: hub, data: sel + th.slice(2) + pad(addr) }, "latest"]);
  const count = Number(BigInt(ret));
  console.log(`wallet ${i} (${addr.slice(0, 10)}…): ${count} mints`);
  totalMinted += count;
}
console.log(totalMinted === 6 ? "✅ batch-mint verified: 6 mints across 3 wallets" : `❌ expected 6, got ${totalMinted}`);
process.exit(totalMinted === 6 ? 0 : 1);
