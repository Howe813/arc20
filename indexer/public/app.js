"use strict";
/* arc-20 铭文平台 前端 — 纯原生 JS，零外部依赖
 * API 同源（索引器提供）；钱包经 EIP-6963 多钱包发现（Rainbow/MetaMask/Coinbase…），
 * 回退到注入的 window.ethereum。
 */

// ---------------- 常量 ----------------
const CHAIN_ID_HEX = "0x13b2"; // 5042 Arc (Circle) mainnet
// 钱包 wallet_addEthereumChain 用公共 RPC——切勿在此放带 key 的付费端点，
// 否则 key 会暴露给每个访客并被盗刷。后端索引器/部署另用带 key 的端点（见 config.json）。
// Arc 的原生 gas 代币是 USDC（18 decimals）：所有价格/手续费单位都是 USDC。
const CHAIN_PARAMS = {
  chainId: "0x13b2",
  chainName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.arc.io"],
  blockExplorerUrls: ["https://explorer.arc.io"],
};
const EXPLORER = "https://explorer.arc.io";
const SEL_DEPLOY = "0x9f9ee0ee"; // deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)
const SEL_BUY = "0xd96a094a";    // buy(uint256)
const SEL_CANCEL = "0x40e58ee5"; // cancel(uint256)
const SEL_SWEEP = "0x98b02275";  // sweep(uint256[])
const SEL_PLACEBID = "0xc7df5882"; // placeBid(string,uint128,uint128)
const SEL_CANCELBID = "0x9703ef35"; // cancelBid(uint256)
const SEL_CANCELMANY = "0x2b15e32b"; // cancelMany(uint256[]) — batch-cancel own listings (skip-any)
// Memes launchpad
const SEL_LAUNCH = "0x98110acd";           // launch(string,string,string,uint256)
const SEL_WITHDRAW_CREATOR = "0x38a6fc32"; // withdrawCreator(address)
const SEL_WITHDRAW_TREASURY = "0xf86c9e9a"; // withdrawTreasury(address)
const SEL_PENDING_CREATOR = "0x72d1ae54";  // pendingCreator()
const SEL_PENDING_TREASURY = "0x2ed6b75d"; // pendingTreasury()
const SEL_CREATOR = "0x02d05d3f";          // creator()
const SEL_TREASURY = "0x61d027b3";         // treasury()
const MEME_SUPPLY = 1000000000n * (10n ** 18n); // 1e27, used as launch maxTokenAmount bound
const FEE_BPS = 500n;            // 买卖双边各 5%
const MAX_SWEEP = 50;            // 合约单笔扫单上限

// ---------------- 全局状态 ----------------
let HUB = null;
let MARKET = null;
let LAUNCHPAD = null; // Memes 发射台工厂地址（部署后由 /api/status 下发）
let account = null;          // 已连接地址（小写）
let currentUpdate = null;    // 当前页面的数据刷新函数
let navToken = 0;            // 每次路由切换自增；异步 update() 用它判断是否已过期
let pollTimers = [];
let listingById = new Map(); // 最近渲染的挂单，供买入/撤单使用
let ticksCache = [];

const app = document.getElementById("app");
const $ = (sel, el = document) => el.querySelector(sel);

// ---------------- 工具函数 ----------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 十进制整数字符串加千分位（BigInt 安全）
function fmtInt(s) {
  return String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// wei(BigInt|string) -> ETH 字符串，去掉尾随零
function fmtEth(wei) {
  let v = BigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const int = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + fmtInt(int.toString()) + (frac ? "." + frac : "");
}

// ETH 十进制字符串 -> wei BigInt；非法返回 null
function parseEth(str) {
  str = String(str ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const [i, f = ""] = str.split(".");
  if (f.length > 18) return null;
  return BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}

// 浮点显示（单价等）：有效位截断策略，避免 13px 网格列里出现 12 位小数
function fmtFloat(x) {
  if (!isFinite(x) || x === 0) return "0";
  if (x >= 1e15) return x.toExponential(4);
  if (x < 1e-4) return "<0.0001"; // grid-safe floor for tiny unit prices
  let s = x < 1 ? x.toPrecision(4) : x.toFixed(4); // 4 significant / 4 decimals
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function short(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "-";
}

function addrLink(addr) {
  return `<a class="addr-link" href="${EXPLORER}/address/${esc(addr)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${short(esc(addr))}</a>`;
}
function txLink(hash, label) {
  return `<a class="addr-link" href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(label || short(hash))}</a>`;
}

// UTF-8 字符串 -> 0x 十六进制（铭文均为 ASCII）
function utf8ToHex(s) {
  const bytes = new TextEncoder().encode(s);
  let h = "0x";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h;
}

// 32 字节 ABI word（大端左补零）
function abiWord(v) {
  return BigInt(v).toString(16).padStart(64, "0");
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { msg = (await r.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// ---------------- Custom dropdown (themed replacement for <select>) ----------------
function customSelect(opts, current, onChange) {
  const el = document.createElement("div");
  el.className = "cselect";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "cs-pop";
  pop.hidden = true;
  pop.setAttribute("role", "listbox");
  el.append(btn, pop);
  let cur = current;
  let open = false;
  const labelOf = (v) => { const o = opts.find((x) => x.value === v); return o ? o.label : ""; };
  function render() {
    btn.innerHTML = `<span class="cs-val">${esc(labelOf(cur) || "")}</span><span class="cs-arrow">▾</span>`;
    pop.innerHTML = opts.map((o) =>
      `<button type="button" role="option" aria-selected="${o.value === cur}" class="cs-opt${o.value === cur ? " sel" : ""}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join("");
  }
  // Outside-close via a capture-phase pointerdown on document, attached ONLY
  // while open (removed on close, so it never accumulates). pointerdown fires
  // before click, so it can't race the opening click, and works with real mice
  // and touch alike.
  function onOutside(e) { if (!el.contains(e.target)) close(); }
  function openPop(focusList) {
    if (open) return;
    open = true; pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    if (focusList) { const f = pop.querySelector(".cs-opt.sel") || pop.querySelector(".cs-opt"); if (f) f.focus(); }
  }
  function close(refocusBtn) {
    if (!open) return;
    open = false; pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (refocusBtn) btn.focus(); // keyboard selection returns focus to the trigger
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); open ? close(true) : openPop(); });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openPop(true); }
  });
  pop.addEventListener("keydown", (e) => {
    const items = [...pop.querySelectorAll(".cs-opt")];
    const idx = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (items[idx + 1] || items[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.activeElement?.click(); }
  });
  pop.addEventListener("click", (e) => {
    const o = e.target.closest("[data-v]");
    if (!o) return;
    cur = o.dataset.v; close(true); render();
    if (onChange) onChange(cur);
  });
  render();
  el.getValue = () => cur;
  el.setValue = (v) => { cur = v; render(); };
  // rebuilding options must NOT change the open state
  el.setOptions = (newOpts, keep) => { opts = newOpts; if (keep !== undefined) cur = keep; render(); };
  return el;
}

// ---------------- Toast ----------------
function toast(html, type = "", ttl = 6000) {
  const box = document.getElementById("toasts");
  // 同文本去重：避免同一提示刷屏（如 "miner already running"）
  for (const existing of box.children) {
    if (existing.textContent === html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")) return;
  }
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = html;
  el.addEventListener("click", (e) => { if (e.target.tagName !== "A") el.remove(); });
  box.appendChild(el);
  if (ttl > 0) setTimeout(() => el.remove(), ttl);
}
function toastTx(hash) {
  toast(`Transaction submitted, waiting for confirmation<br>${txLink(hash)}`, "ok", 15000);
}
function txError(e) {
  if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) {
    toast("Cancelled: request rejected by user", "err");
  } else {
    const msg = (e && (e.shortMessage || e.message)) || String(e);
    toast("Action failed: " + esc(msg).slice(0, 300), "err", 9000);
  }
}

// ---------------- 钱包（EIP-6963 多钱包发现）----------------
const wallets = new Map(); // rdns -> { info:{uuid,name,icon,rdns}, provider }
let wallet = null;         // 当前选中的 EIP-1193 provider
const LS_WALLET = "rob20_wallet";

// 监听各钱包（Rainbow / MetaMask / Coinbase…）的广播并请求发现
window.addEventListener("eip6963:announceProvider", (e) => {
  if (e.detail && e.detail.info) wallets.set(e.detail.info.rdns, e.detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

// 可选钱包列表：EIP-6963 自动发现（Rainbow/MetaMask/OKX/Coinbase… 谁装了谁出现），
// 再补上已知的“专用注入”（部分钱包不广播 6963，如 window.okxwallet），按名字去重。
function walletOptions() {
  const byName = new Map(); // name(lower) -> {info, provider}
  const put = (info, provider) => {
    if (!provider) return;
    const k = (info.name || "").toLowerCase();
    if (!byName.has(k)) byName.set(k, { info, provider });
  };
  // 1) EIP-6963 发现结果（带图标，优先）
  for (const d of wallets.values()) put(d.info, d.provider);
  // 2) 专用注入对象
  if (window.okxwallet) put({ name: "OKX Wallet", icon: "", rdns: "com.okex.wallet" }, window.okxwallet);
  if (window.coinbaseWalletExtension) put({ name: "Coinbase Wallet", icon: "", rdns: "com.coinbase.wallet" }, window.coinbaseWalletExtension);
  // 3) window.ethereum（含 providers 多注入数组），按 flag 命名
  const eths = [];
  if (window.ethereum) { eths.push(window.ethereum); if (Array.isArray(window.ethereum.providers)) eths.push(...window.ethereum.providers); }
  for (const p of eths) {
    const name = p.isOkxWallet ? "OKX Wallet" : p.isRainbow ? "Rainbow" : p.isCoinbaseWallet ? "Coinbase Wallet"
      : p.isMetaMask ? "MetaMask" : "Browser Wallet";
    put({ name, icon: "", rdns: "injected:" + name }, p);
  }
  return [...byName.values()];
}

function bindWalletEvents(p) {
  if (!p || !p.on || p._rob20Bound) return;
  p._rob20Bound = true;
  p.on("accountsChanged", (accs) => {
    account = accs && accs[0] ? accs[0].toLowerCase() : null;
    updateWalletUI();
    router();
  });
  p.on("chainChanged", () => { /* 交易时会自动切链 */ });
}

function useWallet(detail) {
  wallet = detail.provider;
  try { localStorage.setItem(LS_WALLET, detail.info.rdns); } catch (_) {}
  bindWalletEvents(wallet);
}

// 弹出钱包选择框，返回选中的 detail（或 null）
// ---------------- R13: accessible dialog helper ----------------
// Overlay with focus trap + Escape close + focus restore. Reused by the wallet
// picker now and by future confirm flows (keep the full disclosure copy when
// refactoring — see R10).
function openDialog({ label, content, onClose }) {
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  if (label) ov.setAttribute("aria-label", label);
  if (content != null) ov.innerHTML = content;
  const prevFocus = document.activeElement;
  const focusables = () => [...ov.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((x) => !x.disabled);
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function close() {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  }
  // keydown is bound on document in capture phase (symmetric with the remove
  // in close()); Escape/Tab work no matter which inner element has focus.
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
  const first = focusables()[0];
  if (first) first.focus();
  return { close, overlay: ov };
}

function walletModal(opts) {
  return new Promise((resolve) => {
    let chosen = null;
    const dlg = openDialog({
      label: "Select wallet",
      content: `
      <div class="wm-box">
        <div class="wm-head">Select Wallet<button class="wm-close" aria-label="Close">×</button></div>
        <div class="wm-list">${opts.map((o, i) => `
          <button class="wm-item" data-i="${i}">
            ${o.info.icon ? `<img src="${esc(o.info.icon)}" alt="">` : `<span class="wm-ph"></span>`}
            <span>${esc(o.info.name)}</span>
          </button>`).join("")}</div>
      </div>`,
      onClose: () => resolve(chosen),
    });
    const ov = dlg.overlay;
    ov.classList.add("wallet-modal");
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest(".wm-close")) return dlg.close(null);
      const it = e.target.closest(".wm-item");
      if (it) { chosen = opts[Number(it.dataset.i)]; dlg.close(); }
    });
  });
}

// 页内确认框（替代原生 confirm()）：键盘可达（Esc 取消、焦点困定）、可样式化、
// 自动化友好。resolve(true)=确认,resolve(false)=取消/Esc/×/点遮罩。
function confirmDialog({ title, bodyHtml, confirmLabel = "Confirm", cancelLabel = "Cancel", collect }) {
  return new Promise((resolve) => {
    let done = false;
    // collect:确认时在 DOM 移除前读取对话框内的输入(resolve {ok:true, data})
    const finish = (v) => {
      done = true;
      resolve(v && collect ? { ok: true, data: collect() } : v);
      dlg.close();
    };
    const dlg = openDialog({
      label: title,
      content: `
      <div class="wm-box confirm-box">
        <div class="wm-head">${esc(title)}<button class="wm-close" aria-label="Close">×</button></div>
        <div class="confirm-body">${bodyHtml}</div>
        <div class="confirm-actions">
          <button class="btn" data-act="cancel">${esc(cancelLabel)}</button>
          <button class="btn btn-primary" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`,
      onClose: () => { if (!done) resolve(false); },
    });
    const ov = dlg.overlay;
    ov.classList.add("wallet-modal");
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest(".wm-close")) return finish(false);
      if (e.target.closest('[data-act="cancel"]')) return finish(false);
      if (e.target.closest('[data-act="ok"]')) return finish(true);
    });
    // 焦点落在主操作（openDialog 默认聚焦第一个可聚焦元素 = × 按钮）
    const ok = ov.querySelector('[data-act="ok"]');
    if (ok) ok.focus();
  });
}

// 确认框内的算力滑条联动：渐变填充 + 大号百分比 + 引擎相关文字说明
window.dlgPowerSync = (engine, v) => {
  v = Math.min(100, Math.max(10, Number(v) || 100));
  const isCpu = engine === "cpu";
  const fill = document.getElementById("dlgPct");
  if (fill) fill.style.backgroundSize = v + "% 100%";
  const label = document.getElementById("dlgPctLabel");
  if (label) label.textContent = v + "%";
  const hint = document.getElementById("dlgPowerHint");
  if (hint) {
    const cores = navigator.hardwareConcurrency || 4;
    hint.textContent = isCpu
      ? `mining with ${Math.max(1, Math.round(cores * v / 100))} of ${cores} logical CPU threads`
      : `dedicates ≈ ${v}% of your GPU compute time to mining`;
  }
};

function updateWalletUI() {
  const btn = $("#walletBtn");  if (account) {
    btn.textContent = short(account);
    btn.title = account + " (click for menu)";
    btn.classList.add("connected");
  } else {
    btn.textContent = "Connect Wallet";
    btn.title = "";
    btn.classList.remove("connected");
    closeWalletMenu();
  }
}

// Wallet dropdown menu (address + Disconnect), shown when clicking the connected button.
let walletMenuEl = null;
function onWalletOutside(e) {
  const btn = $("#walletBtn");
  if (walletMenuEl && !walletMenuEl.contains(e.target) && !btn.contains(e.target)) closeWalletMenu();
}
function closeWalletMenu() {
  if (!walletMenuEl) return;
  walletMenuEl.remove();
  walletMenuEl = null;
  document.removeEventListener("click", onWalletOutside);
}
function openWalletMenu() {
  closeWalletMenu();
  const wrap = $("#walletBtn").parentElement;
  const m = document.createElement("div");
  m.className = "wallet-menu";
  m.innerHTML =
    `<div class="wm-addr" title="${esc(account)}">${esc(short(account))}</div>` +
    `<button type="button" class="wm-item" data-act="my">My Orders</button>` +
    `<button type="button" class="wm-item wm-danger" data-act="disc">Disconnect</button>`;
  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "my") { location.hash = "#/me"; closeWalletMenu(); }
    else { disconnectWallet(); }
  });
  wrap.appendChild(m);
  walletMenuEl = m;
  // Attach the outside-close on the NEXT tick so the click that opened the menu
  // (which bubbles to document) can't immediately close it.
  setTimeout(() => document.addEventListener("click", onWalletOutside), 0);
}
function disconnectWallet() {
  account = null;
  wallet = null; // forget the provider so the next connect re-opens the picker
  try { localStorage.removeItem(LS_WALLET); } catch (_) {}
  closeWalletMenu();
  updateWalletUI();
  router();
  toast("Wallet disconnected", "", 3000);
}

async function connectWallet() {
  if (!wallet) {
    const opts = walletOptions();
    if (!opts.length) {
      toast("No wallet detected. Please install a browser wallet such as Rainbow or MetaMask", "err");
      return null;
    }
    const chosen = opts.length === 1 ? opts[0] : await walletModal(opts);
    if (!chosen) return null; // 用户取消
    useWallet(chosen);
  }
  const accs = await wallet.request({ method: "eth_requestAccounts" });
  account = accs && accs[0] ? accs[0].toLowerCase() : null;
  updateWalletUI();
  return account;
}

async function ensureChain() {
  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (e) {
    const code = e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902));
    if (code) {
      await wallet.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
    } else {
      throw e;
    }
  }
}

// 连接 + 切链，返回账户地址
async function ensureWallet() {
  const acc = await connectWallet();
  if (!acc) throw new Error("Wallet not connected");
  await ensureChain();
  return acc;
}

// 通用发交易：处理按钮状态、错误提示、上链后轮询刷新
async function sendTx(tx, btn) {
  let orig;
  try {
    if (btn) { orig = btn.textContent; btn.disabled = true; btn.textContent = "Waiting for wallet…"; }
    const from = await ensureWallet();
    if (!HUB) await refreshStatus();
    const hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from, ...tx }],
    });
    toastTx(hash);
    schedulePolls();
    return hash;
  } catch (e) {
    txError(e);
    return null;
  } finally {
    if (btn) { btn.disabled = false; if (orig) btn.textContent = orig; }
  }
}

// 交易后按递增间隔轮询 API（索引器有确认延迟）
function schedulePolls() {
  for (const t of pollTimers) clearTimeout(t);
  pollTimers = [2000, 5000, 9000, 15000, 25000, 40000].map((ms) =>
    setTimeout(async () => {
      try {
        await refreshStatus();
        if (currentUpdate) await currentUpdate();
      } catch (_) {}
    }, ms));
}

// ---------------- 铭文/合约交易构造 ----------------
// PoW mint：规范 mint 铭文带 nonce（挖到有效解后由矿工发起）
function powMintText(t, nonce) {
  return `data:,{"p":"arc-20","op":"mint","tick":"${t.tick}","amt":"${t.amountPerMint}","nonce":"${nonce}"}`;
}
function powMintTx(t, nonce) {
  return { to: HUB, value: "0x0", data: utf8ToHex(powMintText(t, nonce)) };
}
function transferTx(to, tick, amt) {
  const text = `data:,{"p":"arc-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`;
  return { to, value: "0x0", data: utf8ToHex(text) };
}
function listTx(tick, amt, priceWei) {
  const text = `data:,{"p":"arc-20","op":"list","tick":"${tick}","amt":"${amt}","price":"${priceWei}"}`;
  return { to: MARKET, value: "0x0", data: utf8ToHex(text) };
}
function deployTx(tick, maxMints, amountPerMint, walletLimit, difficultyBits, epochMints, epochTargetSeconds) {
  // deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32) — 1 动态参数 + 6 静态
  // head 7 words: [0]=tail 偏移 7*32=224, [1..6]=数值参数;tail: 长度 word + tick 字节右补零
  let tickHex = "";
  for (const c of tick) tickHex += c.charCodeAt(0).toString(16).padStart(2, "0");
  const data = SEL_DEPLOY +
    abiWord(224) + abiWord(maxMints) + abiWord(amountPerMint) +
    abiWord(walletLimit) + abiWord(difficultyBits) +
    abiWord(epochMints) + abiWord(epochTargetSeconds) +
    abiWord(tick.length) + tickHex.padEnd(64, "0");
  return { to: HUB, value: "0x0", data };
}

// ---- Memes launchpad tx builders + chain reads ----
// ABI-encode a dynamic string tail segment: length word + right-padded bytes.
function abiStr(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return { hex: abiWord(bytes.length) + padded, byteLen: 32 + Math.ceil(bytes.length / 32) * 32 };
}
function launchTx(name, symbol, imageURI, valueWei) {
  // launch(string name, string symbol, string imageURI, uint256 maxTokenAmount)
  const n = abiStr(name), s = abiStr(symbol), im = abiStr(imageURI);
  const off1 = 128; // 4 head words
  const off2 = 128 + n.byteLen;
  const off3 = 128 + n.byteLen + s.byteLen;
  const data = SEL_LAUNCH + abiWord(off1) + abiWord(off2) + abiWord(off3) + abiWord(MEME_SUPPLY) + n.hex + s.hex + im.hex;
  return { to: LAUNCHPAD, value: "0x" + BigInt(valueWei).toString(16), data };
}

// Upload an image to the indexer, which pins it to IPFS; returns { cid, ipfs, url }.
async function pinAvatar(file) {
  const dataB64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(file);
  });
  const resp = await fetch("/api/memes/pin", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataB64 }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ipfs) throw new Error(j.error || "image pinning failed");
  return j;
}

// Pin a metadata JSON object to IPFS; returns { cid, ipfs, url }.
async function pinJson(obj) {
  const resp = await fetch("/api/memes/pin-json", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: obj }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.ipfs) throw new Error(j.error || "metadata pinning failed");
  return j;
}
function withdrawCreatorTx(token, to) {
  return { to: token, value: "0x0", data: SEL_WITHDRAW_CREATOR + abiWord(to) };
}
function withdrawTreasuryTx(token, to) {
  return { to: token, value: "0x0", data: SEL_WITHDRAW_TREASURY + abiWord(to) };
}
// eth_call via the connected wallet (current chain) if available, else the public RPC.
async function readCall(to, data) {
  const params = [{ to, data }, "latest"];
  if (wallet && account) {
    try { return await wallet.request({ method: "eth_call", params }); } catch (_) {}
  }
  const res = await fetch(CHAIN_PARAMS.rpcUrls[0], {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const readBig = (hex) => (hex && hex !== "0x" ? BigInt(hex) : 0n);

function buyTx(id, priceWei) {
  const price = BigInt(priceWei);
  const pay = price + (price * FEE_BPS) / 10000n; // 买家实付 = price * 1.05（向下取整）
  return { to: MARKET, value: "0x" + pay.toString(16), data: SEL_BUY + abiWord(id) };
}
function cancelTx(id) {
  return { to: MARKET, value: "0x0", data: SEL_CANCEL + abiWord(id) };
}
function sweepTx(ids, payWei) {
  // sweep(uint256[]): selector + offset(0x20) + length + ids...
  let data = SEL_SWEEP + abiWord(32) + abiWord(ids.length);
  for (const id of ids) data += abiWord(id);
  return { to: MARKET, value: "0x" + BigInt(payWei).toString(16), data };
}
// placeBid(string,uint128,uint128): escrow = price + 5%
function placeBidTx(tick, amt, priceWei) {
  let tickHex = "";
  for (const c of tick) tickHex += c.charCodeAt(0).toString(16).padStart(2, "0");
  const data = SEL_PLACEBID + abiWord(96) + abiWord(amt) + abiWord(priceWei) +
    abiWord(tick.length) + tickHex.padEnd(64, "0");
  return { to: MARKET, value: "0x" + buyerPays(priceWei).toString(16), data };
}
function cancelBidTx(id) {
  return { to: MARKET, value: "0x0", data: SEL_CANCELBID + abiWord(id) };
}
// R9: batch-cancel own listings — the contract skips foreign/closed orders and
// returns the number cancelled, so a raced order cannot brick the batch
function cancelManyTx(ids) {
  const body = abiWord(32) + abiWord(ids.length) + ids.map((i) => abiWord(i)).join("");
  return { to: MARKET, value: "0x0", data: SEL_CANCELMANY + body };
}
// accept: a holder binds a bid fill on-chain by sending the accept inscription
// to the MARKET (first come, first served); settleBid can only pay that binding
function acceptTx(tick, bidId) {
  const text = `data:,{"p":"arc-20","op":"accept","tick":"${tick}","bid":"${bidId}"}`;
  return { to: MARKET, value: "0x0", data: utf8ToHex(text) };
}
// 从最便宜的卖单起累加，凑够目标数量；跳过自己的挂单，最多 MAX_SWEEP 手
function computeSweep(asks, targetAmt) {
  const target = BigInt(targetAmt);
  if (target <= 0n) return null;
  let cumAmt = 0n, pay = 0n;
  const ids = [];
  for (const a of asks) {
    if (account && a.seller === account) continue; // 不扫自己的单
    if (ids.length >= MAX_SWEEP) break;
    ids.push(a.id);
    cumAmt += BigInt(a.amt);
    pay += buyerPays(a.price);
    if (cumAmt >= target) break;
  }
  if (!ids.length) return null;
  return { ids, totalAmt: cumAmt, totalPay: pay, count: ids.length, filled: cumAmt >= target };
}
const buyerPays = (p) => BigInt(p) + (BigInt(p) * FEE_BPS) / 10000n;
const sellerGets = (p) => BigInt(p) - (BigInt(p) * FEE_BPS) / 10000n;

// ---------------- 状态栏 ----------------
async function refreshStatus() {
  try {
    const s = await api("/api/status");
    HUB = s.hub;
    MARKET = s.market;
    LAUNCHPAD = s.launchpad || null;
    return s;
  } catch (_) {
    return null;
  }
}

// ---------------- 共用渲染 ----------------
function progressHtml(total, max, big) {
  const pct = max > 0 ? Math.min(100, (total / max) * 100) : 0;
  return `
    <div class="prog${big ? " big" : ""}"><div class="prog-fill" style="width:${pct.toFixed(2)}%"></div></div>
    <div class="prog-label">${fmtInt(String(total))} / ${fmtInt(String(max))} (${pct.toFixed(1)}%)</div>`;
}

function statusPill(t) {
  return t.soldOut
    ? '<span class="pill pill-done">Sold Out</span>'
    : '<span class="pill pill-live pill-pulse">⛏ Live</span>';
}

// Freshly tradable: fully minted but the order book is still empty — the exact
// "buyers can discover, sellers have not shown up" moment (display-only signal).
function newTradableBadge(t) {
  return t.soldOut && !t.listedCount && !t.bidCount
    ? ' <span class="pill pill-live">New tradable</span>'
    : "";
}

function listingStatus(l) {
  if (l.chainStatus === "pending") {
    return l.escrow === "valid"
      ? '<span class="pill pill-warn">Pending Confirmation</span>'
      : '<span class="pill pill-red">Escrow Invalid</span>';
  }
  if (l.chainStatus === "active") return '<span class="pill pill-live">Listed</span>';
  if (l.chainStatus === "sold") return '<span class="pill pill-blue">Sold</span>';
  return '<span class="pill pill-done">Cancelled</span>';
}

function listingCard(l) {
  const price = BigInt(l.price);
  const unit = Number(price) / 1e18 / Number(l.amt || 1);
  const mine = account && l.seller === account;
  let action = "";
  if (mine && (l.chainStatus === "pending" || l.chainStatus === "active")) {
    action = `<button class="btn btn-danger" data-cancel="${l.id}">Cancel</button>`;
  } else if (l.chainStatus === "active") {
    action = `<button class="btn btn-primary" data-buy="${l.id}">Buy · Pay ${fmtEth(buyerPays(price))} USDC</button>`;
  }
  return `
  <div class="card listing">
    <div class="l-head">
      <span class="tick-badge">${esc(l.tick || "?")}</span>
      ${listingStatus(l)}
    </div>
    <div class="l-amt">${fmtInt(l.amt)} <span>${esc(l.tick || "")}</span></div>
    <div class="l-row"><span class="k">Total</span><span class="v hl">${fmtEth(price)} USDC</span></div>
    <div class="l-row"><span class="k">Unit Price</span><span class="v">${fmtFloat(unit)} USDC</span></div>
    <div class="l-row"><span class="k">Seller</span><span class="v">${mine ? "Me" : addrLink(l.seller)}</span></div>
    <div class="l-row"><span class="k">Listing</span><span class="v">#${l.id} · ${txLink(l.listTx)}</span></div>
    ${l.buyer ? `<div class="l-row"><span class="k">Buyer</span><span class="v">${addrLink(l.buyer)}</span></div>` : ""}
    ${action}
  </div>`;
}

// 挂单容器的买入/撤单事件委托
function bindListingActions(grid) {
  grid.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-buy],[data-cancel]");
    if (!btn) return;
    const id = btn.dataset.buy || btn.dataset.cancel;
    const l = listingById.get(String(id));
    if (!l) return;
    if (btn.dataset.buy) {
      await sendTx(buyTx(l.id, l.price), btn);
    } else {
      await sendTx(cancelTx(l.id), btn);
    }
  });
}

function connectPrompt(msg) {
  return `<div class="card empty">
    <p style="margin-bottom:12px">${esc(msg || "Please connect your wallet first")}</p>
    <button class="btn btn-primary" onclick="connectWalletAndRerender()">Connect Wallet</button>
  </div>`;
}
// 供 connectPrompt 内联调用
window.connectWalletAndRerender = async function () {
  try {
    await connectWallet();
    router();
  } catch (e) { txError(e); }
};

// ---------------- 页面：首页（发现）----------------
const ACT = {
  mint: { label: "Mint", cls: "act-mint" },
  trade: { label: "Trade", cls: "act-trade" },
  list: { label: "List", cls: "act-list" },
  bid: { label: "Bid", cls: "act-bid" },
  deploy: { label: "Deploy", cls: "act-deploy" },
  launch: { label: "Launch", cls: "act-deploy" },
  soldout: { label: "Sold Out", cls: "act-mint" },
};
function floorUnit(t) { return t.floor ? unitEth(t.floor.price, t.floor.amt) : Infinity; }

async function pageHome() {
  const myNav = navToken;
  let sortKey = "volume", filter = "all", search = "";
  let actType = "all", actPage = 0, actTotal = 0, actWindowed = false; // activity feed: filter + pagination over the in-memory window

  app.innerHTML = `
    <div class="eyebrow">Arc-20 is mining</div>
    <h1 class="hero-title">Fair-launch inscriptions,<br>mined into existence</h1>
    <p class="hero-sub">No presale, no team allocation, no mint fee. Every unit of every tick is
    unlocked by proof-of-work — find a nonce, claim your share.</p>
    <div class="card" id="mintStat" style="display:flex;gap:22px;flex-wrap:wrap;padding:10px 14px"><span class="muted small">Loading network mint heat…</span></div>
    <div class="discover-controls">
      <input id="searchTick" class="mono" placeholder="Search tick…" autocomplete="off" spellcheck="false">
      <div class="filters" id="filters">
          <button data-f="all" class="active">All</button>
          <button data-f="live">⛏ Live</button>
          <button data-f="soldout">Sold Out</button>
          <button data-f="market">Tradable</button>
      </div>
      <div id="sortSelMount"></div>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th>Tick</th><th style="min-width:170px">Mint Progress</th><th>Price / unit (USDC)</th>
          <th>Volume</th><th>Holders</th><th>Status</th>
        </tr></thead>
        <tbody id="tickRows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>Activity</h2>
        <div class="filters" id="actFilters">
          <button data-at="all" class="active">All</button>
          <button data-at="mint">Mint</button>
          <button data-at="trade">Trade</button>
          <button data-at="list">List</button>
          <button data-at="bid">Bid</button>
          <button data-at="deploy">Deploy</button>
          <button data-at="launch">Launch</button>
          <button data-at="soldout">Sold out</button>
        </div>
      </div>
      <div class="activity" id="activity"><div class="empty small">Loading…</div></div>
      <div class="pager" id="actPager"></div>
    </div>`;

  function renderTicks() {
    let rows = ticksCache.slice();
    if (search) rows = rows.filter((t) => t.tick.includes(search));
    if (filter === "live") rows = rows.filter((t) => !t.soldOut);
    else if (filter === "soldout") rows = rows.filter((t) => t.soldOut);
    else if (filter === "market") rows = rows.filter((t) => t.listedCount > 0 || t.bidCount > 0);
    const cmp = {
      volume: (a, b) => (BigInt(b.volumeWei) > BigInt(a.volumeWei) ? 1 : BigInt(b.volumeWei) < BigInt(a.volumeWei) ? -1 : 0),
      newest: (a, b) => b.deployBlock - a.deployBlock,
      // recently-opened trades first, then most recently sold out
      newTradable: (a, b) => {
        const an = a.soldOut && !a.listedCount && !a.bidCount ? 1 : 0;
        const bn = b.soldOut && !b.listedCount && !b.bidCount ? 1 : 0;
        if (an !== bn) return bn - an;
        return (b.soldOutAt || 0) - (a.soldOutAt || 0) || b.deployBlock - a.deployBlock;
      },
      floor: (a, b) => floorUnit(a) - floorUnit(b),
      holders: (a, b) => b.holders - a.holders,
      progress: (a, b) => b.totalMints / b.maxMints - a.totalMints / a.maxMints,
    }[sortKey];
    rows.sort(cmp);
    $("#tickRows").innerHTML = rows.length ? rows.map((t) => `
      <tr class="clickable" data-tick="${esc(t.tick)}" tabindex="0" role="link" aria-label="Open ${esc(t.tick)}">
        <td><a href="#/tick/${esc(t.tick)}"><span class="tick-badge">${esc(t.tick)}</span></a>${t.pow ? ' <span class="pill pill-live">⛏ PoW</span>' : ""}</td>
        <td>${progressHtml(t.totalMints, t.maxMints)}</td>
        <td class="mono">${t.floor ? fmtFloat(floorUnit(t)) + ' <span class="muted small">USDC</span>' : '<span class="muted">—</span>'}</td>
        <td class="mono">${BigInt(t.volumeWei) > 0n ? fmtEth(t.volumeWei) + " USDC" : '<span class="muted">—</span>'}</td>
        <td class="mono">${fmtInt(String(t.holders))}</td>
        <td>${statusPill(t)}${newTradableBadge(t)}</td>
      </tr>`).join("")
      : `<tr><td colspan="6" class="empty">${ticksCache.length ? "No matching ticks" : 'No ticks yet — <a href="#/deploy">deploy</a> the first one'}</td></tr>`;
  }

  function renderActivity(acts) {
    $("#activity").innerHTML = acts.length ? acts.map((a) => {
      const meta = ACT[a.type] || { label: a.type, cls: "" };
      const unit = a.price && a.amt ? ` @ ${fmtFloat(unitEth(a.price, a.amt))}` : "";
      // dedicated branches for types that lack tick/amt fields (a plain
      // `${fmtInt(a.amt)} ${a.tick}` would render "undefined undefined")
      const detail = a.type === "mint" ? `Mint #${fmtInt(String(a.n))}`
        : a.type === "deploy" ? "Created tick"
        : a.type === "launch" ? `Launched a meme coin — <a class="addr-link" href="#/memes/${esc(a.token)}">open ↗</a>`
        : a.type === "soldout" ? "Fully minted — trading open (list/bid now valid)"
        : `${fmtInt(a.amt)} ${esc(a.tick)}${unit}`;
      const tickCell = a.type === "launch"
        ? `<a href="#/memes/${esc(a.token)}" class="act-tick">${short(a.token || "")}</a>`
        : `<a href="#/tick/${esc(a.tick)}" class="act-tick">${esc(a.tick)}</a>`;
      return `
        <div class="act-row">
          <span class="act-tag ${meta.cls}">${meta.label}</span>
          ${tickCell}
          <span class="act-detail mono">${detail}</span>
          <span class="act-who">${addrLink(a.actor)}</span>
          <span class="act-block mono muted">${txLink(a.tx, "#" + fmtInt(String(a.block)))}</span>
        </div>`;
    }).join("") : `<div class="empty small">No activity</div>`;
  }

  function renderActPager() {
    const pages = Math.max(1, Math.ceil(actTotal / 20));
    if (actPage >= pages) actPage = pages - 1;
    $("#actPager").innerHTML = `
      <button class="btn small" id="actPrev" ${actPage <= 0 ? "disabled" : ""}>← Prev</button>
      <span class="pager-info muted small">Page ${actPage + 1} / ${pages}</span>
      <button class="btn small" id="actNext" ${actPage >= pages - 1 ? "disabled" : ""}>Next →</button>
      ${actWindowed ? `<div class="muted small" style="margin-top:6px">Showing the indexer's latest activity window (≤ 300 events) — full trade history: <a href="#/me">My Trades</a></div>` : ""}`;
    $("#actPrev").addEventListener("click", () => { if (actPage > 0) { actPage--; updateActivity(); } });
    $("#actNext").addEventListener("click", () => {
      const p = Math.max(1, Math.ceil(actTotal / 20));
      if (actPage < p - 1) { actPage++; updateActivity(); }
    });
  }

  async function updateActivity() {
    try {
      const typeParam = actType && actType !== "all" ? actType : ""; // "all" = no filter
      const q = `/api/activity?type=${encodeURIComponent(typeParam)}&offset=${actPage * 20}&limit=20`;
      const av = await api(q);
      if (myNav !== navToken) return;
      actTotal = Number(av.total) || 0;
      actWindowed = av.windowed === true; // total counts the in-memory window only
      renderActivity(av.activity);
      renderActPager();
    } catch (e) {
      if (myNav !== navToken) return;
      const el = $("#activity");
      if (el) {
        el.innerHTML = `<div class="empty small">Failed to load activity: ${esc(e.message)} <button class="btn small" id="actRetry">Retry</button></div>`;
        $("#actRetry")?.addEventListener("click", () => updateActivity());
      }
    }
  }

  // R14 分区降级：ticks / status / activity 各自独立 try-catch，单区失败不影响
  // 其它分区；失败写分区级错误 + Retry，且不再阻断 currentUpdate——SSE/兜底轮询
  // 恢复后页面自愈，无需手动刷新。
  async function update() {
    try {
      const td = await api("/api/ticks?limit=1000");
      if (myNav !== navToken) return;
      ticksCache = td.ticks;
      renderTicks();
    } catch (e) {
      if (myNav !== navToken) return;
      const rows = $("#tickRows");
      if (rows) {
        rows.innerHTML = `<tr><td colspan="6" class="empty">Failed to load ticks: ${esc(e.message)} <button class="btn small" id="tickRetry">Retry</button></td></tr>`;
        $("#tickRetry")?.addEventListener("click", () => update());
      }
    }
    try {
      const st = await api("/api/status");
      if (myNav !== navToken) return;
      const stat = $("#mintStat");
      if (stat) {
        stat.innerHTML = `
        <span>⛏ 24h mints: <b class="mono">${fmtInt(String(st.mints24h ?? 0))}</b></span>
        <span>👥 Active miners (24h): <b class="mono">${fmtInt(String(st.activeMiners24h ?? 0))}</b></span>
        <span class="muted small">(window: latest 100 mints known to the indexer)</span>`;
      }
    } catch (_) { /* heat metric is optional — keep the rest of the page */ }
    await updateActivity();
  }

  $("#searchTick").addEventListener("input", (e) => { search = e.target.value.trim().toLowerCase(); renderTicks(); });
  $("#sortSelMount").appendChild(customSelect(
    [
      { value: "volume", label: "Volume ↓" },
      { value: "newTradable", label: "New tradable ↓" },
      { value: "newest", label: "Newest" },
      { value: "floor", label: "Floor ↑" },
      { value: "holders", label: "Holders ↓" },
      { value: "progress", label: "Mint Progress ↓" },
    ],
    sortKey,
    (v) => { sortKey = v; renderTicks(); }
  ));
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    filter = b.dataset.f;
    for (const x of $("#filters").children) x.classList.toggle("active", x === b);
    renderTicks();
  });
  // R13 键盘可达：tick 行 tabindex+Enter/Space 与鼠标点击同效（badge 的 <a> 自带导航）
  const tickRows = $("#tickRows");
  tickRows.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-tick]");
    if (row && !e.target.closest("a")) location.hash = "#/tick/" + row.dataset.tick;
  });
  tickRows.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr[data-tick]")) {
      e.preventDefault();
      location.hash = "#/tick/" + e.target.dataset.tick;
    }
  });
  $("#actFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-at]");
    if (!b) return;
    actType = b.dataset.at;
    actPage = 0; // reset to first page on filter change
    for (const x of $("#actFilters").children) x.classList.toggle("active", x === b);
    updateActivity();
  });

  await update();
  if (myNav !== navToken) return; // 页面已切走：不得覆盖新页面的刷新钩子
  currentUpdate = update;
}

// ---------------- PoW 挖矿器（浏览器 CPU） ----------------
// Worker 后台暴力搜索 nonce（keccak256(miner, tickHash, nonce, mintsOf) 需满足前导零
// 难度，与合约 InscriptionHub 逐字节一致；已铸张数参与哈希 → 每个解一次性）；主线程
// 在解出后发 mint 交易、跟踪难度重定向，并自动继续挖下一张，直到用户停止或 tick 售罄。
// 无效 mint 会被合约回退——只耗 gas。
const MINER_WORKER_SRC = `
// keccak256/powPreimage/meetsDifficulty 由 startMiner 内联在 blob 顶部（fetch
// /keccak.mjs 源码拼接）——blob 模块 worker 里 "/keccak.mjs" 的绝对路径 import
// 在 Chromium 下静默加载失败（MIME 正确仍报错），内联是唯一可靠方式。
let stop = false;
self.onmessage = (e) => {
  const d = e.data;
  if (d.cmd === "stop") { stop = true; return; }
  if (d.cmd !== "mine") return;
  stop = false;
  const { addr, th, bits, startNonce, mints } = d;
  // 共识 v2：92 字节预映像 = 地址(20B)++tickHash(32B)++nonce(32B)++已铸张数(8B)
  const pre = powPreimage(addr, th, 0, mints || 0); // 只改写 nonce 段
  const setNonce = (v) => { let x = BigInt(v); for (let i = 83; i >= 52; i--) { pre[i] = Number(x & 0xffn); x >>= 8n; } };
  let n = BigInt(startNonce || 0), tries = 0;
  const t0 = Date.now();
  setNonce(n);
  while (!stop) {
    tries++;
    if (meetsDifficulty(keccak256(pre), bits)) {
      self.postMessage({ found: n.toString(), tries, ms: Date.now() - t0 });
      return;
    }
    n++; setNonce(n);
    if ((tries & 8191) === 0) {
      const sec = (Date.now() - t0) / 1000;
      self.postMessage({ hashrate: sec > 0 ? Math.round(tries / sec) : 0, tries });
    }
  }
  self.postMessage({ stopped: true });
};`;

let minerCtl = null; // 当前挖矿会话（同一时间只跑一个）
let keccakWorkerLib = null; // /keccak.mjs 源码缓存（内联进 worker blob）

// 卸页兜底：单个常驻监听终止在跑的 worker（替代旧的按会话 once 监听——
// 会话内反复启停会累积闭包并持有已终止的 worker 引用）
window.addEventListener("beforeunload", () => {
  try { if (minerCtl) killMiner(minerCtl); } catch (_) {}
});

function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 90) return Math.round(sec) + "s";
  if (sec < 5400) return Math.round(sec / 60) + "min";
  if (sec < 129600) return (sec / 3600).toFixed(1) + "h";
  return (sec / 86400).toFixed(1) + "d";
}

async function startMiner(t, box, opts = {}) {
  const engineSel = opts.engine || "auto";
  const pct = Math.min(100, Math.max(10, opts.pct || 100));
  if (minerCtl) {
    // 页面轮询会整体重建 DOM：面板若已被冲掉（不在文档里），先清掉旧会话再重开
    if (minerCtl.tick === t.tick && minerCtl.el && document.contains(minerCtl.el)) {
      return toast("A miner is already running — stop it first", "err");
    }
    // 先置 stopped 再终止：旧会话解出 nonce 后的在途异步续体恢复时必须
    // 立即中断，否则会发起幽灵 mint 交易（多余 gas/意外钱包弹窗）并把日志写进
    // 新会话的面板。
    minerCtl.stopped = true;
    killMiner(minerCtl);
    minerCtl = null;
  }
  let from;
  try { from = await ensureWallet(); if (!HUB) await refreshStatus(); } catch (e) { return txError(e); }

  // 共识 v2：预映像第 4 段 = 该地址对本 tick 的已铸张数，由索引器 tick 详情接口下发
  // （?miner= 参数），worker 不直接 RPC。
  let myMints = 0;
  try { myMints = (await api("/api/tick/" + encodeURIComponent(t.tick) + "?miner=" + from)).minerMints ?? 0; } catch (_) {}

  // ---- 引擎解析：GPU(WebGPU) 可用性 + 自校验,失败按语义回退 ----
  let engine = "cpu"; // "gpu" | "cpu"
  let gpu = null;
  if (engineSel !== "cpu" && navigator.gpu) {
    try {
      const gpuMod = await import("/wgpu-miner.mjs");
      gpu = await gpuMod.GpuMiner.create();
      // 自校验：GPU 摘要与 JS 权威逐字节比对——不一致绝不进 GPU 路径(防烧 gas)
      const { keccak256, powPreimage } = await import("/keccak.mjs");
      gpu.setBase(from, t.tickHash, myMints);
      const probe = await gpu.mineBatch(12345n, 0, 1);
      const expect = keccak256(powPreimage(from, t.tickHash, 12345n, myMints));
      if (probe.digestHex !== expect) throw new Error("GPU self-test mismatch");
      engine = "gpu";
    } catch (e) {
      gpu = null;
      if (engineSel === "gpu") {
        box.innerHTML = `<div class="muted small miner-panel">WebGPU init failed: ${esc(String((e && e.message) || e))} — falling back is disabled (GPU was explicitly selected).</div>`;
        minerCtl = null;
        return;
      }
      engine = "cpu"; // auto：静默回退 CPU
    }
  }

  // CPU 引擎：worker 数 = 逻辑核 × 百分比（至少 1）
  const nWorkers = Math.max(1, Math.round((navigator.hardwareConcurrency || 4) * pct / 100));
  const STRIDE = 1n << 32n; // 各 worker 的 nonce 空间间隔

  // worker 源码 = keccak.mjs 全文内联 + 挖矿循环（blob worker 无法 import 绝对路径,
  // 见 MINER_WORKER_SRC 注释）。源码只取一次,之后复用缓存。
  if (engine === "cpu" && !keccakWorkerLib) {
    try {
      keccakWorkerLib = await (await fetch("/keccak.mjs")).text();
    } catch (e) {
      box.innerHTML = `<div class="muted small miner-panel">Miner failed to load (keccak lib): ${esc(String(e && e.message || e))}</div>`;
      minerCtl = null;
      return;
    }
  }
  const workerBlob = engine === "cpu" ? URL.createObjectURL(new Blob([keccakWorkerLib, "\n", MINER_WORKER_SRC], { type: "text/javascript" })) : null;

  const engineLabel = engine === "gpu" ? `⛏ GPU (WebGPU) @ ${pct}%` : `CPU ×${nWorkers} @ ${pct}%`;
  const ctl = minerCtl = {
    stopped: false, minedBits: null, el: null, tick: t.tick,
    expected: t.pow ? BigInt(t.pow.expectedTries) : 0n, solved: 0, triesAll: 0n,
    workers: [], gpu, engine, nWorkers, workerRate: new Array(nWorkers).fill(0),
    workerTries: new Array(nWorkers).fill(0), foundBusy: false,
    nextSendAt: 0, lastActivity: Date.now(), watchdog: null,
    stop: () => stopUi("Mining stopped."),
  };

  box.innerHTML = `
    <div class="miner-panel mining">
      <div class="miner-row"><span><span class="miner-pick">⛏</span> Mining <b>${esc(t.tick)}</b> (difficulty ${fmtInt(String(t.pow.difficultyBits))} bits)</span>
        <button class="btn small" id="minerStop">Stop</button></div>
      <div class="miner-stats mono">${engineLabel} · <span id="minerRate">…</span> H/s · tried <span id="minerTries">0</span> / ≈${fmtInt(t.pow.expectedTries)} · ETA <span id="minerEta">…</span>/mint</div>
      <div class="miner-bar"><div id="minerFill" style="width:0%"></div></div>
      <div class="muted small" id="minerScore">Session solved: 0 · On-chain total: ${fmtInt(String(myMints))}</div>
      <div class="muted small">Continuous mode: every found nonce auto-requests a signature and pays USDC gas; failed attempts can still burn gas; press Stop to halt at any time.</div>
      <div class="muted small" id="minerLog"></div>
    </div>`;
  ctl.el = box.querySelector(".miner-panel");
  const mintCard = box.closest(".mint-card");
  if (mintCard) mintCard.classList.add("mining");
  // 面板元素一律从 ctl.el 内部查询（而非全局 $()）：SSE 重建会把面板搬进新 DOM,
  // 全局查询在失联/重挂的时序窗口里会写进错误的节点 → UI 冻结在初始值。
  const q = (sel) => ctl.el.querySelector(sel);
  const log = (msg) => { const el = q("#minerLog"); if (el) el.textContent = msg; };
  // 高难度提示：按引擎明示预期（GPU 40 bits ≈ 分钟级,CPU 基本无机会）
  if (ctl.expected > (1n << 34n)) {
    log(engine === "gpu"
      ? `ℹ Difficulty ≈ ${fmtInt(ctl.expected.toString())} hashes/mint — the WebGPU miner searches on your GPU; at ~0.5-1 GH/s expect ≈ ${fmtEta(Number(ctl.expected / 500000000n))} per mint.`
      : `⚠ Difficulty ≈ ${fmtInt(ctl.expected.toString())} hashes/mint — a browser CPU almost certainly cannot find a block (mainnet difficulty targets GPU miners); switch the engine to GPU in the start dialog or mine such ticks with external GPU software.`);
  }
  const stopUi = (msg) => {
    ctl.stopped = true;
    killMiner(ctl);
    if (minerCtl === ctl) minerCtl = null;
    // SSE 重渲染会把面板 appendChild 搬进新 DOM：操作 ctl.el 的当前位置
    //（当前所在卡片 + 当前父容器），而不是闭包里的旧 box——否则停止后面板与
    // 条纹动画残留在新 DOM 里，UI 显示仍在挖矿而 worker 已终止。
    if (ctl.el) {
      const curCard = ctl.el.closest(".mint-card");
      if (curCard) curCard.classList.remove("mining");
      const parent = ctl.el.parentNode;
      ctl.el.remove();
      if (parent && parent.isConnected) {
        parent.innerHTML = msg ? `<div class="muted small miner-panel">${esc(msg)}</div>` : "";
      }
    }
  };
  ctl.stop = () => stopUi("Mining stopped.");
  // 停止按钮走文档级事件委托：面板/按钮被 SSE 重建搬运时，委托监听永不丢失
  //（此前在实例上绑定，重建窗口里 #minerStop 查询为 null → 绑定崩溃 → 循环
  // 静默死亡 + Stop 失效，用户只能刷新页面）。
  ctl.watchdog = setInterval(() => {
    if (ctl.stopped) { clearInterval(ctl.watchdog); return; }
    if (Date.now() - ctl.lastActivity > 8000 && !ctl.foundBusy) {
      clearInterval(ctl.watchdog);
      log("⚠ Miner stalled (no progress for 8s) — stopping. Try the other engine or another browser.");
      stopUi("⚠ Miner stalled — try the CPU engine or another browser.");
    }
  }, 2000);

  // UI 更新（聚合 CPU 多 worker / GPU 批次）
  const uiRate = () => {
    ctl.lastActivity = Date.now();
    const rate = q("#minerRate"), tries = q("#minerTries"), fill = q("#minerFill"), eta = q("#minerEta");
    const totalRate = engine === "gpu" ? ctl.gpuRate || 0 : ctl.workerRate.reduce((a, b) => a + (b || 0), 0);
    const totalTries = engine === "gpu" ? ctl.triesAll : ctl.workerTries.reduce((a, b) => a + (b || 0), 0);
    if (rate) rate.textContent = fmtInt(String(totalRate));
    if (tries) tries.textContent = fmtInt(String(totalTries));
    if (fill && ctl.expected > 0n) {
      const cur = BigInt(totalTries) % ctl.expected; // 本张进度（取模：跨张累计时回到进度条起点）
      fill.style.width = Math.min(100, Number(cur * 10000n / ctl.expected) / 100) + "%";
    }
    if (eta && totalRate > 0) {
      const rem = Number(ctl.expected - (BigInt(totalTries) % ctl.expected));
      eta.textContent = fmtEta(Math.max(0, rem / totalRate));
    }
  };

  // 解出 nonce 的共享处理：冷却闸 → 刷新 tick → 售罄/重定向检查 → 发交易。
  // respawn(mints, bits, nextNonce)：由调用方继续挖（CPU 重开 worker 池 / GPU 续批）。
  // 30s 反刷屏冷却：上一个解广播后 30s 内不再发下一笔(挖矿继续,发送排队等待)。
  const MINT_COOLDOWN_MS = 30000;
  const processFound = async (foundNonce, triesStr, respawn) => {
    // 出块闪光：面板绿色一闪，进度条打满
    ctl.lastActivity = Date.now();
    if (ctl.el) {
      ctl.el.classList.add("found");
      setTimeout(() => ctl.el && ctl.el.classList.remove("found"), 900);
    }
    const fill = q("#minerFill");
    if (fill) fill.style.width = "100%";
    if (Date.now() < ctl.nextSendAt) {
      const waitMs = ctl.nextSendAt - Date.now();
      for (let left = Math.ceil(waitMs / 1000); left > 0 && !ctl.stopped; left = Math.ceil((ctl.nextSendAt - Date.now()) / 1000)) {
        log(`Anti-spam cooldown: next mint in ${left}s…`);
        await new Promise((s) => setTimeout(s, Math.min(1000, waitMs)));
      }
      if (ctl.stopped) return;
    }
    let fresh;
    try { fresh = await api("/api/tick/" + encodeURIComponent(t.tick) + "?miner=" + from); } catch { fresh = null; }
    if (ctl.stopped) return;
    if (!fresh || fresh.soldOut) return stopUi("Tick sold out — mining ended.");
    if (!fresh.pow || fresh.pow.difficultyBits !== ctl.minedBits) {
      const nb = fresh && fresh.pow ? fresh.pow.difficultyBits : null;
      log(`Difficulty retargeted ${ctl.minedBits} → ${nb} bits — discarding nonce, keep mining…`);
      ctl.expected = fresh && fresh.pow ? BigInt(fresh.pow.expectedTries) : ctl.expected;
      ctl.minedBits = nb;
      respawn(fresh.minerMints ?? 0, nb, BigInt(foundNonce) + 1n);
      return;
    }
    log(`Nonce ${foundNonce} found (${triesStr} tries) — sending mint tx…`);
    const hash = await sendTx(powMintTx(fresh, foundNonce));
    if (ctl.stopped) return;
    log(hash ? `Tx broadcast ${txLink(hash)} — mining the next one…` : "Tx not sent — mining the next one… (reject the signature in your wallet anytime to stop)");
    ctl.nextSendAt = Date.now() + MINT_COOLDOWN_MS; // 本账户 30s 冷却
    ctl.solved += 1;
    const score = q("#minerScore");
    if (score) score.textContent = `Session solved: ${ctl.solved} · On-chain total: ${fmtInt(String((fresh.minerMints ?? 0) + 1))}`;
    if (score) score.textContent = `Session solved: ${ctl.solved} · On-chain total: ${fmtInt(String((fresh.minerMints ?? 0) + 1))}`;
    // 本次 mint 若成功，链上计数将 +1（乐观推进）；若交易失败，下一轮解出时会
    // 重新拉取 fresh.minerMints，以服务器值为准自动纠偏。
    respawn((fresh.minerMints ?? 0) + 1, ctl.minedBits, BigInt(foundNonce) + 1n);
  };

  if (engine === "gpu") {
    // ---- GPU 路径：批量派发 + 周期同步（难度重定向/售罄）----
    ctl.gpuRate = 0;
    gpu.setBase(from, t.tickHash, myMints);
    let cursor = 0n;
    let mints = myMints;
    let bits = t.pow.difficultyBits;
    ctl.minedBits = bits;
    let lastSync = Date.now();
    let lastBatchAt = Date.now();
    const batch = Math.max(200000, Math.round(2000000 * pct / 100));
    const gap = Math.round((100 - pct) * 2); // 百分比越低,批间空闲越久
    // 任何未捕获异常都写进面板(此前静默死亡 → 用户只看到 tried 0 冻结)
    (async () => {
      try {
        while (!ctl.stopped) {
          const r = await gpu.mineBatch(cursor, bits, batch);
          if (ctl.stopped) return;
          lastBatchAt = Date.now();
          ctl.triesAll += BigInt(r.hashes);
          ctl.gpuRate = Math.round((r.hashes / Math.max(1, r.ms)) * 1000);
          uiRate();
          if (r.found) {
            await processFound(r.nonceBig, fmtInt(String(ctl.triesAll)), (m, b, next) => {
              mints = m; bits = b; ctl.minedBits = b; cursor = next;
              gpu.setBase(from, t.tickHash, mints);
            });
            if (ctl.stopped) return;
            lastSync = Date.now();
          } else {
            cursor += BigInt(batch);
          }
          // 周期同步：其他人挖满 epoch 触发重定向/售罄时,无需等自己解出才感知
          if (Date.now() - lastSync > 20000) {
            lastSync = Date.now();
            try {
              const fresh = await api("/api/tick/" + encodeURIComponent(t.tick) + "?miner=" + from);
              if (!fresh || fresh.soldOut) return stopUi("Tick sold out — mining ended.");
              if (fresh.pow && fresh.pow.difficultyBits !== bits) {
                log(`Difficulty retargeted ${bits} → ${fresh.pow.difficultyBits} bits — continuing…`);
                bits = fresh.pow.difficultyBits;
                ctl.minedBits = bits;
                ctl.expected = BigInt(fresh.pow.expectedTries);
              }
            } catch (_) {}
          }
          if (gap) await new Promise((s) => setTimeout(s, gap));
        }
      } catch (e) {
        if (!ctl.stopped) {
          log(`Miner error: ${esc(String((e && e.message) || e)).slice(0, 160)} — stopping.`);
          stopUi("Miner stopped (error).");
        }
      }
    })();
    // 看门狗：首批 8 秒未完成 / 批间卡死 > 8 秒 → 面板可见化(而非无声冻结)
    const watchdog = setInterval(() => {
      if (ctl.stopped) { clearInterval(watchdog); return; }
      if (Date.now() - lastBatchAt > 8000) {
        clearInterval(watchdog);
        log(`⚠ GPU batch stalled (no completion for ${Math.round((Date.now() - lastBatchAt) / 1000)}s) — your GPU/driver may be blocking WebGPU compute. Try the CPU engine, another browser, or press Stop.`);
        stopUi("⚠ GPU batch stalled — see log. Try the CPU engine or another browser.");
      }
    }, 2000);
    ctl.watchdog = watchdog;
    return;
  }

  // ---- CPU 路径：N worker 池（STRIDE 分段；任一解出 → 全池重建,保证预映像计数一致）----
  const spawnCpu = (baseMints, bits, nextNonce) => {
    ctl.minedBits = bits;
    ctl.workerRate = new Array(nWorkers).fill(0);
    ctl.workerTries = new Array(nWorkers).fill(0);
    for (let k = 0; k < nWorkers; k++) {
      const w = new Worker(workerBlob, { type: "module" });
      w.onmessage = (e) => {
        const d = e.data;
        if (ctl.stopped) return;
        if (d.hashrate !== undefined) {
          ctl.workerRate[k] = d.hashrate || 0;
          ctl.workerTries[k] = d.tries || 0;
          uiRate();
          return;
        }
        if (d.found !== undefined) {
          // 串行化：任一解出 → 终止全池 → 共享处理 → 以新计数重建
          if (ctl.foundBusy) return;
          ctl.foundBusy = true;
          killWorkers(ctl);
          processFound(d.found, fmtInt(String(d.tries)), (m, b, next) => {
            spawnCpu(m, b, next);
          }).then(() => { ctl.foundBusy = false; }).catch(() => { ctl.foundBusy = false; });
        }
      };
      w.onerror = (e) => {
        if (ctl.stopped) return;
        log(`Miner error: ${String(e.message || e).slice(0, 160)} — stopping.`);
        stopUi("Miner stopped (error).");
      };
      w.postMessage({ cmd: "mine", addr: from, th: t.tickHash, bits, startNonce: (nextNonce + BigInt(k) * STRIDE).toString(), mints: baseMints });
      ctl.workers.push(w);
    }
  };
  spawnCpu(myMints, t.pow.difficultyBits, 0n);
}

// 终止会话的全部执行体（workers 池 / GPU device / 看门狗）
function killMiner(ctl) {
  try { (ctl.workers || []).forEach((w) => w.terminate()); } catch (_) {}
  try { if (ctl.gpu) ctl.gpu.destroy(); } catch (_) {}
  try { if (ctl.watchdog) clearInterval(ctl.watchdog); } catch (_) {}
  ctl.workers = [];
}
function killWorkers(ctl) {
  try { (ctl.workers || []).forEach((w) => w.terminate()); } catch (_) {}
  ctl.workers = [];
}

// ---------------- 页面：Tick 详情 ----------------
async function pageTick(tick) {
  const myNav = navToken;
  app.innerHTML = `<a class="back-link" href="#/">← Back to Home</a><div id="tickBody"><div class="card empty">Loading…</div></div>`;
  const body = $("#tickBody");

  // 挖矿进行中的轻量刷新：只更新进度/售罄数字，不触碰面板与监听（防撕裂）
  function lightTickRefresh(bodyEl, t) {
    const fill = bodyEl.querySelector(".mint-card .prog-fill");
    const label = bodyEl.querySelector(".mint-card .prog-label");
    const pct = t.maxMints > 0 ? Math.min(100, (t.totalMints / t.maxMints) * 100) : 0;
    if (fill) fill.style.width = pct.toFixed(2) + "%";
    if (label) label.textContent = `${fmtInt(String(t.totalMints))} / ${fmtInt(String(t.maxMints))} (${pct.toFixed(1)}%)`;
    const gate = bodyEl.querySelector(".hint-box");
    if (gate && !t.soldOut) {
      gate.textContent = `⚠ Market gate: this tick must be 100% minted (sold out) before listing/accepting — earlier ones are dead orders (ledger-invalid). Minted ${fmtInt(String(t.totalMints))} / ${fmtInt(String(t.maxMints))}.`;
    }
  }

  async function update() {
    let t, hd, miners;
    try {
      const minersP = api("/api/miners?tick=" + encodeURIComponent(tick) + "&limit=10").then((r) => r.miners || []).catch(() => []);
      [t, hd, miners] = await Promise.all([api("/api/tick/" + encodeURIComponent(tick)), api("/api/tick/" + encodeURIComponent(tick) + "/holders"), minersP]);
    } catch (e) {
      if (myNav === navToken) body.innerHTML = `<div class="card error-card">Failed to load: ${esc(e.message)}</div>`;
      return;
    }
    if (myNav !== navToken) return;
    // 挖矿进行中：整页重渲染会撕裂面板（监听/引用竞争），只做轻量数字刷新
    if (minerCtl && !minerCtl.stopped && minerCtl.tick === tick) {
      lightTickRefresh(body, t);
      return;
    }
    const supply = BigInt(t.totalMints) * BigInt(t.amountPerMint);      // circulating (minted so far)
    const totalSupply = BigInt(t.maxMints) * BigInt(t.amountPerMint);   // full supply (share is measured against this)
    const holders = hd.holders.slice(0, 20);
    // sold-out ETA over the recent mint window (backend-computed, null = not enough data)
    const etaHtml = !t.soldOut
      ? t.etaSeconds != null
        ? `<div class="sub">⏳ At the recent mint rate (last ${fmtInt(String(t.mintSamples))} mints): sellable in ≈ <b>${fmtEta(t.etaSeconds)}</b></div>`
        : `<div class="sub muted">⏳ Not enough mint data to estimate the sell-out time</div>`
      : `<div class="sub" style="color:#188a42">✓ Sold out — market open: listing/accepting/trading all valid</div>`;
    const gateHint = t.soldOut
      ? ""
      : `<div class="hint-box" style="border-color:#f0c36d;background:#fffaf0">⚠ Market gate: this tick must be <b>100% minted (sold out)</b> before listing/accepting — earlier ones are dead orders (ledger-invalid). Minted ${fmtInt(String(t.totalMints))} / ${fmtInt(String(t.maxMints))}.</div>`;
    body.innerHTML = `
      <h1 class="page-title"><span class="tick-badge" style="font-size:20px">${esc(t.tick)}</span>${statusPill(t)}</h1>

      <div class="card mint-card">
        <div style="margin-bottom:10px">${progressHtml(t.totalMints, t.maxMints, true)}</div>
        <div class="mint-price">⛏ PoW mint · difficulty <b>${fmtInt(String(t.pow.difficultyBits))}</b> bits (≈ <b>${fmtInt(t.pow.expectedTries)}</b> hashes / mint) · <b>${fmtInt(t.amountPerMint)}</b> ${esc(t.tick)} / mint · wallet limit ${fmtInt(String(t.walletLimit))}</div>
        <button class="btn btn-primary btn-big" id="mintBtn" ${t.soldOut ? "disabled" : ""}>${t.soldOut ? "Sold Out" : "⛏ Start mining (continuous)"}</button>
        ${etaHtml}
        ${gateHint}
        <div id="minerBox"></div>
        <div class="hint-box">
          <b>For advanced / CLI miners only</b> — the built-in miner above fills everything automatically; you never type anything. The raw mint calldata (also visible on the block explorer): <code id="mintCalldata">${esc(powMintText(t, "<nonce>"))}</code>
          <button class="btn small" id="copyCalldata" style="margin-top:6px">Copy calldata</button>
          <div class="sub muted">&lt;nonce&gt; is a placeholder shown here only — the miner substitutes the real value automatically before broadcasting.</div>
        </div>
      </div>

      <div class="card">
        <h2>Parameters</h2>
        <div class="kv-grid">
          <div class="kv"><div class="k">Total Mints</div><div class="v mono">${fmtInt(String(t.maxMints))}</div></div>
          <div class="kv"><div class="k">Minted</div><div class="v mono">${fmtInt(String(t.totalMints))}</div></div>
          <div class="kv"><div class="k">Amount / Mint</div><div class="v mono">${fmtInt(t.amountPerMint)}</div></div>
          <div class="kv"><div class="k">Per-Wallet Limit</div><div class="v mono">${fmtInt(String(t.walletLimit))}</div></div>
          <div class="kv"><div class="k">Difficulty (leading zero bits)</div><div class="v mono">${fmtInt(String(t.pow.difficultyBits))} ≈ ${fmtInt(t.pow.expectedTries)} hashes</div></div>
          <div class="kv"><div class="k">Retarget Epoch</div><div class="v mono">${fmtInt(String(t.pow.epochMints))} mints / ${fmtInt(String(t.pow.epochTargetSeconds))}s</div></div>
          <div class="kv"><div class="k">Epoch Progress</div><div class="v mono">${fmtInt(String(t.pow.epochMinted))} / ${fmtInt(String(t.pow.epochMints))}</div></div>
          <div class="kv"><div class="k">Circulating Supply</div><div class="v mono">${fmtInt(supply.toString())}</div></div>
          ${t.soldOutBlock != null ? `<div class="kv"><div class="k">Sold Out At</div><div class="v mono">#${fmtInt(String(t.soldOutBlock))}${t.soldOutAt ? ` · ${new Date(t.soldOutAt * 1000).toLocaleString()}` : ""}</div></div>` : ""}
          <div class="kv"><div class="k">Holders</div><div class="v mono">${fmtInt(String(t.holders))}</div></div>
          <div class="kv"><div class="k">Deploy Block</div><div class="v mono">#${fmtInt(String(t.deployBlock))}</div></div>
          <div class="kv"><div class="k">Deployer</div><div class="v mono">${addrLink(t.deployer)}</div></div>
          <div class="kv"><div class="k">Deploy Tx</div><div class="v mono">${txLink(t.deployTx)}</div></div>
        </div>
      </div>

      <div class="card">
        <h2>Top 20 Holders</h2>
        <div class="tbl-wrap" style="border:none;margin-bottom:0">
          <table class="tbl compact">
            <thead><tr><th>#</th><th>Address</th><th>Balance</th><th>Share</th></tr></thead>
            <tbody>${holders.length ? holders.map((h, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td>${addrLink(h.address)}${account === h.address ? ' <span class="pill pill-live">Me</span>' : ""}</td>
                <td class="mono">${fmtInt(h.balance)}</td>
                <td class="mono muted">${totalSupply > 0n ? fmtFloat(Number(BigInt(h.balance) * 10000n / totalSupply) / 100) + "%" : "-"}</td>
              </tr>`).join("") : '<tr><td colspan="4" class="empty">No holders yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Top Miners</h2><span class="muted small"></span>
        <div class="tbl-wrap" style="border:none;margin-bottom:0">
          <table class="tbl compact">
            <thead><tr><th>#</th><th>Address</th><th>Mined</th></tr></thead>
            <tbody>${miners.length ? miners.map((m, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td>${addrLink(m.address)}${account === m.address ? ' <span class="pill pill-live">Me</span>' : ""}</td>
                <td class="mono">${fmtInt(String(m.count))}</td>
              </tr>`).join("") : '<tr><td colspan="3" class="empty">No miners yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Recent Mints</h2>
        <div class="tbl-wrap" style="border:none;margin-bottom:0">
          <table class="tbl compact"><tbody>${t.recentMints.length ? t.recentMints.map((m) => `
            <tr>
              <td class="mono">Mint #${fmtInt(String(m.n))}</td>
              <td>${addrLink(m.minter)}</td>
              <td>${txLink(m.tx)}</td>
              <td class="mono muted">#${fmtInt(String(m.block))}</td>
            </tr>`).join("") : '<tr><td class="empty">No records yet</td></tr>'}
          </tbody></table>
        </div>
      </div>`;

    // SSE/轮询会整体重渲染本页：把还在运行的挖矿面板搬回新 DOM（移动节点，状态不丢）
    if (minerCtl && minerCtl.tick === tick && minerCtl.el) {
      const nb = $("#minerBox");
      if (nb && !nb.contains(minerCtl.el)) nb.appendChild(minerCtl.el);
      if (nb) {
        // 新重建的卡片没有 mining 态：补上，保证条纹动画/样式不丢
        const mc = nb.closest(".mint-card");
        if (mc) mc.classList.add("mining");
      } else if (!minerCtl.el.isConnected) {
        // 无 minerBox 的布局（如已售罄后才回到本页）：挖矿仍在后台跑，
        // 给一条可见的「后台挖矿中」状态行 + 停止入口，而不是隐形继续
        const note = document.createElement("div");
        note.className = "card";
        note.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>⛏ Mining <b>${esc(minerCtl.tick)}</b> in the background (this tick is sold out; panel collapsed)</span>
          <button class="btn small" id="bgMinerStop">Stop</button></div>`;
        body.prepend(note);
        $("#bgMinerStop").addEventListener("click", () => {
          try {
            if (minerCtl) {
              minerCtl.stopped = true;
              killMiner(minerCtl);
              if (minerCtl.el) minerCtl.el.remove();
            }
          } catch (_) {}
          minerCtl = null;
          note.remove();
        });
      }
    }

    const mintBtn = $("#mintBtn");
    if (mintBtn && !t.soldOut) {
      mintBtn.addEventListener("click", async () => {
        // R10 信任重建：启动前把「连续挖矿 + 每张都要签名付 USDC gas + 可随时停」
        // 讲清楚，避免新手以为只铸一次、事后才发现持续弹签名扣 gas。
        // R31: 引擎选择(GPU WebGPU / CPU)+ 算力百分比。
        const gpuOk = !!navigator.gpu;
        const ans = await confirmDialog({
          title: "Start continuous mining?",
          bodyHtml: `
          <p>Starting <b>CONTINUOUS MINING</b> for <b>${esc(t.tick)}</b> (difficulty <b>${fmtInt(String(t.pow.difficultyBits))}</b> bits):</p>
          <ol>
            <li>The miner keeps searching nonces — <b>every solution auto-sends a mint tx</b> (this is NOT a one-shot mint);</li>
            <li>Each mint ≈ <b>${fmtInt(t.pow.expectedTries)}</b> hashes (compute cost); every tx also pays a <b>USDC gas fee</b> (independent of difficulty);</li>
            <li>Failed attempts never land on-chain but can still burn gas — <b>reject the signature in your wallet</b> to stop paying;</li>
            <li>Press <b>Stop</b> in the panel to halt at any time (≈ ${fmtInt(t.pow.expectedTries)} tries expected per mint);</li>
            <li><b>Anti-spam:</b> after each mint there is a <b>30s cooldown</b> before the next one.</li>
          </ol>
          <div class="field" style="margin-top:10px">
            <label>Mining engine</label>
            <select id="dlgEngine" onchange="dlgPowerSync(this.value, document.getElementById('dlgPct').value)">
              <option value="auto" selected>Auto — GPU if available</option>
              ${gpuOk ? '<option value="gpu">GPU (WebGPU)</option>' : '<option value="gpu" disabled>GPU (WebGPU) — unavailable</option>'}
              <option value="cpu">CPU (JS)</option>
            </select>
          </div>
          <div class="field">
            <label>Engine power</label>
            <div class="power-row">
              <input type="range" id="dlgPct" min="10" max="100" step="10" value="100"
                oninput="dlgPowerSync(document.getElementById('dlgEngine').value, this.value)"
                onchange="dlgPowerSync(document.getElementById('dlgEngine').value, this.value)">
              <span class="power-pct" id="dlgPctLabel">100%</span>
            </div>
            <div class="sub muted" id="dlgPowerHint"></div>
          </div>`,
          confirmLabel: "Start mining",
          cancelLabel: "Cancel",
          collect: () => ({
            engine: (document.getElementById("dlgEngine") || {}).value || "auto",
            pct: Number((document.getElementById("dlgPct") || {}).value || 100),
          }),
        });
        if (ans && ans.ok) startMiner(t, $("#minerBox"), ans.data || {});
      });
    }
    // R10: 一键复制真实 calldata（对照区块浏览器）
    const copyBtn = $("#copyCalldata");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      const ok = await copyText($("#mintCalldata").textContent);
      toast(ok ? "Calldata copied" : "Copy failed", ok ? "ok" : "err", 2000);
    });
  }
  await update();
  if (myNav !== navToken) return; // 页面已切走：不得覆盖新页面的刷新钩子
  currentUpdate = update;
}

// ---------------- 页面：部署 ----------------
async function pageDeploy() {
  const myNav = navToken;
  app.innerHTML = `
    <div class="narrow-page">
    <h1 class="page-title centered">Deploy Tick</h1>
    <div class="card">
      <form id="deployForm" class="form-grid" novalidate>
        <div class="field">
          <label>Tick Name</label>
          <input class="mono" name="tick" placeholder="1-8 lowercase letters or digits" maxlength="8" autocomplete="off" spellcheck="false">
          <div class="sub">Matches <b>^[a-z0-9]{1,8}$</b>, globally unique, first come first served</div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Total Mints (maxMints)</label>
            <input class="mono" name="maxMints" inputmode="numeric" placeholder="e.g. 21000">
            <div class="sub">1 ~ 1,000,000,000</div>
          </div>
          <div class="field">
            <label>Amount per Mint (amountPerMint)</label>
            <input class="mono" name="amountPerMint" inputmode="numeric" placeholder="e.g. 1000">
            <div class="sub">1 ~ 1,000,000,000,000,000</div>
          </div>
        </div>
        <div class="field">
          <label>Per-Wallet Mint Limit</label>
          <input class="mono" name="walletLimit" inputmode="numeric" placeholder="e.g. 10">
          <div class="sub">1 ~ total mints</div>
        </div>
        <div class="field">
          <label>⛏ PoW Difficulty (leading zero bits)</label>
          <input class="mono" name="difficultyBits" inputmode="numeric" placeholder="e.g. 40">
          <div class="sub">1 ~ 120 · expect ≈2^bits hashes per mint · RTX 5090 ≈ 30 GH/s → 40 bits ≈ 35s / mint · browser ≈ 50k H/s (mainnet difficulty is out of reach for a web page)</div>
        </div>
        <div class="field">
          <label>Retarget Epoch (mints / minutes)</label>
          <div class="form-row" style="margin:0">
            <input class="mono" name="epochMints" inputmode="numeric" placeholder="mints, e.g. 500" style="width:48%">
            <input class="mono" name="epochMinutes" inputmode="numeric" placeholder="minutes, e.g. 10" style="width:48%">
          </div>
          <div class="sub">difficulty retargets each epoch toward the target duration (clamped ×4/¼)</div>
        </div>
        <button class="btn btn-primary btn-big" type="submit">⛏ Deploy PoW Tick</button>
      </form>
    </div>
    </div>`;

  // 预取已注册 tick 用于占用校验
  try { ticksCache = (await api("/api/ticks?limit=1000")).ticks; } catch (_) {}
  if (myNav !== navToken) return; // 页面已切走：不得绑定事件/不得清新页面的刷新钩子

  $("#deployForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const tick = f.tick.value.trim();
    const maxMints = f.maxMints.value.trim();
    const amountPerMint = f.amountPerMint.value.trim();
    const walletLimit = f.walletLimit.value.trim();

    if (!/^[a-z0-9]{1,8}$/.test(tick)) return toast("Tick must be 1-8 lowercase letters or digits", "err");
    if (ticksCache.some((t) => t.tick === tick)) return toast(`Tick "${esc(tick)}" is already registered`, "err");
    if (!/^\d+$/.test(maxMints) || BigInt(maxMints) < 1n || BigInt(maxMints) > 1000000000n)
      return toast("Total mints must be an integer between 1 and 1e9", "err");
    if (!/^\d+$/.test(amountPerMint) || BigInt(amountPerMint) < 1n || BigInt(amountPerMint) > 1000000000000000n)
      return toast("Amount per mint must be an integer between 1 and 1e15", "err");
    if (!/^\d+$/.test(walletLimit) || BigInt(walletLimit) < 1n || BigInt(walletLimit) > BigInt(maxMints))
      return toast("Per-wallet limit must be an integer between 1 and total mints", "err");

    const diff = f.difficultyBits.value.trim();
    const epochMints = f.epochMints.value.trim();
    const epochMinutes = f.epochMinutes.value.trim();
    if (!/^\d+$/.test(diff) || BigInt(diff) < 1n || BigInt(diff) > 120n)
      return toast("PoW difficulty must be 1-120 leading zero bits", "err");
    if (!/^\d+$/.test(epochMints) || BigInt(epochMints) < 1n || BigInt(epochMints) > BigInt(maxMints))
      return toast("Epoch mints must be an integer between 1 and total mints", "err");
    if (!/^\d+$/.test(epochMinutes) || BigInt(epochMinutes) < 1n || BigInt(epochMinutes) > 525600n)
      return toast("Epoch minutes must be between 1 and 525600 (365 days)", "err");

    const btn = f.querySelector("button[type=submit]");
    const hash = await sendTx(
      deployTx(tick, BigInt(maxMints), BigInt(amountPerMint), BigInt(walletLimit),
        Number(BigInt(diff)), BigInt(epochMints), BigInt(epochMinutes) * 60n), btn);
    if (hash) toast(`Deploy transaction sent — "${esc(tick)}" will appear on Home once confirmed`, "ok", 10000);
  });

  currentUpdate = null;
}

// ---------------- 页面：市场（订单簿交易界面）----------------
// 单价（ETH / 每 1 个）— 展示用浮点
function unitEth(priceWei, amt) {
  return Number(BigInt(priceWei)) / 1e18 / Number(amt || 1);
}

async function pageMarket(tickParam) {
  const myNav = navToken;
  try { ticksCache = (await api("/api/ticks?limit=1000")).ticks; } catch (_) { ticksCache = []; }
  if (myNav !== navToken) return; // 页面已切走：不得写共享缓存/DOM
  // market tabs: highest trading volume first (tiebreak by trade count);
  // cold-start tiebreak: most recently sold out / deployed first, so a
  // freshly tradable tick does not sink to the bottom of the strip
  ticksCache.sort((a, b) => {
    const av = BigInt(a.volumeWei || "0"), bv = BigInt(b.volumeWei || "0");
    if (av !== bv) return av > bv ? -1 : 1;
    return (b.tradeCount || 0) - (a.tradeCount || 0) ||
      (b.soldOutAt || 0) - (a.soldOutAt || 0) || b.deployBlock - a.deployBlock;
  });
  if (!ticksCache.length) {
    app.innerHTML = `<h1 class="page-title">Market</h1>
      <div class="card empty">No ticks yet — <a href="#/deploy">deploy</a> the first one</div>`;
    currentUpdate = null;
    return;
  }
  const selected = ticksCache.some((t) => t.tick === tickParam) ? tickParam : ticksCache[0].tick;
  let market = null;   // 最近一次 /api/market 数据
  let selAskId = null; // 选入买入面板的卖单
  let sweepPlan = null; // 当前扫单方案
  let myBalances = {};
  let priceRange = "all"; // Price 图时间范围（1m/5m/30m/1h/4h/24h/7d/all）

  // 市场从第一张 mint 起就可交易——无 trade gate
  const tradable = true;

  app.innerHTML = `
    <div class="mkt">
      <div class="pair-search-wrap">
        <input id="pairSearch" class="pair-search" type="text" inputmode="search" autocomplete="off" placeholder="Search ticker…">
      </div>
      <div class="pair-strip" id="pairStrip"></div>
      <div class="mkt-statbar card" id="statBar"></div>
      <div class="mkt-grid">
        <section class="card book-card">
          <div class="card-head"><h2>Order Book</h2><span class="muted small" id="bookMeta"></span></div>
          <div class="book-side-label"><span class="down">Asks</span><span class="muted small">Unit (USDC) / Amount / Total (USDC) / Cumulative</span></div>
          <div class="book" id="book"><div class="empty small">Loading…</div></div>
          <div class="book-spread" id="bookSpread"></div>
          <div class="book-side-label"><span class="up">Bids</span><span class="muted small">Highest first · click Fill to deliver</span></div>
          <div class="book bids" id="bidBook"><div class="empty small">No bids</div></div>
        </section>
        <aside class="mkt-side">
          <div class="card buy-card" id="buyPanel"></div>
          <div class="card bid-card">
            <div class="card-head"><h2>Place Bid</h2><span class="muted small">Escrow USDC to buy</span></div>
            <div class="bid-form-row">
              <input class="mono" id="bidAmt" inputmode="numeric" placeholder="Amount">
              <input class="mono" id="bidPrice" inputmode="decimal" placeholder="Bid USDC (total)">
            </div>
            <div id="bidSummary" class="sweep-summary muted small">Placing a bid escrows your bid + 5% USDC. It fills when a seller binds it on-chain with an accept; cancel anytime before settlement for a full refund. Settlement is executed by the platform operator and pays ONLY the seller bound on-chain — the operator can delay but cannot redirect your escrow.</div>
            <button class="btn btn-primary btn-big" id="bidBtn">Place Bid</button>
          </div>
          <div class="card sweep-card">
            <div class="card-head"><h2>Sweep</h2><span class="muted small">Fill from lowest asks</span></div>
            <div class="sweep-input">
              <input class="mono" id="sweepQty" inputmode="numeric" placeholder="Amount to buy">
              <button class="btn btn-primary" id="sweepBtn" disabled>Sweep</button>
            </div>
            <div id="sweepSummary" class="sweep-summary muted small">Enter an amount to auto-fill from the cheapest asks</div>
          </div>
        </aside>
      </div>
      <div class="card trades-card">
        <div class="card-head"><h2>Recent Trades</h2></div>
        <div class="trades-head"><span>Unit (USDC)</span><span>Amount</span><span>Buyer</span><span>Block</span></div>
        <div class="trades" id="trades"><div class="empty small">Loading…</div></div>
      </div>
      <div class="mkt-forms">
        <section class="card">
          <div class="card-head"><h2>List for Sale</h2></div>
          <form id="listForm" class="form-grid" novalidate>
            <div class="field">
              <label>Amount (${esc(selected)})</label>
              <input class="mono" name="amt" inputmode="numeric" placeholder="Amount to sell">
              <div class="sub" id="listBalHint">&nbsp;</div>
            </div>
            <div class="field">
              <label>Total Price (USDC, fixed)</label>
              <input class="mono" name="price" inputmode="decimal" placeholder="e.g. 0.1">
              <div class="sub" id="listFeeHint">Seller receives = total × 95% (platform takes 5% on each side)</div>
            </div>
            <button class="btn btn-primary btn-big" type="submit">List ${esc(selected)} for Sale</button>
          </form>
        </section>
        <section class="card">
          <div class="card-head"><h2>My Orders</h2></div>
          <div id="myOrders" class="my-orders"><div class="empty small">Connect wallet to view</div></div>
        </section>
      </div>
      <div class="mkt-charts">
        <div class="card chart-card"><div class="card-head"><h2>Price</h2><span class="muted small">/ unit</span></div><div id="priceChart" class="chart"></div></div>
        <div class="card chart-card"><div class="card-head"><h2>Depth</h2><span class="muted small">Bids (green) / Asks (red)</span></div><div id="depthChart" class="chart"></div></div>
      </div>
    </div>`;

  const bookEl = $("#book");
  const bidBookEl = $("#bidBook");
  const tradesEl = $("#trades");

  function renderPairStrip(q = "") {
    const query = q.trim().toLowerCase();
    const list = query ? ticksCache.filter((t) => t.tick.toLowerCase().includes(query)) : ticksCache;
    const strip = $("#pairStrip");
    if (!list.length) {
      strip.innerHTML = `<div class="pair-empty muted small">No ticker matches “${esc(q)}”</div>`;
      return;
    }
    strip.innerHTML = list.map((t) => `
      <a class="pair${t.tick === selected ? " active" : ""}" href="#/market/${esc(t.tick)}">
        <span class="pair-tick">${esc(t.tick)}</span>
        <span class="pair-sub">${t.soldOut ? "Sold Out" : "⛏ " + fmtInt(String(t.pow.difficultyBits)) + " bits"}</span>
      </a>`).join("");
  }

  function renderStatBar() {
    const t = ticksCache.find((x) => x.tick === selected) || {};
    const floor = market && market.floor ? unitEth(market.floor.price, market.floor.amt) : null;
    const last = market && market.last ? unitEth(market.last.price, market.last.amt) : null;
    const topBid = market && market.topBid ? unitEth(market.topBid.price, market.topBid.amt) : null;
    $("#statBar").innerHTML = `
      <div class="stat-lead"><span class="tick-badge lg">${esc(selected)}</span>${statusPill(t)}</div>
      <div class="stat-item"><span class="k">Price / unit</span><span class="v hl">${floor != null ? fmtFloat(floor) : "—"}</span></div>
      <div class="stat-item"><span class="k">Top Bid / unit</span><span class="v up">${topBid != null ? fmtFloat(topBid) : "—"}</span></div>
      <div class="stat-item"><span class="k">Last / unit</span><span class="v">${last != null ? fmtFloat(last) : "—"}</span></div>
      <div class="stat-item"><span class="k">Volume</span><span class="v">${fmtFloat(Number(BigInt(t.volumeWei || "0")) / 1e18)} USDC</span></div>
      <div class="stat-item"><span class="k">Holders</span><span class="v">${fmtInt(String(t.holders || 0))}</span></div>
      <div class="stat-item"><span class="k">Listed / Bids</span><span class="v">${market ? market.listedCount : "—"} / ${market ? market.bidCount : "—"}</span></div>`;
  }

  function renderSpread() {
    const el = $("#bookSpread");
    if (!market || !market.floor || !market.topBid) { el.innerHTML = ""; return; }
    const ask = unitEth(market.floor.price, market.floor.amt);
    const bid = unitEth(market.topBid.price, market.topBid.amt);
    const spread = ask - bid;
    const pct = ask > 0 ? (spread / ask) * 100 : 0;
    el.innerHTML = `<span>Spread</span><span class="mono ${spread < 0 ? "up" : ""}">${fmtFloat(Math.abs(spread))} USDC (${pct.toFixed(1)}%)</span>`;
  }

  function renderBids() {
    const bids = market ? market.bids : [];
    if (!bids.length) { bidBookEl.innerHTML = `<div class="empty small">No bids — place one via "Place Bid" in the bid panel</div>`; return; }
    const total = Number(market.totalBidAmt) || 1;
    const myBal = BigInt(myBalances[selected] || "0");
    bidBookEl.innerHTML = bids.map((b) => {
      const mine = account && b.bidder === account;
      const depth = Math.min(100, (Number(b.cumAmt) / total) * 100);
      const isTop = b.id === bids[0].id;
      let action = "";
      if (mine) action = `<button class="mini-btn danger" data-cancelbid="${b.id}">Cancel</button>`;
      else if (account && myBal >= BigInt(b.amt)) action = `<button class="mini-btn ok" data-accept="${b.id}">Fill</button>`;
      return `
      <div class="book-row bid-row${mine ? " mine" : ""}">
        <div class="depth up" style="width:${depth}%"></div>
        <span class="bid-unit${isTop ? " top" : ""}">${fmtFloat(unitEth(b.price, b.amt))} <span class="muted small">USDC</span></span>
        <span class="mono">${fmtInt(b.amt)}</span>
        <span class="mono">${fmtEth(b.price)}</span>
        <span>${action || `<span class="mono muted">${fmtInt(b.cumAmt)}</span>`}</span>
      </div>`;
    }).join("");
  }

  function renderBook() {
    const asks = market ? market.asks : [];
    $("#bookMeta").textContent = asks.length ? `${asks.length} asks · sorted by unit price` : "";
    if (!asks.length) {
      bookEl.innerHTML = `<div class="empty small">No asks — be the first seller via "List for Sale" below</div>`;
      return;
    }
    const total = Number(market.totalForSale) || 1;
    bookEl.innerHTML = asks.map((a) => {
      const mine = account && a.seller === account;
      const depth = Math.min(100, (Number(a.cumAmt) / total) * 100);
      const isFloor = a.id === asks[0].id;
      return `
      <div class="book-row${a.id === selAskId ? " sel" : ""}${mine ? " mine" : ""}" data-ask="${a.id}" tabindex="0" role="button" aria-pressed="${a.id === selAskId}">
        <div class="depth" style="width:${depth}%"></div>
        <span class="ask-unit${isFloor ? " floor" : ""}">${fmtFloat(unitEth(a.price, a.amt))} <span class="muted small">USDC</span></span>
        <span class="mono">${fmtInt(a.amt)}</span>
        <span class="mono">${fmtEth(a.price)}</span>
        <span class="mono muted">${fmtInt(a.cumAmt)}</span>
      </div>`;
    }).join("");
  }

  function renderBuyPanel() {
    const panel = $("#buyPanel");
    const asks = market ? market.asks : [];
    const ask = asks.find((a) => a.id === selAskId) || asks[0] || null;
    selAskId = ask ? ask.id : null;
    if (!ask) {
      panel.innerHTML = `<div class="card-head"><h2>Buy</h2></div>
        <div class="empty small">No asks available</div>`;
      return;
    }
    const mine = account && ask.seller === account;
    const price = BigInt(ask.price);
    panel.innerHTML = `
      <div class="card-head"><h2>Buy ${esc(selected)}</h2><span class="muted small">Ask #${ask.id}</span></div>
      <div class="buy-rows">
        <div class="l-row"><span class="k">Price / unit</span><span class="v hl">${fmtFloat(unitEth(ask.price, ask.amt))} USDC</span></div>
        <div class="l-row"><span class="k">Amount</span><span class="v mono">${fmtInt(ask.amt)} ${esc(selected)}</span></div>
        <div class="l-row"><span class="k">Total</span><span class="v mono">${fmtEth(price)} USDC</span></div>
        <div class="l-row"><span class="k">Fee 5%</span><span class="v mono">${fmtEth(price * FEE_BPS / 10000n)} USDC</span></div>
        <div class="l-row total"><span class="k">You Pay</span><span class="v hl mono">${fmtEth(buyerPays(price))} USDC</span></div>
        <div class="l-row"><span class="k">Seller</span><span class="v">${mine ? "Me" : addrLink(ask.seller)}</span></div>
      </div>
      ${mine
        ? `<button class="btn btn-danger btn-big" data-cancel="${ask.id}">Cancel</button>`
        : `<button class="btn btn-primary btn-big" data-buy="${ask.id}">Buy · Pay ${fmtEth(buyerPays(price))} USDC</button>`}`;
  }

  // 成交价走势（散点图）
  const PRICE_RANGES = [["1m", 60], ["5m", 300], ["30m", 1800], ["1h", 3600], ["4h", 14400], ["24h", 86400], ["7d", 604800], ["all", Infinity]];
  function renderPriceChart() {
    const el = $("#priceChart");
    const rangeBar = `<div class="price-ranges">${PRICE_RANGES.map(([k]) =>
      `<button type="button" data-r="${k}" class="${k === priceRange ? "active" : ""}">${k === "all" ? "All" : k}</button>`).join("")}</div>`;
    const wireRanges = () => el.querySelectorAll(".price-ranges button").forEach((b) =>
      b.addEventListener("click", () => { priceRange = b.dataset.r; renderPriceChart(); }));

    const all = (market ? market.trades : []).slice().reverse(); // old→new
    const secs = PRICE_RANGES.find((r) => r[0] === priceRange)[1];
    const cutoff = secs === Infinity ? -Infinity : (Date.now() / 1000) - secs;
    const pts = all
      .map((t) => ({ v: unitEth(t.price, t.amt), ts: t.ts || 0, amt: t.amt }))
      .filter((p) => isFinite(p.v) && p.v > 0 && (secs === Infinity || p.ts >= cutoff));
    if (!pts.length) {
      el.innerHTML = rangeBar + `<div class="empty small">No trades in this range</div>`;
      wireRanges();
      return;
    }
    const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v)), span = hi - lo || hi || 1;
    const bottomOf = (v) => 8 + ((v - lo) / span) * 84;          // inset 8%..92% so edge points aren't clipped
    const leftOf = (i) => pts.length > 1 ? 12 + (i / (pts.length - 1)) * 86 : 54;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const val = lo + f * span;
      return `<div class="cg-line" style="bottom:${bottomOf(val).toFixed(2)}%"><span class="cg-label">${fmtFloat(val)}</span></div>`;
    }).join("");
    const dots = pts.map((p, i) => {
      const last = i === pts.length - 1;
      return `<div class="cg-dot${last ? " last" : ""}" style="left:${leftOf(i).toFixed(2)}%;bottom:${bottomOf(p.v).toFixed(2)}%" data-p="${fmtFloat(p.v)}" data-t="${p.ts}" data-a="${esc(p.amt)}"></div>`;
    }).join("");
    el.innerHTML = rangeBar +
      `<div class="chart-plot">${grid}${dots}<div class="chart-tip" hidden></div></div>` +
      `<div class="chart-legend"><span>${pts.length} trades</span><span class="mono" style="color:var(--accent)">Last ${fmtFloat(pts[pts.length - 1].v)}</span><span>${priceRange === "all" ? "all time" : "last " + priceRange}</span></div>`;
    wireRanges();
    // hover tooltip: show price + amount + time for the point under the cursor
    const plot = el.querySelector(".chart-plot"), tip = el.querySelector(".chart-tip");
    plot.addEventListener("pointerover", (e) => {
      const d = e.target.closest(".cg-dot"); if (!d) return;
      const when = d.dataset.t && d.dataset.t !== "0" ? new Date(Number(d.dataset.t) * 1000).toLocaleString() : "—";
      tip.innerHTML = `<b>${esc(d.dataset.p)}</b> USDC/unit<br><span class="muted">${esc(fmtInt(d.dataset.a))} · ${esc(when)}</span>`;
      tip.hidden = false;
      const pr = plot.getBoundingClientRect(), dr = d.getBoundingClientRect();
      tip.style.left = (dr.left - pr.left + dr.width / 2) + "px";
      tip.style.top = (dr.top - pr.top) + "px";
    });
    plot.addEventListener("pointerout", (e) => { if (e.target.closest(".cg-dot")) tip.hidden = true; });
  }

  // 深度图（累计买单/卖单，柱状图）
  function renderDepthChart() {
    const el = $("#depthChart");
    const asks = market ? market.asks : [], bids = market ? market.bids : [];
    if (!asks.length && !bids.length) { el.innerHTML = `<div class="empty small">No open orders</div>`; return; }
    // 按价格升序排列：买单在左（绿，最低价累计最高）、卖单在右（红，累计随价升高）
    const bidBars = bids.slice().reverse().map((b) => ({ u: unitEth(b.price, b.amt), h: Number(b.cumAmt), side: "bid" }));
    const askBars = asks.map((a) => ({ u: unitEth(a.price, a.amt), h: Number(a.cumAmt), side: "ask" }));
    const bars = [...bidBars, ...askBars];
    const cMax = Math.max(1, ...bars.map((b) => b.h));
    const W = 300, H = 110, pad = 6, n = bars.length;
    const bw = (W - 2 * pad) / n;
    const rects = bars.map((b, i) => {
      const h = (b.h / cMax) * (H - 2 * pad);
      const xx = pad + i * bw;
      const color = b.side === "bid" ? "var(--up)" : "var(--down)";
      return `<rect x="${(xx + bw * 0.14).toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.82"/>`;
    }).join("");
    const pMin = Math.min(...bars.map((b) => b.u)), pMax = Math.max(...bars.map((b) => b.u));
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${rects}</svg>
    <div class="chart-legend"><span class="up">▲ Bids ${fmtInt(String(market.totalBidAmt || 0))}</span><span class="mono">${fmtFloat(pMin)}–${fmtFloat(pMax)} USDC</span><span class="down">▼ Asks ${fmtInt(String(market.totalForSale || 0))}</span></div>`;
  }

  function renderTrades() {
    const trades = market ? market.trades : [];
    if (!trades.length) { tradesEl.innerHTML = `<div class="empty small">No trades yet</div>`; return; }
    tradesEl.innerHTML = trades.map((tr) => `
      <div class="trade-row">
        <span class="up mono">▲ ${fmtFloat(unitEth(tr.price, tr.amt))}</span>
        <span class="mono">${fmtInt(tr.amt)}</span>
        <span>${addrLink(tr.buyer)}</span>
        <span class="mono muted">#${fmtInt(String(tr.block))}</span>
      </div>`).join("");
  }

  function renderMyOrders() {
    const box = $("#myOrders");
    if (!account) { box.innerHTML = connectPrompt("Connect wallet to view your orders"); return; }
    const myAsks = (market ? market.asks : []).filter((a) => a.seller === account);
    const myBids = (market ? market.bids : []).filter((b) => b.bidder === account);
    if (!myAsks.length && !myBids.length) {
      box.innerHTML = `<div class="empty small">You have no orders in ${esc(selected)}</div>`;
      return;
    }
    const askRows = myAsks.map((a) => `
      <div class="my-order">
        <div class="mo-main"><span class="tag sell">Ask</span> <b class="mono">${fmtInt(a.amt)}</b> ${esc(selected)} · ${fmtEth(a.price)} USDC
          <span class="muted small">(unit ${fmtFloat(unitEth(a.price, a.amt))})</span></div>
        <button class="btn btn-danger small" data-cancel="${a.id}">Cancel</button>
      </div>`).join("");
    const bidRows = myBids.map((b) => `
      <div class="my-order">
        <div class="mo-main"><span class="tag buy">Bid</span> <b class="mono">${fmtInt(b.amt)}</b> ${esc(selected)} · ${fmtEth(b.price)} USDC
          <span class="muted small">(unit ${fmtFloat(unitEth(b.price, b.amt))})</span></div>
        <button class="btn btn-danger small" data-cancelbid="${b.id}">Cancel</button>
      </div>`).join("");
    box.innerHTML = askRows + bidRows;
  }

  // 扫单：根据输入数量，从最便宜的卖单凑单，刷新摘要与按钮
  function renderSweep() {
    const input = $("#sweepQty");
    const summary = $("#sweepSummary");
    const btn = $("#sweepBtn");
    if (!input) return;
    const qty = input.value.trim();
    sweepPlan = null;
    if (!/^\d+$/.test(qty) || BigInt(qty) <= 0n) {
      summary.className = "sweep-summary muted small";
      summary.textContent = "Enter an amount to auto-fill from the cheapest asks";
      btn.disabled = true;
      return;
    }
    sweepPlan = computeSweep(market ? market.asks : [], qty);
    if (!sweepPlan) {
      summary.className = "sweep-summary muted small";
      summary.textContent = account
        ? "No asks to sweep (they may all be your own listings)"
        : "No asks currently for sale";
      btn.disabled = true;
      return;
    }
    const note = sweepPlan.filled ? "" : ` (not enough for sale, max ${fmtInt(sweepPlan.totalAmt.toString())})`;
    summary.className = "sweep-summary";
    summary.innerHTML =
      `Buy <b>${sweepPlan.count}</b> orders · total <b>${fmtInt(sweepPlan.totalAmt.toString())}</b> ${esc(selected)}${note}<br>` +
      `You pay <b class="hl">${fmtEth(sweepPlan.totalPay)} USDC</b> (incl. 5% fee)`;
    btn.disabled = false;
  }

  // 事件委托：点卖单行选中；买入/撤单按钮
  bookEl.addEventListener("click", (e) => {
    const row = e.target.closest("[data-ask]");
    if (!row) return;
    selAskId = Number(row.dataset.ask);
    renderBook();
    renderBuyPanel();
  });
  // R13 键盘可达：Enter/Space 选中卖单行，与鼠标点击同效
  bookEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("[data-ask]");
    if (!row) return;
    e.preventDefault();
    selAskId = Number(row.dataset.ask);
    renderBook();
    renderBuyPanel();
  });
  app.querySelector(".mkt").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-buy],[data-cancel],[data-accept],[data-cancelbid]");
    if (!btn) return;
    if (btn.dataset.buy || btn.dataset.cancel) {
      const id = Number(btn.dataset.buy || btn.dataset.cancel);
      const ask = (market ? market.asks : []).find((a) => a.id === id);
      if (!ask) return;
      if (btn.dataset.buy) await sendTx(buyTx(id, ask.price), btn);
      else await sendTx(cancelTx(id), btn);
    } else if (btn.dataset.cancelbid) {
      await sendTx(cancelBidTx(Number(btn.dataset.cancelbid)), btn);
    } else if (btn.dataset.accept) {
      const bid = (market ? market.bids : []).find((b) => b.id === Number(btn.dataset.accept));
      if (!bid) return;
      if (!account || BigInt(myBalances[selected] || "0") < BigInt(bid.amt))
        return toast(`Insufficient balance — filling needs ${fmtInt(bid.amt)} ${esc(selected)}`, "err");
      const hash = await sendTx(acceptTx(selected, bid.id), btn);
      if (hash) toast(`Fill bound on-chain (bid #${bid.id}); the operator settles to the bound seller and funds arrive once confirmed`, "ok", 12000);
    }
  });

  // 扫单：输入实时预览 + 一键执行
  $("#sweepQty").addEventListener("input", renderSweep);
  $("#sweepBtn").addEventListener("click", async (e) => {
    if (!sweepPlan) return;
    const hash = await sendTx(sweepTx(sweepPlan.ids, sweepPlan.totalPay.toString()), e.currentTarget);
    if (hash) {
      toast(`Sweep sent: buying ${sweepPlan.count} orders of ${esc(selected)}; already-taken orders are skipped and refunded`, "ok", 12000);
      $("#sweepQty").value = "";
      renderSweep();
    }
  });

  // 挂买单：实时托管预览 + 执行
  function updateBidSummary() {
    const el = $("#bidSummary");
    const wei = parseEth($("#bidPrice").value);
    if (wei && wei > 0n) {
      el.className = "sweep-summary";
      el.innerHTML = `Escrow <b class="hl">${fmtEth(buyerPays(wei))} USDC</b> (bid ${fmtEth(wei)} + 5%) · seller receives ${fmtEth(sellerGets(wei))} USDC on fill`;
    } else {
      el.className = "sweep-summary muted small";
      el.textContent = "Placing a bid escrows your bid + 5% USDC. It fills when a seller binds it on-chain with an accept; cancel anytime before settlement for a full refund. The operator settles to the bound seller only.";
    }
  }
  $("#bidPrice").addEventListener("input", updateBidSummary);
  $("#bidBtn").addEventListener("click", async (e) => {
    let amt = $("#bidAmt").value.trim();
    const priceWei = parseEth($("#bidPrice").value);
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString();
    if (priceWei === null || priceWei < 1n) return toast("Bid must be greater than 0", "err");
    const hash = await sendTx(placeBidTx(selected, amt, priceWei.toString()), e.currentTarget);
    if (hash) {
      toast(`Bid placed, escrowed ${fmtEth(buyerPays(priceWei))} USDC; fills when a seller accepts`, "ok", 10000);
      $("#bidAmt").value = ""; $("#bidPrice").value = ""; updateBidSummary();
    }
  });

  // 挂单表单
  const form = $("#listForm");
  async function updateBalHint() {
    const hint = $("#listBalHint");
    if (!account) { hint.textContent = "Connect wallet to see available balance"; return; }
    hint.innerHTML = `Available: <b>${esc(fmtInt(myBalances[selected] || "0"))}</b> ${esc(selected)}`;
  }
  form.price.addEventListener("input", () => {
    const wei = parseEth(form.price.value);
    const el = $("#listFeeHint");
    if (wei && wei > 0n) {
      el.innerHTML = `Seller receives <b>${fmtEth(sellerGets(wei))} USDC</b> · buyer pays ${fmtEth(buyerPays(wei))} USDC`;
    } else {
      el.textContent = "Seller receives = total × 95% (platform takes 5% on each side)";
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let amt = form.amt.value.trim();
    const priceWei = parseEth(form.price.value);
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString();
    if (priceWei === null || priceWei < 1n) return toast("Total price must be greater than 0", "err");
    if (account && BigInt(myBalances[selected] || "0") < BigInt(amt))
      return toast(`Insufficient balance: you hold ${esc(fmtInt(myBalances[selected] || "0"))} ${esc(selected)}`, "err");
    const btn = form.querySelector("button[type=submit]");
    const hash = await sendTx(listTx(selected, amt, priceWei.toString()), btn);
    if (hash) { toast("Listing sent — it becomes Listed once the platform confirms escrow", "ok", 10000); form.reset(); }
  });

  async function update() {
    let mk, bal;
    try {
      const reqs = [api("/api/market/" + encodeURIComponent(selected))];
      if (account) reqs.push(api("/api/balances/" + account));
      [mk, bal] = await Promise.all(reqs);
    } catch (e) {
      if (myNav === navToken) {
        bookEl.innerHTML = `<div class="empty small">Failed to load: ${esc(e.message)} <button class="btn small" id="bookRetry">Retry</button></div>`;
        $("#bookRetry")?.addEventListener("click", () => update());
      }
      return;
    }
    if (myNav !== navToken) return; // 页面已切走，丢弃这次结果
    market = mk;
    if (bal) myBalances = bal.balances;
    // R14 分区降级：单区渲染失败只影响该区，其余面板与自愈轮询照常。
    // 约定：safe() 仅限同步渲染函数——传含 api() 的 async 函数时 rejection 会
    // 变成 unhandled rejection 且分区不显示错误。
    const safe = (fn) => { try { fn(); } catch (err) { console.error("section render failed:", err.message); } };
    safe(renderStatBar);
    safe(renderPriceChart);
    safe(renderDepthChart);
    safe(renderBook);
    safe(renderSpread);
    safe(renderBids);
    safe(renderBuyPanel);
    safe(renderTrades);
    safe(renderMyOrders);
    safe(renderSweep);
    safe(updateBalHint);
  }

  renderPairStrip();
  const searchEl = $("#pairSearch");
  if (searchEl) {
    searchEl.addEventListener("input", () => renderPairStrip(searchEl.value));
    searchEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = searchEl.value.trim().toLowerCase();
      if (!q) return;
      const match = ticksCache.find((t) => t.tick.toLowerCase() === q) ||
        ticksCache.find((t) => t.tick.toLowerCase().includes(q));
      if (match) location.hash = "#/market/" + match.tick;
    });
  }
  await update();
  if (myNav !== navToken) return; // 页面已切走：不得覆盖新页面的刷新钩子
  currentUpdate = update;
}

// ---------------- 页面：我的 ----------------
async function pageMe() {
  if (!account) {
    app.innerHTML = `<h1 class="page-title">My</h1>` + connectPrompt("Connect wallet to view balances and orders");
    currentUpdate = null;
    return;
  }

  app.innerHTML = `
    <h1 class="page-title">My</h1>

    <div class="card">
      <div class="card-head"><h2>Balances</h2><span class="muted small">Mined = PoW mints from this wallet</span></div>
      <div class="tbl-wrap" style="border:none;margin-bottom:0">
        <table class="tbl compact">
          <thead><tr><th>Tick</th><th>Balance</th><th>Mined</th><th></th></tr></thead>
          <tbody id="balRows"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="mkt-forms">
      <section class="card">
        <div class="card-head"><h2>Transfer</h2></div>
        <form id="xferForm" class="form-grid" novalidate>
          <div class="field">
            <label>Tick</label>
            <div id="xferTickMount"></div>
            <div class="sub" id="xferBalHint">&nbsp;</div>
          </div>
          <div class="field">
            <label>Amount</label>
            <input class="mono" name="amt" inputmode="numeric" placeholder="Integer amount">
          </div>
          <div class="field">
            <label>Recipient Address</label>
            <input class="mono" name="to" placeholder="0x…" autocomplete="off" spellcheck="false">
            <div class="sub">Sends a 0 USDC inscription transaction to the recipient to complete the transfer</div>
          </div>
          <button class="btn btn-primary btn-big" type="submit">Send Transfer</button>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>My Orders</h2>
          <button class="btn small" id="cancelAllBtn" style="display:none">Cancel all</button>
        </div>
        <div id="meGrid" class="grid"><div class="card empty">Loading…</div></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>My Trades</h2><span class="muted small">Full history — replayed from the indexer event log</span></div>
        <div id="myTrades"><div class="card empty">Loading…</div></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Bulk List</h2><span class="muted small">One order per line: tick amount price(USDC) — tick must be 100% minted</span></div>
        <textarea id="bulkList" class="mono" rows="4" placeholder="arc 1000 25&#10;arc 2000 30" spellcheck="false"></textarea>
        <div id="bulkProg" class="muted small" style="margin:8px 0">Sent serially, one tx per order (each ≈ 60–90k gas; the wallet estimates the exact fee). ⚠ A tick only accepts orders once it is <b>100% mined</b> — earlier ones become dead orders.</div>
        <button class="btn" id="bulkBtn">List All (serial)</button>
      </section>
    </div>`;

  const grid = $("#meGrid");
  bindListingActions(grid);
  let myBalances = {};
  const myNav = navToken;

  // themed tick dropdown (rebuilt from balances in update())
  let xferTick = "";
  const xferSelect = customSelect([{ value: "", label: "Select tick" }], "", (v) => {
    xferTick = v;
    $("#xferBalHint").innerHTML = v ? `Available: <b>${fmtInt(myBalances[v] || "0")}</b> ${esc(v)}` : "&nbsp;";
  });
  $("#xferTickMount").appendChild(xferSelect);

  async function update() {
    try {
      const [b, ls] = await Promise.all([api("/api/balances/" + account), api("/api/listings")]);
      if (myNav !== navToken) return;
      myBalances = b.balances;
      const entries = Object.entries(myBalances);
      $("#balRows").innerHTML = entries.length ? entries.map(([tick, bal]) => `
        <tr>
          <td><a href="#/tick/${esc(tick)}"><span class="tick-badge">${esc(tick)}</span></a></td>
          <td class="mono">${fmtInt(bal)}</td>
          <td class="mono muted">⛏ ${fmtInt(String((b.mints || {})[tick] || 0))}</td>
          <td><a href="#/market" class="small">List →</a></td>
        </tr>`).join("")
        : '<tr><td colspan="4" class="empty">No balances yet — go to <a href="#/">Home</a> and mint one</td></tr>';

      // rebuild themed tick dropdown, keeping current selection
      xferSelect.setOptions(
        [{ value: "", label: "Select tick" }, ...entries.map(([tick]) => ({ value: tick, label: tick }))],
        xferTick
      );

      const mine = ls.listings.filter((l) => l.seller === account);
      for (const l of mine) listingById.set(String(l.id), l);
      grid.innerHTML = mine.length ? mine.map(listingCard).join("") : '<div class="card empty">No orders</div>';

      // R9 一键撤全：cancelMany(我的全部可撤挂单)。合约 skip-any——外部/已关闭
      // 的订单自动跳过并计入成功数，单笔竞态不会让整批失败。
      const cAll = $("#cancelAllBtn");
      if (cAll) {
        const openIds = mine.filter((l) => l.chainStatus === "pending" || l.chainStatus === "active").map((l) => l.id);
        if (openIds.length) {
          cAll.style.display = "";
          cAll.textContent = `Cancel all (${openIds.length})`;
          cAll.onclick = async () => {
            const hash = await sendTx(cancelManyTx(openIds));
            if (hash) {
              toast(`Cancel-all sent for ${openIds.length} listing(s) — raced orders are skipped, never revert the batch`, "ok", 10000);
              schedulePolls();
            }
          };
        } else {
          cAll.style.display = "none";
        }
      }

      // R7: full trade history for this address — /api/trades replays the
      // indexer's event log (not the 500-entry in-memory ring)
      try {
        const tr = await api("/api/trades?addr=" + account + "&limit=20");
        if (myNav !== navToken) return;
        $("#myTrades").innerHTML = tr.trades.length ? `<div class="tbl-wrap" style="border:none;margin-bottom:0"><table class="tbl compact">
          <thead><tr><th>Tick</th><th>Side</th><th>Amount</th><th>Total (USDC)</th><th>Tx</th></tr></thead><tbody>
          ${tr.trades.map((x) => `
            <tr>
              <td><a href="#/market/${esc(x.tick)}"><span class="tick-badge">${esc(x.tick)}</span></a></td>
              <td>${x.buyer === account ? "Buy" : "Sell"} · ${x.kind === "bid" ? "bid fill" : "ask order"}</td>
              <td class="mono">${fmtInt(x.amt)}</td>
              <td class="mono">${fmtEth(x.price)}</td>
              <td>${txLink(x.tx)}</td>
            </tr>`).join("")}</tbody></table></div>${tr.total > tr.trades.length ? `<div class="muted small" style="margin-top:6px">${fmtInt(String(tr.total))} trades in total — showing the latest ${tr.trades.length}.</div>` : ""}`
          : '<div class="card empty">No trades yet</div>';
      } catch (_) { /* trade history is decoration — never break the page */ }
    } catch (e) {
      toast("Refresh failed: " + esc(e.message), "err");
    }
  }

  const form = $("#xferForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tick = xferTick;
    let amt = form.amt.value.trim();
    const to = form.to.value.trim();
    if (!tick) return toast("Please select a tick", "err");
    if (!/^\d+$/.test(amt) || BigInt(amt) < 1n) return toast("Amount must be an integer greater than 0", "err");
    amt = BigInt(amt).toString(); // 去前导零
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return toast("Recipient address is invalid", "err");
    const toLower = to.toLowerCase();
    if (toLower === HUB || toLower === MARKET) return toast("Cannot transfer to system contracts (the transaction would revert)", "err");
    if (toLower === account) toast("Note: transferring to yourself is valid but has no net balance change", "", 5000);
    if (BigInt(myBalances[tick] || "0") < BigInt(amt))
      return toast(`Insufficient balance: you hold ${esc(fmtInt(myBalances[tick] || "0"))} ${esc(tick)}`, "err");
    const btn = form.querySelector("button[type=submit]");
    const hash = await sendTx(transferTx(to, tick, amt), btn);
    if (hash) toast("Transfer inscription sent — recorded once the transaction succeeds with sufficient balance", "ok", 10000);
  });


  // R9 批量挂单：前端串行组包（每笔等待回执、展示进度），batchList 合约增强留后续
  $("#bulkBtn").addEventListener("click", async () => {
    const rows = $("#bulkList").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!rows.length) return toast("Nothing to list — add one 'tick amount price' per line", "err");
    const prog = $("#bulkProg");
    let ok = 0;
    for (let i = 0; i < rows.length; i++) {
      const parts = rows[i].split(/\s+/);
      const [tick, amt, price] = parts;
      const wei = parts.length >= 3 ? parseEth(price) : null;
      if (!tick || !amt || !/^\d+$/.test(amt) || wei === null || wei <= 0n) {
        prog.textContent = `Skipped line ${i + 1}: "${rows[i]}" (expected: tick amount priceUSDC)`;
        continue;
      }
      prog.textContent = `Listing ${i + 1}/${rows.length}: ${amt} ${tick} @ ${price} USDC — confirm in wallet…`;
      const h = await sendTx(listTx(tick, amt, wei), null);
      if (h) ok++;
    }
    prog.textContent = `Done: ${ok}/${rows.length} listing tx(s) broadcast (each ≈ 60–90k gas). Confirmation takes a few blocks.`;
    if (ok) schedulePolls();
  });
  await update();
  if (myNav !== navToken) return; // 页面已切走：不得覆盖新页面的刷新钩子
  currentUpdate = update;
}

// ---------------- 路由 ----------------
let memesState = { coins: [], sort: "new", search: "", page: 0, ethUsd: null, pageSize: 8 };

async function pageMemes() {
  const myNav = navToken;
  const live = !!LAUNCHPAD;

  if (!live) {
    app.innerHTML = `
      <div class="narrow-page memes-page">
        <div class="memes-coming">
          <span class="memes-coming-badge">✦ Coming soon</span>
          <h1 class="memes-coming-title">Memes</h1>
        </div>
      </div>`;
    currentUpdate = null;
    return;
  }

  app.innerHTML = `
    <div class="narrow-page memes-page">
      <div class="memes-hero">
        <a class="btn btn-primary btn-big" href="#/memes/new">Create Meme Coin</a>
      </div>

      <input class="memes-search" id="memesSearch" type="search" placeholder="Search name, ticker, or contract address…" autocomplete="off" spellcheck="false">

      <div class="memes-listbar">
        <h2 class="memes-h2">Recent launches</h2>
        <div class="memes-sort" id="memesSort">
          <button data-sort="new">New</button>
          <button data-sort="mcap">Market cap</button>
          <button data-sort="vol">Volume</button>
          <button data-sort="holders">Holders</button>
        </div>
      </div>
      <div id="memesList" class="memes-grid"><div class="empty muted">Loading…</div></div>
      <div id="memesPager" class="memes-pager"></div>
    </div>`;

  // fit roughly one screen of cards (each ~96px tall)
  memesState.pageSize = Math.max(5, Math.floor((window.innerHeight - 340) / 96));
  memesState.page = 0;
  memesState.search = "";

  $("#memesSort").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    memesState.sort = b.dataset.sort;
    memesState.page = 0;
    renderMemesList();
  });

  const searchEl = $("#memesSearch");
  if (searchEl) searchEl.addEventListener("input", () => {
    memesState.search = searchEl.value;
    memesState.page = 0;
    renderMemesList();
  });

  try {
    const data = await api("/api/memes?limit=1000");
    if (myNav !== navToken) return; // 页面已切走：不得写共享状态/DOM
    memesState.coins = (data && data.coins) || [];
    memesState.ethUsd = (data && data.ethUsd) || null;
    renderMemesList();
  } catch (_) {
    if (myNav !== navToken) return;
    $("#memesList").innerHTML = '<div class="empty muted">No launches yet.</div>';
  }
  if (myNav !== navToken) return;
  currentUpdate = null;
}

function memesSorted() {
  const q = (memesState.search || "").trim().toLowerCase();
  let coins = memesState.coins;
  if (q) {
    coins = coins.filter((c) =>
      (c.name || "").toLowerCase().includes(q) ||
      (c.symbol || "").toLowerCase().includes(q) ||
      (c.token || "").toLowerCase().includes(q)
    );
  }
  const bi = (x) => { try { return BigInt(x || "0"); } catch { return 0n; } };
  const cmp = {
    new: (a, b) => b.block - a.block,
    mcap: (a, b) => (bi(b.mcapWei) > bi(a.mcapWei) ? 1 : bi(b.mcapWei) < bi(a.mcapWei) ? -1 : 0),
    vol: (a, b) => (bi(b.volumeWei) > bi(a.volumeWei) ? 1 : bi(b.volumeWei) < bi(a.volumeWei) ? -1 : 0),
    holders: (a, b) => (b.holders || 0) - (a.holders || 0),
  }[memesState.sort] || ((a, b) => b.block - a.block);
  return coins.slice().sort(cmp);
}

function renderMemesList() {
  for (const b of document.querySelectorAll("#memesSort button")) b.classList.toggle("active", b.dataset.sort === memesState.sort);
  const listEl = $("#memesList");
  const pagerEl = $("#memesPager");
  if (!listEl) return;
  const all = memesSorted();
  if (!all.length) {
    const msg = memesState.search.trim() ? "No coins match your search." : "No launches yet — be the first.";
    listEl.innerHTML = `<div class="empty muted">${msg}</div>`;
    if (pagerEl) pagerEl.innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(all.length / memesState.pageSize));
  memesState.page = Math.min(memesState.page, pages - 1);
  const start = memesState.page * memesState.pageSize;
  listEl.innerHTML = all.slice(start, start + memesState.pageSize).map((c) => memeCardHtml(c)).join("");
  wireMemeCards(listEl);
  if (pagerEl) {
    pagerEl.innerHTML = pages > 1
      ? `<button id="pgPrev" ${memesState.page === 0 ? "disabled" : ""}>‹ Prev</button>` +
        `<span class="memes-pageinfo">Page ${memesState.page + 1} / ${pages}</span>` +
        `<button id="pgNext" ${memesState.page >= pages - 1 ? "disabled" : ""}>Next ›</button>`
      : "";
    const prev = $("#pgPrev"), next = $("#pgNext");
    if (prev) prev.onclick = () => { if (memesState.page > 0) { memesState.page--; renderMemesList(); } };
    if (next) next.onclick = () => { if (memesState.page < pages - 1) { memesState.page++; renderMemesList(); } };
  }
}

// Format a wei value as compact USD (if an ETH price is known) or ETH.
function fmtValue(wei, ethUsd) {
  if (wei == null) return "—";
  let eth;
  try { eth = Number(BigInt(wei)) / 1e18; } catch { return "—"; }
  return ethUsd ? "$" + fmtCompactNum(eth * ethUsd) : fmtCompactNum(eth) + " ETH";
}
function fmtCompactNum(n) {
  if (!isFinite(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n >= 1) return n.toFixed(2);
  if (n === 0) return "0";
  if (n >= 0.0001) return n.toFixed(4);
  return n.toPrecision(2);
}

function memeAvatar(c) {
  const a = (c.token || "0x0").toLowerCase();
  const hue = parseInt(a.slice(2, 8) || "0", 16) % 360;
  const hue2 = (hue + 45) % 360;
  const ch = ((c.symbol || c.name || "?").trim()[0] || "?").toUpperCase();
  const placeholder =
    `<div class="meme-avatar" style="background:linear-gradient(135deg,hsl(${hue},62%,50%),hsl(${hue2},64%,38%))">${esc(ch)}</div>`;
  if (c.imageUrl) {
    // real IPFS avatar; if it fails to load, swap in the generated placeholder
    return `<img class="meme-avatar" src="${esc(c.imageUrl)}" alt="" loading="lazy"` +
      ` data-hue="${hue}" data-hue2="${hue2}" data-ch="${esc(ch)}" onerror="memeAvatarFallback(this)">`;
  }
  return placeholder;
}
function memeAvatarFallback(img) {
  const div = document.createElement("div");
  div.className = "meme-avatar";
  div.style.background = `linear-gradient(135deg,hsl(${img.dataset.hue},62%,50%),hsl(${img.dataset.hue2},64%,38%))`;
  div.textContent = img.dataset.ch || "?";
  img.replaceWith(div);
}
function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}
function memeSocials(coin) {
  if (!coin) return "";
  const links = [["Twitter", coin.twitter], ["Website", coin.website], ["Telegram", coin.telegram]]
    .map(([label, u]) => [label, safeUrl(u)])
    .filter(([, u]) => u);
  if (!links.length) return "";
  return `<div class="meme-socials">` +
    links.map(([label, u]) => `<a class="meme-social" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>`).join("") +
    `</div>`;
}

function memeCardHtml(c) {
  const eu = memesState.ethUsd;
  return `
    <div class="meme-card" data-token="${esc(c.token)}">
      ${memeAvatar(c)}
      <div class="meme-card-main">
        <div class="meme-card-title">${esc(c.name || "—")} <span class="meme-ticker">${esc(c.symbol || "")}</span></div>
        <button class="meme-ca" type="button" data-ca="${esc(c.token)}" title="Copy contract address">${short(c.token)} <span class="meme-ca-ic">⧉</span></button>
      </div>
      <div class="meme-metrics">
        <div class="meme-metric"><span class="mm-k">MC</span><span class="mm-v">${fmtValue(c.mcapWei, eu)}</span></div>
        <div class="meme-metric"><span class="mm-k">Vol</span><span class="mm-v">${fmtValue(c.volumeWei, eu)}</span></div>
        <div class="meme-metric"><span class="mm-k">Holders</span><span class="mm-v">${c.holders != null ? fmtInt(String(c.holders)) : "—"}</span></div>
      </div>
    </div>`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  // Fallback for contexts where the async Clipboard API is blocked.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function wireMemeCards(root) {
  for (const card of root.querySelectorAll(".meme-card")) {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".meme-ca")) return; // the copy button handles its own click
      location.hash = "#/memes/" + card.dataset.token;
    });
  }
  for (const btn of root.querySelectorAll(".meme-ca")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(btn.dataset.ca);
      toast(ok ? "Contract address copied" : "Copy failed", ok ? "ok" : "err", 2000);
    });
  }
}

async function pageMemesNew() {
  if (!LAUNCHPAD) {
    app.innerHTML = `<div class="narrow-page"><div class="card empty muted">Launchpad not deployed yet.</div></div>`;
    return;
  }
  app.innerHTML = `
    <div class="narrow-page">
    <a class="back-link" href="#/memes">← Memes</a>
    <h1 class="page-title centered">Create Meme Coin</h1>
    <div class="card">
      <form id="memeForm" class="form-grid" novalidate>
        <div class="meme-form-top">
          <label class="meme-drop">
            <img id="imgPreview" class="meme-drop-img" alt="" style="display:none">
            <span id="imgPick" class="meme-drop-hint"><span class="meme-drop-plus">+</span>Add image</span>
            <input type="file" name="cimg" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          </label>
          <div class="meme-form-top-right">
            <div class="field">
              <label>Name</label>
              <input name="cname" maxlength="32" placeholder="Doge Rob" autocomplete="off" spellcheck="false">
            </div>
            <div class="field">
              <label>Ticker</label>
              <input class="mono" name="csymbol" maxlength="11" placeholder="DROB" autocomplete="off" spellcheck="false">
            </div>
          </div>
        </div>
        <div class="field">
          <label>Twitter <span class="muted">(optional)</span></label>
          <input name="ctwitter" placeholder="https://x.com/…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Telegram <span class="muted">(optional)</span></label>
          <input name="ctelegram" placeholder="https://t.me/…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Website <span class="muted">(optional)</span></label>
          <input name="cwebsite" placeholder="https://…" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>Initial buy (ETH)</label>
          <input class="mono" name="cdev" inputmode="decimal" placeholder="0.05" value="0.05">
          <div class="sub">Seeds the locked liquidity and buys you the opening tokens. Must be &gt; 0.</div>
        </div>
        <button class="btn btn-primary btn-big" type="submit">Launch Coin</button>
      </form>
    </div>
    </div>`;

  // avatar preview + client-side validation (fills the square dropzone)
  const fileInput = $('#memeForm [name="cimg"]');
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    const prev = $("#imgPreview");
    const hint = $("#imgPick");
    if (!file) { prev.style.display = "none"; hint.style.display = "flex"; return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast("Use a PNG / JPG / WEBP / GIF image", "err"); fileInput.value = ""; return; }
    if (file.size > 5 * 1024 * 1024) { toast("Image must be ≤ 5MB", "err"); fileInput.value = ""; return; }
    prev.src = URL.createObjectURL(file);
    prev.style.display = "block";
    hint.style.display = "none";
  });

  $("#memeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!account) return toast("Connect your wallet first", "err");
    const f = e.target;
    const name = f.elements.cname.value.trim();
    const symbol = f.elements.csymbol.value.trim();
    const devWei = parseEth(f.elements.cdev.value);
    const file = f.elements.cimg.files[0];
    const twitter = f.elements.ctwitter.value.trim();
    const website = f.elements.cwebsite.value.trim();
    const telegram = f.elements.ctelegram.value.trim();
    if (name.length < 1 || name.length > 32) return toast("Name must be 1–32 characters", "err");
    if (symbol.length < 1 || symbol.length > 11) return toast("Symbol must be 1–11 characters", "err");
    if (!file) return toast("Add an avatar image", "err");
    if (devWei === null || devWei <= 0n) return toast("First buy must be greater than 0", "err");

    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const label = btn.textContent;
    let metadataURI;
    try {
      btn.textContent = "Uploading image…";
      const img = await pinAvatar(file);
      btn.textContent = "Saving metadata…";
      const meta = { name, symbol, image: img.ipfs };
      if (twitter) meta.twitter = twitter;
      if (website) meta.website = website;
      if (telegram) meta.telegram = telegram;
      const md = await pinJson(meta);
      metadataURI = md.ipfs;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      return toast("Upload failed: " + esc(err.message), "err", 6000);
    }
    btn.textContent = label;
    btn.disabled = false;

    const hash = await sendTx(launchTx(name, symbol, metadataURI, devWei), btn);
    if (hash) {
      toast("Launch sent — your coin appears on Memes once confirmed", "ok", 10000);
      setTimeout(() => { location.hash = "#/memes"; }, 3000);
    }
  });
  currentUpdate = null;
}

async function pageMemesCoin(token) {
  const myNav = navToken;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) { location.hash = "#/memes"; return; }
  token = token.toLowerCase();
  let coin = null, eu = null;
  try {
    const d = await api("/api/memes?limit=1000");
    eu = (d && d.ethUsd) || null;
    coin = (d.coins || []).find((c) => c.token.toLowerCase() === token);
  } catch (_) {}
  if (myNav !== navToken) return; // 页面已切走：不得渲染/不得清新页面的刷新钩子

  const sym = esc(coin?.symbol || "");
  const stat = (k, v) => `<div class="coin-stat"><div class="cs-k">${k}</div><div class="cs-v">${v}</div></div>`;
  const info = (k, v, wide) => `<div class="coin-info${wide ? " wide" : ""}"><div class="ci-k">${k}</div><div class="ci-v">${v}</div></div>`;

  app.innerHTML = `
    <div class="narrow-page coin-page">
      <a class="back-link" href="#/memes">← Memes</a>

      <div class="coin-hero">
        ${coin ? memeAvatar(coin) : ""}
        <div class="coin-hero-info">
          <div class="coin-hero-title">${esc(coin?.name || "Coin")} <span class="ticker">${sym}</span></div>
          <button class="meme-ca coin-ca" type="button" data-ca="${esc(token)}" title="Copy contract address">${short(token)} <span class="meme-ca-ic">⧉</span></button>
          ${memeSocials(coin)}
        </div>
      </div>

      <div class="coin-stats">
        ${stat("Market cap", fmtValue(coin?.mcapWei, eu))}
        ${stat("Volume", fmtValue(coin?.volumeWei || "0", eu))}
        ${stat("Holders", coin && coin.holders != null ? fmtInt(String(coin.holders)) : "—")}
        ${stat("Trades", coin ? fmtInt(String(coin.trades || 0)) : "—")}
      </div>

      <div class="card coin-info-card">
        <div class="coin-info-grid">
          ${info("Trading pair", (sym || "TOKEN") + " / WETH")}
          ${info("Supply", "1,000,000,000")}
          ${info("Trade tax", "1%")}
          ${info("Pool fee", "0%")}
          ${coin ? info("Creator", addrLink(coin.creator)) : ""}
          ${coin?.ts ? info("Launched", memeTimeAgo(coin.ts)) : ""}
          ${info("Contract", addrLink(token))}
          ${info("Explorer", `<a class="addr-link" href="${EXPLORER}/token/${esc(token)}" target="_blank" rel="noopener">View ↗</a>`)}
        </div>
      </div>

      <div class="card" id="feeCard"><div class="empty muted">Loading fees…</div></div>
    </div>`;

  const ca = $(".coin-ca");
  if (ca) ca.addEventListener("click", async () => {
    const ok = await copyText(ca.dataset.ca);
    toast(ok ? "Contract address copied" : "Copy failed", ok ? "ok" : "err", 2000);
  });

  await renderMemeFees(token);
  if (myNav !== navToken) return; // 页面已切走：不得覆盖新页面的刷新钩子
  currentUpdate = null;
}

function memeTimeAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function renderMemeFees(token) {
  const el = $("#feeCard");
  if (!el) return;
  try {
    const [creatorHex, treasuryHex, pcHex, ptHex] = await Promise.all([
      readCall(token, SEL_CREATOR), readCall(token, SEL_TREASURY),
      readCall(token, SEL_PENDING_CREATOR), readCall(token, SEL_PENDING_TREASURY),
    ]);
    // Empty result = no contract on the wallet's current network (e.g. wallet on the
    // wrong chain, or viewing a testnet coin while the fallback RPC is mainnet).
    if (!creatorHex || creatorHex.length < 66) {
      el.innerHTML = `<h2 class="memes-h2">Fees (WETH)</h2>` +
        `<p class="sub muted">Connect the creator or treasury wallet to withdraw fees.</p>`;
      return;
    }
    const creator = ("0x" + creatorHex.slice(26)).toLowerCase();
    const treasury = ("0x" + treasuryHex.slice(26)).toLowerCase();
    const pc = readBig(pcHex), pt = readBig(ptHex);
    const me = account ? account.toLowerCase() : null;

    let html = `
      <h2 class="memes-h2">Fees (WETH)</h2>
      <div class="kv"><div class="k">Creator claimable</div><div class="v mono">${fmtEth(pc)} <span class="muted">→ ${addrLink(creator)}</span></div></div>
      <div class="kv"><div class="k">Treasury claimable</div><div class="v mono">${fmtEth(pt)} <span class="muted">→ ${addrLink(treasury)}</span></div></div>`;
    const acts = [];
    if (me && me === creator && pc > 0n) acts.push(`<button class="btn btn-primary" id="wcBtn">Withdraw my creator fees</button>`);
    if (me && me === treasury && pt > 0n) acts.push(`<button class="btn btn-primary" id="wtBtn">Withdraw treasury fees</button>`);
    html += acts.length
      ? `<div class="meme-actions">${acts.join("")}</div>`
      : `<div class="sub muted">${me ? "Connected wallet has nothing to withdraw here." : "Connect the creator or treasury wallet to withdraw."}</div>`;
    el.innerHTML = html;

    const wc = $("#wcBtn");
    if (wc) wc.addEventListener("click", async () => {
      const h = await sendTx(withdrawCreatorTx(token, account), wc);
      if (h) { toast("Withdraw sent", "ok"); setTimeout(() => renderMemeFees(token), 4000); }
    });
    const wt = $("#wtBtn");
    if (wt) wt.addEventListener("click", async () => {
      const h = await sendTx(withdrawTreasuryTx(token, account), wt);
      if (h) { toast("Withdraw sent", "ok"); setTimeout(() => renderMemeFees(token), 4000); }
    });
  } catch (e) {
    el.innerHTML = `<div class="empty muted">Couldn't load fees: ${esc(e.message)}</div>`;
  }
}

function setNav(route) {
  for (const a of document.querySelectorAll("#nav a")) {
    a.classList.toggle("active", a.dataset.route === route);
  }
}

async function router() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  currentUpdate = null;
  navToken++; // 使所有在途的旧页面 update() 失效，避免串页渲染
  listingById = new Map();
  app.classList.add("page-enter"); // 入场动画只在本页首帧生效，之后 SSE 重渲染不再触发
  setTimeout(() => app.classList.remove("page-enter"), 1300);
  try {
    if (parts.length === 0) { setNav("home"); await pageHome(); }
    else if (parts[0] === "tick" && parts[1]) { setNav("home"); await pageTick(decodeURIComponent(parts[1])); }
    else if (parts[0] === "deploy") { setNav("deploy"); await pageDeploy(); }
    else if (parts[0] === "market") { setNav("market"); await pageMarket(parts[1] ? decodeURIComponent(parts[1]) : null); }
    else if (parts[0] === "me") { setNav("me"); await pageMe(); }
    else if (parts[0] === "memes" && parts[1] === "new") { setNav("memes"); await pageMemesNew(); }
    else if (parts[0] === "memes" && parts[1]) { setNav("memes"); await pageMemesCoin(decodeURIComponent(parts[1])); }
    else if (parts[0] === "memes") { setNav("memes"); await pageMemes(); }
    else { location.hash = "#/"; }
  } catch (e) {
    app.innerHTML = `<div class="card error-card">Failed to load page: ${esc(e.message)}<br><span class="small muted">Make sure the indexer is running locally</span></div>`;
  }
}

// ---------------- 启动 ----------------
(async function init() {
  $("#walletBtn").addEventListener("click", async (e) => {
    if (account) { e.stopPropagation(); walletMenuEl ? closeWalletMenu() : openWalletMenu(); return; }
    try { await connectWallet(); router(); } catch (e) { txError(e); }
  });

  window.addEventListener("hashchange", router);

  // Stop 按钮走文档级委托：面板被 SSE 重建搬运/重建时监听永不丢失
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#minerStop") && minerCtl && minerCtl.stop) {
      e.preventDefault();
      minerCtl.stop();
    }
  });

  // 被动检测已连接账户：优先上次用过的钱包（记住 rdns），否则回退注入钱包。
  // 给 6963 广播一个 tick 收集完再判断。
  await new Promise((r) => setTimeout(r, 60));
  let eager = null;
  const opts = walletOptions();
  try {
    const remembered = localStorage.getItem(LS_WALLET);
    if (remembered) eager = opts.find((o) => o.info.rdns === remembered) || null;
  } catch (_) {}
  if (!eager && opts.length === 1) eager = opts[0]; // 只有一个钱包，直接用它做被动检测
  if (eager) {
    wallet = eager.provider;
    bindWalletEvents(wallet);
    try {
      const accs = await wallet.request({ method: "eth_accounts" });
      if (accs && accs[0]) account = accs[0].toLowerCase();
    } catch (_) {}
  }
  updateWalletUI();

  await refreshStatus();
  await router();

  // 实时刷新（节流）：状态栏 + 当前页面数据
  let refreshing = false, lastRefresh = 0;
  async function liveRefresh() {
    const now = Date.now();
    if (refreshing || now - lastRefresh < 1200) return; // 节流，避免连续出块时抖动
    refreshing = true; lastRefresh = now;
    try {
      await refreshStatus();
      if (currentUpdate) await currentUpdate();
    } catch (_) {} finally { refreshing = false; }
  }

  // SSE：索引器每扫完一批推送新区块，前端实时刷新；断线自动重连
  function connectStream() {
    try {
      const es = new EventSource("/api/stream");
      es.onmessage = () => liveRefresh();
      es.onerror = () => { es.close(); setTimeout(connectStream, 3000); };
    } catch (_) { /* 无 EventSource 时退回轮询 */ }
  }
  connectStream();

  // 兜底轮询（SSE 不可用/漏推时）
  setInterval(liveRefresh, 15000);
})();
