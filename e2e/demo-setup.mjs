// 部署 demo 合约 + mine tick 到本地 anvil,生成 anvil-accounts.json 供 batch-mint 验证
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8545";
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
const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const calldata = (...a) => execFileSync(castExe.replace(".exe", "") + (process.platform === "win32" ? ".exe" : ""), ["calldata", ...a]).toString().trim();

for (let i = 0; i < 60; i++) {
  try { await rpc("eth_chainId", []); break; } catch { await new Promise((s) => setTimeout(s, 300)); }
}
const accounts = await rpc("eth_accounts", []);
const a0 = accounts[0];
const pad = (a) => a.slice(2).padStart(64, "0");

// 先导出 anvil 账户
const anvilKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const walletAddr = execFileSync(castExe, ["wallet", "address", "--private-key", anvilKey]).toString().trim();
console.log("a0:", walletAddr);

execFileSync(forgeExe, ["build"], { cwd: ROOT, stdio: "ignore" });
const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), "utf8")).bytecode.object;

await send({ from: a0, data: art("InscriptionHub") }).then((r) => console.log("Hub:", r.contractAddress));
await send({ from: a0, data: art("InscriptionMarket") + pad(a0) + pad(a0) });
await send({ from: a0, to: (await rpc("eth_accounts", []))[0], to2: null });
// deploy mine tick: 500 × 100, 10/wallet, 8 bits, 500/600s
await send({ from: a0, to: (await fetch(RPC, { method: "POST" }).then(() => null), "0x0"), data2: null });
console.log("done-setup");
