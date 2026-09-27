#!/usr/bin/env node// End-to-end test for the arc-20 platform: deploy Hub + Market on anvil, run a
// full lifecycle (PoW-mined ticks, valid/invalid mined mints, transfers,
// list/confirm/buy/cancel incl. an invalid-escrow listing), then run the
// indexer (--once) and assert the ledger matches PROTOCOL.md. Run: node e2e/e2e.mjs
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, powCheck } from "../indexer/public/keccak.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Runtime-assigned free port: a FIXED port made two overlapping runs (leftover
// anvil, parallel gate runs) share one chain and corrupt each other's
// assertions (e.g. a mint mining against another run's state). Picking a free
// port makes every run own its chain.
const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
  s.on("error", reject);
});
const RPC = `http://127.0.0.1:${PORT}`;

const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const weiHex = (n) => "0x" + n.toString(16);
const FORCE_GAS = "0x7a120"; // mine failing txs with status 0 instead of erroring
const MINT_GAS = "0x1e8480"; // 2M — mints never OOG even if anvil's estimate wobbles
const D = 4; // test difficulty: ~16 hashes per mint

const calldata = (...args) => execFileSync("cast", ["calldata", ...args]).toString().trim();
// calldata prefix of every PoW-mint inscription ("data:,{"p":"arc-20","op":"mint")
const MINT_DATA_PREFIX = "0x" + Buffer.from('data:,{"p":"arc-20","op":"mint', "utf8").toString("hex");

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function send(tx, expectFail = false) {
  // Mining mints get an explicit 2M gas headroom: anvil's per-tx estimate has
  // been observed to come back low on this setup, turning a perfectly valid
  // mint into a random out-of-gas revert (the flaky gate failure). The tx
  // itself pays for what it uses, so the headroom is never spent.
  const finalTx = !expectFail && tx.data && tx.data.startsWith(MINT_DATA_PREFIX) && !tx.gas
    ? { ...tx, gas: MINT_GAS }
    : tx;
  const hash = await rpc("eth_sendTransaction", [expectFail ? { ...finalTx, gas: FORCE_GAS } : finalTx]);
  for (let i = 0; i < 50; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== (expectFail ? "0x0" : "0x1")) {
        let reason = "";
        try {
          // A failed tx changed no state — replaying the exact tx at "latest"
          // reproduces the revert. anvil returns the revert payload either as
          // result or inside error.data (the latter used to be swallowed).
          const res = await fetch(RPC, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "eth_call",
              params: [{ from: tx.from, to: tx.to, value: tx.value || "0x0", data: tx.data }, "latest"],
            }),
          });
          const body = await res.json();
          let payload = body.result;
          if ((!payload || payload === "0x") && body.error && body.error.data) payload = body.error.data;
          if (payload && payload !== "0x") {
            const sig = payload.slice(0, 10);
            // NOTE: known-selector naming is best-effort; a payload that is not
            // an error selector means the replay did not revert (state raced).
            const known = {
              [keccak256(Buffer.from("BadPow()", "utf8")).slice(0, 10)]: "BadPow",
              [keccak256(Buffer.from("SoldOut()", "utf8")).slice(0, 10)]: "SoldOut",
              [keccak256(Buffer.from("UnknownTick()", "utf8")).slice(0, 10)]: "UnknownTick",
              [keccak256(Buffer.from("WrongPayment()", "utf8")).slice(0, 10)]: "WrongPayment",
              [keccak256(Buffer.from("BadInscription()", "utf8")).slice(0, 10)]: "BadInscription",
              [keccak256(Buffer.from("ExceedsWalletLimit()", "utf8")).slice(0, 10)]: "ExceedsWalletLimit",
              [keccak256(Buffer.from("ContractCallerNotAllowed()", "utf8")).slice(0, 10)]: "ContractCallerNotAllowed",
            };
            if (sig === "0x08c379a0") {
              // Error(string): 4B selector + 32B offset + 32B len + bytes
              const hexLen = payload.slice(10 + 64, 10 + 128);
              const msgBytes = payload.slice(10 + 128, 10 + 128 + 2 * Number(BigInt("0x" + hexLen)));
              reason = `revert "${Buffer.from(msgBytes, "hex").toString("utf8")}"`;
            } else {
              reason = known[sig] || `unknown-sig ${sig}`;
            }
          } else {
            reason = "no revert data — eth_call succeeded at latest (state raced)";
          }
        } catch (diag) {
          reason = "diag failed: " + diag.message;
        }
        console.error("FAILED TX:", JSON.stringify(tx).slice(0, 200), "reason:", reason,
          "| gasUsed:", r.gasUsed, "| blockGasLimit-ish:", r.effectiveGasPrice);
        try {
          // who else was in this block? a tx that reverts under replay but
          // failed on-chain usually means it shared a block with a sibling
          const blk = await rpc("eth_getBlockByNumber", [r.blockNumber, true]);
          const txs = (blk.transactions || []).map((t) => `${t.from}→${t.to}:${String(t.data).slice(0, 10)} gas:${t.gas}`);
          console.error(`  block ${r.blockNumber} holds ${txs.length} tx(s):`, txs.join(" | "));
        } catch {}
      }
      assert.equal(r.status, expectFail ? "0x0" : "0x1", `tx status mismatch (${JSON.stringify(tx).slice(0, 120)})`);
      return r;
    }
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error("receipt timeout");
}

const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
anvil.on("error", (e) => {
  console.error(`anvil spawn failed: ${e.message} (is foundry's bin on PATH?)`);
  process.exit(1);
});
process.on("exit", () => anvil.kill());

try {
  for (let i = 0; i < 50; i++) {
    try { await rpc("eth_chainId", []); break; } catch { await new Promise((s) => setTimeout(s, 200)); }
  }
  // a leftover/foreign chain on this port would corrupt every assertion below
  const head = await rpc("eth_blockNumber", []);
  if (BigInt(head) !== 0n) {
    throw new Error(`port ${PORT} is served by a NON-EMPTY chain (head ${head}) — leftover anvil?`);
  }
  const [a0, a1, a2, a3, a4] = await rpc("eth_accounts", []);

  // ---- deploy contracts ----
  execFileSync("forge", ["build"], { cwd: ROOT, stdio: "ignore" });
  const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), "utf8")).bytecode.object;
  const hubR = await send({ from: a0, data: art("InscriptionHub") });
  const HUB = hubR.contractAddress.toLowerCase();
  const pad = (a) => a.slice(2).padStart(64, "0");
  const marketR = await send({ from: a0, data: art("InscriptionMarket") + pad(a0) + pad(a0) }); // owner=operator=a0
  const MARKET = marketR.contractAddress.toLowerCase();
  console.log("Hub:", HUB, "Market:", MARKET);

  // ---- PoW mint helpers (JS miner mirrors the contract preimage, consensus
  // v2: keccak256(miner, tickHash, nonce, mintsOf) — the mint COUNT is part of
  // the hash, so every solution is single-use) ----
  const deploySig = "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)";
  const mineFrom = (miner, th, d, from, count) => {
    for (let n = from; ; n++) if (powCheck(miner, th, n, d, count)) return n;
  };
  // per-tick miner: hands out winning nonces per address for its CURRENT mint
  // count. CAVEAT: each call consumes one count slot — if a mint REVERTS for
  // any reason, the on-chain count did not advance while this helper's slot
  // did, so that address must NOT be mined through this helper for the tick
  // again (re-bind the counter first). The script below respects this: every
  // reverting call is that address's last one on the tick.
  const minerFor = (tick, d) => {
    const th = keccak256(Buffer.from(tick, "utf8"));
    const cur = {};
    return (who, amt) => {
      const c = cur[who] || 0;
      const n = mineFrom(who, th, d, 0, c);
      cur[who] = c + 1;
      return hex(`data:,{"p":"arc-20","op":"mint","tick":"${tick}","amt":"${amt}","nonce":"${n}"}`);
    };
  };

  // ---- deploy ticks (every tick is a PoW fair launch) ----
  // robin: maxMints == the 13 valid mints below, so it ends 100% minted and is
  // therefore tradable (a tick must be sold out to be listed — the trade gate).
  const mintRobin = minerFor("robin", D);
  await send({ from: a0, to: HUB, data: calldata(deploySig, "robin", "13", "1000", "10", D.toString(), "13", "600") });
  const mintFree = minerFor("free", D);
  await send({ from: a1, to: HUB, data: calldata(deploySig, "free", "100", "5", "2", D.toString(), "100", "600") });
  // duplicate tick reverts
  await send({ from: a2, to: HUB, data: calldata(deploySig, "robin", "1", "1", 1, "1", "1", "1") }, true);

  // ---- mined mints ----
  const thRobin = keccak256(Buffer.from("robin", "utf8"));
  // a1's first winning nonce, chosen deterministically: valid for a1 (count 0)
  // AND invalid for a2 (count 0), so the theft attempt below reverts for sure
  let a1FirstNonce = 0;
  while (!powCheck(a1, thRobin, a1FirstNonce, D, 0) || powCheck(a2, thRobin, a1FirstNonce, D, 0)) a1FirstNonce++;
  for (let i = 0; i < 10; i++) await send({ from: a1, to: HUB, value: "0x0", data: mintRobin(a1, "1000") });
  await send({ from: a1, to: HUB, value: "0x0", data: mintRobin(a1, "1000") }, true); // 11th: wallet limit
  await send({
    from: a2, to: HUB, value: "0x0",
    data: hex(`data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000","nonce":"${a1FirstNonce}"}`),
  }, true); // stolen nonce (bound to a1's address): BadPow
  for (let i = 0; i < 3; i++) await send({ from: a2, to: HUB, value: "0x0", data: mintRobin(a2, "1000") });
  await send({ from: a2, to: HUB, value: "0x0", data: mintRobin(a2, "999") }, true); // amt mismatch
  await send({ from: a2, to: HUB, value: "0x0", data: hex('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000"}') }, true); // missing nonce
  await send({ from: a2, to: HUB, value: "0x0", data: hex('data:,{"p":"arc-20","op":"mint","tick":"robin","amt":"1000","nonce":"01"}') }, true); // non-canonical
  await send({ from: a2, to: HUB, value: weiHex(10n ** 15n), data: mintRobin(a2, "1000") }, true); // PoW mints carry no ETH
  for (let i = 0; i < 2; i++) await send({ from: a3, to: HUB, value: "0x0", data: mintFree(a3, "5") });

  // ---- transfers ----
  const transfer = (tick, amt) => hex(`data:,{"p":"arc-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`);
  await send({ from: a1, to: a3, value: "0x0", data: transfer("robin", "500") }); // valid
  await send({ from: a3, to: a4, value: "0x0", data: transfer("robin", "10000") }); // over balance: on-chain ok, ledger-invalid
  await send({ from: a2, to: a4, value: "0x0", data: transfer("robin", "0500") }); // leading zero: not an op at all
  await send({ from: a2, to: a2, value: "0x0", data: transfer("robin", "100") }); // self-transfer: valid, no net change
  // exact-balance spend-all WITH nonzero ETH attached (both are protocol-legal)
  await send({ from: a3, to: a4, value: weiHex(10n ** 15n), data: transfer("free", "10") });

  // ---- sold-out boundary at the ledger level ----
  await send({ from: a0, to: HUB, data: calldata(deploySig, "tiny", "2", "1", "2", D.toString(), "2", "600") });
  const mintTiny = minerFor("tiny", D);
  await send({ from: a4, to: HUB, value: "0x0", data: mintTiny(a4, "1") });
  await send({ from: a4, to: HUB, value: "0x0", data: mintTiny(a4, "1") });
  await send({ from: a3, to: HUB, value: "0x0", data: mintTiny(a3, "1") }, true); // SoldOut

  // ---- contract-mediated (internal call) deploy + market ops ----
  // A Safe/factory registering a tick emits Deployed with tx.to = the proxy,
  // NOT the Hub — the indexer must still see it (via eth_getLogs) and must not
  // crash when the tick is subsequently minted by an EOA.
  const proxyR = await send({ from: a3, data: art("CallProxy") });
  const PROXY = proxyR.contractAddress;
  const viaProxy = (target, inner, value = "0x0") => ({
    from: a3, to: PROXY, value, data: calldata("exec(address,bytes)", target, inner),
  });
  await send(viaProxy(HUB, calldata(deploySig, "safetick", "1", "50", "1", D.toString(), "1", "600")));
  // Mine against the ON-CHAIN mint count (public mapping getter), not a local
  // assumption — any counter drift between the JS miner and the chain
  // self-heals here instead of surfacing as a flaky BadPow gate failure.
  const thSafetick = keccak256(Buffer.from("safetick", "utf8"));
  const mintsOfOnChain = async (th, who) => {
    const data = execFileSync("cast", ["calldata", "mintsOf(bytes32,address)", th, who]).toString().trim();
    const ret = await rpc("eth_call", [{ to: HUB, data }, "latest"]);
    return BigInt(ret === "0x" || ret == null ? 0 : ret);
  };
  const sfCount = await mintsOfOnChain(thSafetick, a4);
  const sfNonce = mineFrom(a4, thSafetick, D, 0, sfCount);
  await send({ from: a4, to: HUB, value: "0x0", data: hex(`data:,{"p":"arc-20","op":"mint","tick":"safetick","amt":"50","nonce":"${sfNonce}"}`) }); // EOA mines the proxy-deployed tick → 1/1, sold out (tradable)

  // ---- market ----
  const list = (tick, amt, price) => hex(`data:,{"p":"arc-20","op":"list","tick":"${tick}","amt":"${amt}","price":"${price}"}`);
  const PRICE_LIST = 5n * 10n ** 16n; // 0.05 ETH
  const FEE = (PRICE_LIST * 500n) / 10000n;

  await send({ from: a1, to: MARKET, data: list("robin", "500", PRICE_LIST.toString()) }); // id 1, escrow valid
  await send({ from: a4, to: MARKET, data: list("robin", "999999", "1000") }); // id 2, escrow INVALID (a4 has none)
  await send({ from: a2, to: MARKET, data: list("robin", "300", "1000") }); // id 3, escrow valid

  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "1") });
  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "3") });
  // R19 oracle idempotency semantics: re-confirming an Active listing reverts
  // BadState — the oracle's retry loop treats it as already-done
  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "1") }, true);
  await send({ from: a2, to: MARKET, data: calldata("buy(uint256)", "2"), value: weiHex(1050n) }, true); // pending -> BadState
  await send({ from: a2, to: MARKET, data: calldata("buy(uint256)", "1"), value: weiHex(PRICE_LIST + FEE) }); // sold to a2
  // R19 batch cancel: foreign caller cancels nothing (skip-any, no revert);
  // the seller cancels 3 (own) + 4 (already cancelled) → 4 skipped, 3 cancelled
  // (R10: the skip-any return value is pre-checked via eth_call, not assumed)
  const cmForeign = execFileSync("cast", ["calldata", "cancelMany(uint256[])", "[3]"]).toString().trim();
  const retForeign = await rpc("eth_call", [{ from: a1, to: MARKET, data: cmForeign }, "latest"]);
  assert.equal(BigInt(retForeign), 0n, "foreign caller would cancel 0");
  const cmOwner = execFileSync("cast", ["calldata", "cancelMany(uint256[])", "[3,4]"]).toString().trim();
  const retOwner = await rpc("eth_call", [{ from: a2, to: MARKET, data: cmOwner }, "latest"]);
  assert.equal(BigInt(retOwner), 1n, "seller would cancel 1 (id3 open; id4 already cancelled → skipped)");
  await send({ from: a1, to: MARKET, data: cmForeign }); // a1 owns none → no-op
  await send({ from: a2, to: MARKET, data: cmOwner }); // a2 reclaims 300


  // proxy-mediated market op: a4 lists safetick directly (id 4), then a CANCEL routed
  // through the proxy must fail (seller is a4, not the proxy); a4 cancels directly.
  await send({ from: a4, to: MARKET, data: list("safetick", "50", "1000") }); // id 4, escrow valid
  await send(viaProxy(MARKET, calldata("cancel(uint256)", "4")), true); // NotSeller: proxy != a4
  await send({ from: a4, to: MARKET, data: calldata("cancel(uint256)", "4") });

  // ---- bids (buy orders): place -> accept -> settle, and place -> cancel ----
  // consensus v4: the accept inscription goes to the MARKET and binds the fill
  // on-chain (pendingSeller, first come first served); settleBid pays that
  // binding only — the operator can delay but never redirect bid escrow.
  const accept = (tick, bid) => hex(`data:,{"p":"arc-20","op":"accept","tick":"${tick}","bid":"${bid}"}`);
  const BID_PRICE = 10n ** 16n; // 0.01 ETH
  const BID_FEE = (BID_PRICE * 500n) / 10000n;
  // a3 bids to buy 500 robin (escrows price + 5%)
  await send({ from: a3, to: MARKET, value: weiHex(BID_PRICE + BID_FEE), data: calldata("placeBid(string,uint128,uint128)", "robin", "500", BID_PRICE.toString()) }); // bid 1
  // settling before the on-chain accept binding reverts
  await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a1) }, true); // NotPendingSeller
  // a1 (holds robin) accepts by sending the accept inscription to the MARKET
  await send({ from: a1, to: MARKET, value: "0x0", data: accept("robin", "1") });
  // a second accept on the same bid reverts (binding is first come, first served)
  await send({ from: a2, to: MARKET, value: "0x0", data: accept("robin", "1") }, true); // BidTaken
  // the operator cannot settle to an address other than the bound seller
  await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a2) }, true); // NotPendingSeller
  // operator settles the bid to the bound seller a1
  await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a1) });
  // R19 oracle idempotency: settling an already-Filled bid reverts BadState
  await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a1) }, true);
  // a4 places a bid then cancels it (full refund, no ledger effect)
  const BID2 = 5n * 10n ** 15n;
  await send({ from: a4, to: MARKET, value: weiHex(BID2 + (BID2 * 500n) / 10000n), data: calldata("placeBid(string,uint128,uint128)", "robin", "100", BID2.toString()) }); // bid 2
  await send({ from: a4, to: MARKET, data: calldata("cancelBid(uint256)", "2") });

  // ---- trade gate: a tick that is NOT 100% minted must not get a valid escrow ----
  await send({ from: a0, to: HUB, data: calldata(deploySig, "gated", "5", "100", "5", D.toString(), "5", "600") });
  const mintGated = minerFor("gated", D);
  await send({ from: a4, to: HUB, value: "0x0", data: mintGated(a4, "100") });
  await send({ from: a4, to: HUB, value: "0x0", data: mintGated(a4, "100") }); // 2/5 minted — NOT sold out
  await send({ from: a4, to: MARKET, data: list("gated", "100", "1000") }); // id 5 — escrow must be INVALID (gated)

  // ---- accept gates (ledger-level): the binding succeeds on-chain (the Market
  // cannot know arc-20 balances), but the indexer rejects the escrow — with a
  // structured reason — so the oracle will never settle these bids ----
  // bid 3: a3 bids 100 gated — tick NOT sold out, so a4's accept escrow is invalid
  await send({ from: a3, to: MARKET, value: weiHex(BID_PRICE + BID_FEE), data: calldata("placeBid(string,uint128,uint128)", "gated", "100", BID_PRICE.toString()) });
  await send({ from: a4, to: MARKET, value: "0x0", data: accept("gated", "3") }); // indexer: tick-not-sold-out
  // bid 4: a3 bids 100 robin (sold out) — but a4 holds ZERO robin
  await send({ from: a3, to: MARKET, value: weiHex(BID_PRICE + BID_FEE), data: calldata("placeBid(string,uint128,uint128)", "robin", "100", BID_PRICE.toString()) });
  await send({ from: a4, to: MARKET, value: "0x0", data: accept("robin", "4") }); // indexer: insufficient-balance
  await send({ from: a2, to: MARKET, value: "0x0", data: accept("free", "4") }, true); // wrong tick → BadInscription
  await send({ from: a1, to: MARKET, value: "0x0", data: accept("robin", "2") }, true); // bid 2 cancelled → BadState
  // ---- R19 sweep: one tx buys two listings; the indexer settles each Bought
  // individually (escrow release, buyer credit, trade/volume accumulation) ----
  await send({ from: a2, to: MARKET, data: list("robin", "100", "2000") }); // listing 6 (a2, escrow 100)
  await send({ from: a3, to: MARKET, data: list("robin", "100", "3000") }); // listing 7 (a3, escrow 100)
  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "6") });
  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "7") });
  const sweepValue = 2000n + 3000n + ((2000n + 3000n) * 500n) / 10000n; // prices + 5% both sides
  await send({ from: a4, to: MARKET, value: weiHex(sweepValue), data: calldata("sweep(uint256[])", "[6,7]") }); // a4 takes both

  // ---- R19 confirmable/settleable positive cases (buyer-trust anchor path):
  // a pending listing with VALID escrow and an open bid with a VALID accept
  // escrow are exactly what /api/oracle/pending surfaces to the operator ----
  await send({ from: a1, to: MARKET, data: list("robin", "200", "80000000000000000") }); // listing 8 — stays pending+valid
  await send({ from: a3, to: MARKET, value: weiHex(BID_PRICE + BID_FEE), data: calldata("placeBid(string,uint128,uint128)", "robin", "200", BID_PRICE.toString()) }); // bid 5
  await send({ from: a1, to: MARKET, value: "0x0", data: accept("robin", "5") }); // a1 escrows 200 robin for bid 5

  // ---- index and verify ledger ----
  // ---- index and verify ledger ----
  const tmpDir = fs.mkdtempSync(path.join(ROOT, "e2e/run-"));
  const config = {
    rpcUrl: RPC, hubAddress: HUB, marketAddress: MARKET, deployBlock: 0, confirmations: 0,
    batchBlocks: 200, stateFile: path.join(tmpDir, "state.json"), eventsFile: path.join(tmpDir, "events.jsonl"),
  };
  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runIndexer = () =>
    execFileSync("node", [path.join(ROOT, "indexer/indexer.mjs"), "--once"], {
      env: { ...process.env, CONFIG_PATH: configPath }, stdio: "pipe",
    });
  runIndexer();
  const st = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));

  const [A1, A2, A3, A4] = [a1, a2, a3, a4].map((a) => a.toLowerCase());

  // ticks
  assert.equal(st.ticks.robin.maxMints, 13);
  assert.equal(st.ticks.robin.amountPerMint, "1000");
  assert.equal(st.ticks.robin.mintPriceWei, "0");
  // the 13-mint epoch completes in ~40s of anvil time vs the 600s target →
  // the epoch-filling mint retargets a full ×4 clamp step: 4 → 16 bits
  assert.equal(st.ticks.robin.pow.difficultyBits, D * 4, "retarget ×4 at epoch end (fast epoch)");
  assert.equal(st.ticks.robin.totalMints, 13);
  assert.equal(st.ticks.free.totalMints, 2);
  assert.equal(st.ticks.tiny.totalMints, 2, "tiny minted out at exactly maxMints");
  assert.equal(st.ticks.tiny.maxMints, 2);
  // balances after listings, the bid flow and the R19 sweep: a1 delivered 500
  // into bid#1 (9000-500=8500), a3 received 500 (500+500=1000); a2 unchanged
  // until the sweep took its 100-robin listing (3500-100=3400); a3 listed 100
  // into listing 7 (1000-100=900); sweep buyer a4 received 100+100=200
  console.log("DEBUG robin:", JSON.stringify(st.balances.robin), "bids5:", JSON.stringify(st.bids["5"]), "list8:", JSON.stringify(st.listings["8"]));
assert.equal(st.balances.robin[A1], "8100");
  assert.equal(st.balances.robin[A2], "3400");
  assert.equal(st.balances.robin[A3], "900");
  assert.equal(st.balances.robin[A4], "200");
  // bid #1 filled by a1, delivered to bidder a3; bid #2 cancelled (refund, no ledger effect)
  assert.equal(st.bids["1"].chainStatus, "filled");
  assert.equal(st.bids["1"].escrow, "released");
  assert.equal(st.bids["1"].seller, A1);
  assert.equal(st.bids["1"].bidder, A3);
  assert.equal(st.bids["2"].chainStatus, "cancelled");
  // free: a3 spent ALL 10 to a4 (with ETH attached) — zero balance must be deleted, not "0"
  assert.equal(st.balances.free[A3], undefined);
  assert.equal(st.balances.free[A4], "10");
  assert.equal(st.balances.tiny[A4], "2");
  // proxy-deployed tick was indexed (Deployed via internal call) and minted safely
  assert.equal(st.ticks.safetick.totalMints, 1, "internal-call deploy must be indexed");
  assert.equal(st.balances.safetick[A4], "50");
  assert.equal(st.listings["4"].chainStatus, "cancelled");
  assert.equal(st.listings["4"].escrow, "released");
  // R15: mintsOf is journal-derived and no longer part of the snapshot — the
  // mined counts are asserted through the HTTP surface below (/api/miners +
  // /api/balances mints), which is the same ledger data.
  assert.equal(st.invalidTransfers, 1);
  // listings
  assert.equal(st.listings["1"].chainStatus, "sold");
  assert.equal(st.listings["1"].escrow, "released");
  assert.equal(st.listings["1"].buyer, A2);
  assert.equal(st.listings["2"].chainStatus, "pending");
  assert.equal(st.listings["2"].escrow, "invalid");
  assert.equal(st.listings["3"].chainStatus, "cancelled");
  assert.equal(st.listings["3"].escrow, "released");
  // R19 confirmable/settleable positive cases
  assert.equal(st.listings["8"].chainStatus, "pending");
  assert.equal(st.listings["8"].escrow, "valid", "listing 8 stays confirmable");
  assert.equal(st.bids["5"].chainStatus, "open");
  assert.equal(st.bids["5"].escrow, "valid", "bid 5 keeps a1's accept escrow for settlement");
  assert.equal(st.bids["5"].accepter, A1);
  // R19 sweep: both swept listings settle individually (sold + escrow released)
  assert.equal(st.listings["6"].chainStatus, "sold");
  assert.equal(st.listings["6"].escrow, "released");
  assert.equal(st.listings["6"].buyer, A4);
  assert.equal(st.listings["7"].chainStatus, "sold");
  assert.equal(st.listings["7"].escrow, "released");
  assert.equal(st.listings["7"].buyer, A4);
  assert.equal(st.listings["7"].seller, A3);
  // conservation: all robin balances sum to 13 mints x 1000
  const sum = Object.values(st.balances.robin).reduce((a, b) => a + BigInt(b), 0n);
  const list8Escrow = BigInt(st.listings["8"].amt);
  const bid5Escrow = BigInt(st.bids["5"].amt);
  assert.equal(sum + list8Escrow + bid5Escrow, 13000n, "conservation incl. outstanding robin escrows");

  // trade gate: a not-fully-minted tick (gated 2/5) must never get a valid escrow
  assert.equal(st.ticks.gated.totalMints, 2);
  assert.equal(st.ticks.gated.maxMints, 5);
  assert.equal(st.listings["5"].escrow, "invalid", "not-sold-out tick must not get valid escrow");
  assert.equal(st.listings["5"].chainStatus, "pending", "gated listing stays pending, never confirmable");
  // accept gates: both invalid accepts are silently ignored on-chain (pure
  // calldata), so bids 3/4 stay open with NO accept escrow
  assert.equal(st.bids["3"].chainStatus, "open", "accept on a not-sold-out tick must not escrow");
  assert.equal(st.bids["3"].accepter, null);
  assert.equal(st.bids["4"].chainStatus, "open", "accept with insufficient balance must not escrow");
  assert.equal(st.bids["4"].accepter, null);
  // R4: the on-chain binding IS recorded even when the ledger rejects it —
  // surfaced so the frontend can disable the doomed Fill button
  assert.equal(st.bids["3"].boundInvalid, A4, "bound-but-gated accept must be visible");
  assert.equal(st.bids["4"].boundInvalid, A4, "bound-but-broke accept must be visible");

  // event-level pinning of the pure-indexer rules (forge can't see these):
  // invalid accepts must carry a structured reason, invalid lists escrow=invalid
  const events = fs.readFileSync(config.eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const accepts = events.filter((e) => e.op === "accept");
  assert.equal(accepts.filter((e) => e.valid).length, 2, "two valid accepts (bid 1 settle path + bid 5 settleable)");
  assert.deepEqual(
    accepts.filter((e) => !e.valid).map((e) => e.reason).sort(),
    ["insufficient-balance", "tick-not-sold-out"],
    "invalid accepts must carry a structured reason"
  );
  assert.deepEqual(
    events.filter((e) => e.op === "list" && e.escrow === "invalid").map((e) => e.id).sort(),
    ["2", "5"],
    "listings 2 & 5 must be escrow-invalid at the event level"
  );
  // R6 sold-out discovery data: the mint that hits maxMints records when the
  // trade gate opened, and the event stream carries a soldout event per tick
  assert.ok(st.ticks.tiny.soldOutAt > 0, "soldOutAt (epoch ms) recorded at the maxMints mint");
  assert.ok(st.ticks.tiny.soldOutBlock != null, "soldOutBlock recorded");
  assert.equal(events.filter((e) => e.op === "soldout").length, 3, "soldout event for robin/tiny/safetick");
  assert.ok(st.ticks.gated.soldOutAt == null, "not-sold-out tick must have no soldOutAt");

  // ---- replay determinism (state AND event log) ----
  // R15 persistence: the snapshot is mintsOf-free (journal-derived, rebuilt on
  // boot) and carries the journal byte offset it covers.
  const snapOnDisk = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  assert.ok(!("mintsOf" in snapOnDisk), "snapshot must not carry journal-derived mintsOf");
  assert.ok(Number(snapOnDisk.eventsOffset) > 0, "journal offset checkpointed");
  const eventsFirstRun = fs.readFileSync(config.eventsFile, "utf8");
  // delete ONLY state.json — the indexer must rewind events.jsonl itself and
  // reproduce it byte-identically, with no duplicated lines
  fs.rmSync(config.stateFile);
  runIndexer();
  assert.deepEqual(JSON.parse(fs.readFileSync(config.stateFile, "utf8")), st, "state replay must be identical");
  const eventsSecondRun = fs.readFileSync(config.eventsFile, "utf8");
  assert.equal(eventsSecondRun, eventsFirstRun, "events.jsonl replay must be identical (no duplicates)");
  const keys = eventsSecondRun.trim().split("\n").map((l) => {
    const e = JSON.parse(l);
    return `${e.op}:${e.tx}:${e.id ?? ""}`;
  });
  assert.equal(new Set(keys).size, keys.length, "no duplicate event lines");

  // ---- HTTP surface: static prefix check, pin hardening, CORS echo (R4) ----
  // `indexer/public-backup` shares the `public` name prefix — the old bare
  // startsWith(pub) check leaked such siblings; it must 404 now. Raw
  // node:http requests let us set Host/Origin freely (like curl) to simulate
  // a cross-site "simple request" (text/plain, no preflight).
  fs.mkdirSync(path.join(ROOT, "indexer", "public-backup"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "indexer", "public-backup", "probe.html"), "sibling-leak");
  const serveCfgPath = path.join(tmpDir, "serve-config.json");
  fs.writeFileSync(
    serveCfgPath,
    JSON.stringify({
      ...config, port: 8611,
      stateFile: path.join(tmpDir, "serve-state.json"),
      eventsFile: path.join(tmpDir, "serve-events.jsonl"),
    })
  );
  const serve = spawn("node", [path.join(ROOT, "indexer/indexer.mjs")], {
    env: { ...process.env, CONFIG_PATH: serveCfgPath, PINATA_JWT: "" },
    stdio: "ignore",
  });
  // raw HTTP helper: node:http lets us set Host/Origin freely (undici's fetch
  // restricts some of them), so we can simulate exactly what a browser or
  // curl would put on the wire
  const raw = (port, method, p, headers = {}, body = null) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, acao: res.headers["access-control-allow-origin"] ?? null, body: data }));
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      up = await raw(8611, "GET", "/api/status").then((r) => r.status === 200).catch(() => false);
    }
    assert.ok(up, "serve instance must come up on port 8611");

    // static files: normal asset readable, same-prefix sibling NOT
    assert.equal((await raw(8611, "GET", "/index.html")).status, 200, "normal static file readable");
    assert.equal((await raw(8611, "GET", "/public-backup/probe.html")).status, 404, "same-prefix sibling dir must not leak");
    // CORS: no wildcard — same-origin Origin is echoed, foreign gets nothing
    assert.equal((await raw(8611, "GET", "/api/status")).acao, null, "no wildcard CORS on the API");
    assert.equal(
      (await raw(8611, "GET", "/api/status", { origin: "http://127.0.0.1:8611" })).acao,
      "http://127.0.0.1:8611",
      "same-origin Origin is echoed"
    );

    // pin guard: cross-site simple requests must never reach the operator's
    // Pinata quota
    const jsonBody = JSON.stringify({ dataB64: Buffer.from("hello").toString("base64") });
    const plain = { host: "127.0.0.1:8611", "content-type": "text/plain" };
    assert.equal((await raw(8611, "POST", "/api/memes/pin", plain, jsonBody)).status, 403, "cross-site simple request rejected (no Origin)");
    assert.equal(
      (await raw(8611, "POST", "/api/memes/pin", { ...plain, origin: "http://evil.example", "content-type": "application/json" }, jsonBody)).status,
      403,
      "foreign Origin rejected"
    );
    assert.equal(
      (await raw(8611, "POST", "/api/memes/pin", { host: "127.0.0.1:8611", origin: "http://127.0.0.1:8611", "content-type": "text/plain" }, jsonBody)).status,
      415,
      "same-origin but non-JSON content-type rejected"
    );
    const gated = await raw(8611, "POST", "/api/memes/pin", { host: "127.0.0.1:8611", origin: "http://127.0.0.1:8611", "content-type": "application/json" }, jsonBody);
    assert.equal(gated.status, 503, "guarded request reaches the pin handler");
    assert.ok(gated.body.includes("not configured"), "503 is the unconfigured-pinning reply (guard passed)");

    // ---- R20 buyer-trust anchor: /api/oracle/pending computations over the
    // live ledger snapshot ----
    const pend = JSON.parse((await raw(8611, "GET", "/api/oracle/pending")).body);
    assert.deepEqual(pend.confirmable, [8], "only the valid pending listing is confirmable");
    assert.deepEqual(
      pend.settleable.map((s) => ({ id: s.id, seller: s.seller })),
      [{ id: 5, seller: A1 }],
      "settleable names the accepter of the open valid-accept bid"
    );

    // ---- R7 data APIs: paginated ticks/memes + trade replay from events.jsonl ----
    const tkAll = JSON.parse((await raw(8611, "GET", "/api/ticks?limit=100")).body);
    const tk = JSON.parse((await raw(8611, "GET", "/api/ticks?limit=2")).body);
    assert.equal(tk.ticks.length, 2, "ticks pagination honours limit");
    assert.ok(tk.total >= 5, "ticks total spans the whole ledger");
    const tk2 = JSON.parse((await raw(8611, "GET", "/api/ticks?limit=2&offset=2")).body);
    assert.equal(tk2.ticks[0].tick, tkAll.ticks[2].tick, "offset shifts the pagination window");
    assert.ok(tk2.total === tkAll.total, "total is window-independent");
    const tr = JSON.parse((await raw(8611, "GET", "/api/trades?tick=robin&limit=5")).body);
    assert.ok(tr.total >= 2, "trade replay finds the robin trades");
    assert.ok(tr.trades.every((x) => x.tick === "robin" && x.kind && x.seller && x.buyer && x.price), "trade events carry the full trade record");
    const trAddr = JSON.parse((await raw(8611, "GET", `/api/trades?addr=${A1}&limit=100`)).body);
    assert.ok(
      trAddr.trades.every((x) => x.buyer === A1 || x.seller === A1),
      "addr filter matches counterparty fields exactly"
    );
    const actW = JSON.parse((await raw(8611, "GET", "/api/activity")).body);
    assert.equal(actW.windowed, true, "activity total is explicitly window-scoped");
    // R8 miner ecosystem: leaderboard, per-address mined counts, 24h heat
    const mn = JSON.parse((await raw(8611, "GET", "/api/miners?tick=robin&limit=5")).body);
    assert.ok(mn.total >= 2 && mn.miners.length >= 2, "robin miner leaderboard populated");
    assert.ok(mn.miners[0].count >= mn.miners[mn.miners.length - 1].count, "leaderboard sorted by count desc");
    assert.equal(mn.miners.find((m) => m.address === A1)?.count, 10, "a1 mined 10 robin (journal-derived mintsOf)");
    assert.equal(mn.miners.find((m) => m.address === A2)?.count, 3, "a2 mined 3 robin");
    const mnAll = JSON.parse((await raw(8611, "GET", "/api/miners")).body);
    assert.ok(mnAll.total >= mn.total, "global board spans at least the robin miners");
    const balR = JSON.parse((await raw(8611, "GET", `/api/balances/${A1}`)).body);
    assert.equal(balR.mints.robin, 10, "balances API exposes per-tick mined counts");
    const statR = JSON.parse((await raw(8611, "GET", "/api/status")).body);
    assert.ok(statR.mints24h >= 20, "24h mints heat metric counts every mint in the run");
    assert.ok(statR.activeMiners24h >= 4, "24h active-miner metric");

    // ---- PIN_TOKEN branch (R5 feedback): the token ADDS cross-origin
    // server-to-server access; it never locks same-origin browsers out ----
    const serveTokCfgPath = path.join(tmpDir, "serve-token-config.json");
    fs.writeFileSync(
      serveTokCfgPath,
      JSON.stringify({
        ...config, port: 8613,
        stateFile: path.join(tmpDir, "serve-token-state.json"),
        eventsFile: path.join(tmpDir, "serve-token-events.jsonl"),
      })
    );
    const serveTok = spawn("node", [path.join(ROOT, "indexer/indexer.mjs")], {
      env: { ...process.env, CONFIG_PATH: serveTokCfgPath, PINATA_JWT: "", PIN_TOKEN: "sekrit" },
      stdio: "ignore",
    });
    try {
      let tokUp = false;
      for (let i = 0; i < 60 && !tokUp; i++) {
        await new Promise((r) => setTimeout(r, 500));
        tokUp = await raw(8613, "GET", "/api/status").then((r) => r.status === 200).catch(() => false);
      }
      assert.ok(tokUp, "token-serve instance must come up on port 8613");
      // cross-origin + correct token → guard passes (503 unconfigured pinning)
      const withTok = await raw(8613, "POST", "/api/memes/pin", { host: "127.0.0.1:8613", "content-type": "application/json", "x-pin-token": "sekrit" }, jsonBody);
      assert.equal(withTok.status, 503, "cross-origin + correct token passes the guard");
      // cross-origin + wrong token → 403
      const badTok = await raw(8613, "POST", "/api/memes/pin", { host: "127.0.0.1:8613", "content-type": "application/json", "x-pin-token": "wrong" }, jsonBody);
      assert.equal(badTok.status, 403, "cross-origin + wrong token rejected");
      // same-origin WITHOUT token → still allowed (PIN_TOKEN never locks the UI out)
      const sameNoTok = await raw(8613, "POST", "/api/memes/pin", { host: "127.0.0.1:8613", origin: "http://127.0.0.1:8613", "content-type": "application/json" }, jsonBody);
      assert.equal(sameNoTok.status, 503, "same-origin without token still passes (additive semantics)");
    } finally {
      serveTok.kill();
    }
  } finally {
    serve.kill();
    fs.rmSync(path.join(ROOT, "indexer", "public-backup"), { recursive: true, force: true });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n✅ e2e passed: PoW-only ticks with SINGLE-USE nonces (consensus v2: count-in-preimage), mined mints incl. stolen-nonce/format/no-ETH rejections + sold-out boundary, transfers (self/spend-all/valued), full market lifecycle, on-chain ACCEPT BINDING (settleBid pays the bound pendingSeller only), TRADE GATE (not-sold-out tick can't be listed/accepted; invalid accepts carry structured reasons), ledger conserved, state+events replay deterministic");
} finally {
  anvil.kill();
}
