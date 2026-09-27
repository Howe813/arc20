# arc-20 — Arc 链 PoW 铭文平台

**线上站点：https://arc20.tech**

Arc（Circle 的 L1，链 ID 5042，原生 gas 为 USDC）上的 **PoW 公平发射**铭文交易平台。
任何人都可以部署 tick（自定名字、张数、每张数量、每钱包上限、难度），mint 完全免费，
但每张必须提交一个满足难度要求的 nonce——`keccak256(矿工地址, tickHash, nonce, 已铸张数)`
的
前导零位数 ≥ 难度（已铸张数参与哈希，每个解一次性使用）。难度按 epoch 自动重定向（慢了降难、快了升难，单次最多 ×4/¼），
哈希算力即获取权：没有预售、没有团队份额、没有 mint 费。

任何人都可以 mint/挖矿，内置托管式交易市场。铭文即交易 input data 里的
`data:,{"p":"arc-20","op":...}` 原文，链上不发行代币，余额由索引器按
[PROTOCOL.md](PROTOCOL.md) 记账，且索引器会**独立复算每个 PoW mint 的哈希**。

## 架构

| 组件 | 职责 |
|---|---|
| [InscriptionHub.sol](src/InscriptionHub.sol) | tick 注册 + mint 守门。**链上直接解析铭文文本并验证 PoW**，规则不符整笔回退；合约无 owner、无许可、不可升级、零手续费——挖矿取代支付。 |
| [InscriptionMarket.sol](src/InscriptionMarket.sol) | 托管市场：挂单=发 `op:"list"` 铭文给市场合约；买单=买家链上托管，卖家发 `op:"accept"` 铭文给市场合约**链上绑定交割**，结算只能付给绑定的卖家（operator 可拖延、不可挪用）；**买卖双边各收成交价 5%**（合约常量，不可改），归平台 owner。 |
| [indexer/indexer.mjs](indexer/indexer.mjs) | 记账权威：扫块结算 mint/transfer/市场/PoW 事件，多 tick 账本，HTTP API + 前端站。零依赖 Node。 |
| [indexer/oracle.mjs](indexer/oracle.mjs) | 市场 oracle：自动 confirm 托管有效的挂单（调 `cast` 发交易）。 |
| [indexer/public/](indexer/public/) | 前端站：tick 列表 / 部署 / **内置 WebGPU + CPU 双引擎挖矿器**（算力百分比、30s 反刷屏冷却）/ 双边市场 / 我的资产。EIP-6963 多钱包。 |
| [indexer/public/keccak.mjs](indexer/public/keccak.mjs) | 纯 JS keccak-256 + PoW 校验——索引器独立复算、前端挖矿器、e2e 三方共用。 |
| [e2e/e2e.mjs](e2e/e2e.mjs) | anvil 全链路联测（合约 + 挖矿 + 索引器 + 市场生命周期 + 重放确定性）。 |

## API 速查（indexer :3000）

| 端点 | 说明 |
|---|---|
| `GET /api/status` | 组件地址、索引水位 `lastBlock`、24h 挖矿热度 `mints24h`/`activeMiners24h`（窗口=最近 100 条 mint 记录） |
| `GET /api/ticks?offset=&limit=` | tick 摘要（新→旧），默认 `limit=50`，钳 1–1000；含 `soldOutAt/soldOutBlock/mintRate/etaSeconds`（售罄时间与 ETA） |
| `GET /api/ticks/<tick>` | 单 tick 详情；可选 `?miner=0x..` 附带该地址的 `minerMints`（PoW 预映像第 4 段） |
| `GET /api/tick/<tick>/holders` | Top 100 持有人 |
| `GET /api/miners?tick=&offset=&limit=` | 矿工排行 `{address,count}`（按张数降序）。带 `tick=` 为单 tick 榜，不带为全网聚合；默认 50、钳 500 |
| `GET /api/listings?tick=&status=` | 挂单列表（最新 200） |
| `GET /api/bids?bidder=` | 买单列表（最新 200，可按 bidder 过滤） |
| `GET /api/trades?tick=&addr=&offset=&limit=` | **全量成交回放**（逐行流式扫描 events.jsonl）。默认 `limit=20`，钳 1–100；响应带 `total/scannedBytes`。⚠ 仅含 R7 起 `op:"trade"` 事件——升级前运行产生的历史成交不在事件流中，属预期而非丢数据 |
| `GET /api/activity?type=&offset=&limit=` | 统一活动流。⚠ `total` 为内存窗口计数（`windowed:true`，≤300 条），更早记录走 `/api/trades` |
| `GET /api/stream` | SSE：每个扫描批次推送最新块号 |
| `GET /api/balances/<addr>` | 地址余额 + 各 tick 挖矿张数 `mints` |
| `POST /api/memes/pin`、`/api/memes/pin-json` | 图片/元数据 pin 到 IPFS（同源或 `x-pin-token`，见 `PIN_TOKEN`） |

## 快速开始 / 环境变量

克隆（含子模块 forge-std / openzeppelin）：

```bash
git clone --recurse-submodules <repo-url> && cd arc20
```

**含 key 的 RPC 端点不入库**，运行时用环境变量提供（仓库里的 `foundry.toml`、
`indexer/config*.json` 均为公共端点/占位符）：

| 变量 | 用途 |
|---|---|
| `RPC_URL` | indexer / oracle 连链用的 RPC（覆盖 config 里的 rpcUrl） |
| `ARC_RPC` | foundry 的 `arc` 端点（主网部署 / 脚本） |
| `PIN_TOKEN` | 可选。pin 端点默认仅同源可用；设置后，携带 `x-pin-token` 头的跨源服务器间调用也被放行（同源 UI 不受影响，不会因配置而锁死） |

本地起索引器 + 前端：

> ⚠ **共识版本提示**：合约/索引器/前端矿工已升级到最新共识（v2 PoW 预映像含
> 已铸张数、v4 买单 accept 链上绑定）。**旧版已部署合约的链**（如 2026-09 前的
> 演示栈）与新版索引器/前端矿工不兼容：请重新部署最新合约并更新
> `hubAddress`/`marketAddress` 后再使用，否则浏览器矿工的解会被合约拒绝
> （BadPow）、买单结算会被合约回退。

```bash
RPC_URL=<你的Arc RPC> CONFIG_PATH=indexer/config.json node indexer/indexer.mjs
# 打开 http://localhost:3000
```

## 测试

```bash
forge test        # 88 个合约测试（含 PoW 难度/重定向/nonce 一次性/解析器模糊测试）+ 不变量测试
node e2e/e2e.mjs  # 全链路端到端（含 JS 挖矿 + 索引器独立 PoW 校验 + HTTP 面安全断言）
```

> ⚠ **勿手动起固定端口的 anvil 做实验**（如 `anvil --port 8600`）:e2e 虽已改为
> 随机空闲端口并在退出时自清理，但残留进程会与门禁/并行运行互扰。实验后请
> 确认进程已退出（`tasklist | findstr anvil`）。

## 上线步骤（Arc 主网，链 ID 5042）

```bash
# 1. 导入平台钱包（交互式，私钥不留历史）；建议 oracle 用单独的低权限钱包
#    Arc 的 gas 是 USDC——钱包里备一点 USDC 即可
cast wallet import platform --interactive
cast wallet import oracle --interactive

# 2. 部署 Hub + Market（OWNER/OPERATOR 不设则默认部署钱包）
OWNER=<平台收款地址> OPERATOR=<oracle地址> \
  forge script script/Deploy.s.sol --rpc-url arc --account platform --broadcast

# 3. Arc explorer 开源验证（explorer.arc.io）
forge verify-contract <Hub地址> src/InscriptionHub.sol:InscriptionHub \
  --verifier blockscout --verifier-url https://explorer.arc.io/api
forge verify-contract <Market地址> src/InscriptionMarket.sol:InscriptionMarket \
  --verifier blockscout --verifier-url https://explorer.arc.io/api \
  --constructor-args $(cast abi-encode "constructor(address,address)" <owner> <operator>)

# 4. 填 indexer/config.json（hubAddress / marketAddress / deployBlock），启动索引器 + oracle
#    ⚠️ deployBlock 必须 ≤ Hub 合约的部署区块号（部署交易所在区块，explorer 可查）。
#    设晚了会漏掉早期 Deployed/PowDeployed/Inscribed 事件——索引器遇到未知 tick 的 mint
#    会主动停机报错，但正确配置可以完全避免。
node indexer/indexer.mjs                       # 站点 http://localhost:3000
ORACLE_ACCOUNT=oracle node indexer/oracle.mjs

# 5. 发创世 PoW tick（全部挖矿获取，40 bits ≈ RTX 5090 30-45s/张）：
#    「arc」：21000 张 × 1000，每钱包 10 张，整个供应为一个 epoch
cast send <Hub地址> "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" \
  arc 21000 1000 10 40 21000 600 --rpc-url arc --account platform
#    「mine」：21000 张 × 1000，每钱包 10 张，每 10 分钟 500 张重定向
cast send <Hub地址> "deployTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" \
  mine 21000 1000 10 40 500 600 --rpc-url arc --account platform
```

一键脚本（含 dry-run 保护和自动写配置）：`script/deploy-mainnet.sh`（主网）、
`script/testnet-dryrun.sh`（测试网链 ID 5042002，水龙头 https://faucet.circle.com ）。

## 用户操作速查

```bash
# PoW 挖矿 mint（免费；nonce 需满足 keccak256(你的地址,tickHash,nonce,已铸张数)
# 前导零 ≥ 难度。前端 tick 详情页「⛏ Start mining」一键挖矿，WebGPU 引擎
# 571-800 MH/s（主网 40 bits ≈ 每张十几秒到几十秒）；命令行可先用 cast keccak 自找 nonce
cast send <Hub> --rpc-url arc --account me \
  $(cast from-utf8 'data:,{"p":"arc-20","op":"mint","tick":"mine","amt":"1000","nonce":"<挖到的nonce>"}')

# 转账（发给接收人）
cast send <接收地址> --rpc-url arc --account me \
  $(cast from-utf8 'data:,{"p":"arc-20","op":"transfer","tick":"arc","amt":"500"}')

# 挂单（发给 Market，0 ETH；price 单位 wei，整单一口价）
cast send <Market> --rpc-url arc --account me \
  $(cast from-utf8 'data:,{"p":"arc-20","op":"list","tick":"arc","amt":"500","price":"50000000000000000"}')

# 购买单个挂单（实付 = price + floor(price×5%)）
cast send <Market> "buy(uint256)" <挂单id> --value <实付>wei --rpc-url arc --account me

# 一键扫单：一笔买入多个挂单（最多 50 个），自动跳过被抢走/撤单的，多付退回
cast send <Market> "sweep(uint256[])" "[<id1>,<id2>]" --value <总实付>wei --rpc-url arc --account me

# 平台提取市场手续费（Hub 无手续费——挖矿取代支付）
cast send <Market> "withdrawFees(address)" <收款地址> --rpc-url arc --account platform
```

## PoW 挖矿规则（详见 PROTOCOL.md）

- 预映像固定 92 字节：`矿工地址(20B) ++ tickHash(32B) ++ nonce(uint256 大端 32B) ++
  已铸张数(uint256 大端 32B)`。矿工地址参与哈希——nonce 无法被他人盗用；
  已铸张数参与哈希——每个解一次性使用，无法重放。
- `difficultyBits` 为要求的前导零位数，期望尝试次数 ≈ 2^bits。内置网页矿工
  提供 **WebGPU 引擎**（WGSL 实现的 keccak-f[1600]，实测 571-800 MH/s，
  主网 40 bits ≈ 每张十几秒到几十秒）与 **CPU 多线程引擎**，可选算力百分比；
  换显卡/浏览器后可打开 `gpu-test.html` 自测。批量挖矿可用
  [ops/batch-mint.mjs](ops/batch-mint.mjs)（母钱包派生子钱包、分发 gas、并发挖矿）。
- 同一钱包每次成功 mint 后有 30 秒前端冷却（反刷屏；链上不强制，仅 UI 层限制）。
- 每 `epochMints` 张 mint 触发一次重定向（比特币式，自动回归目标节奏）：
  `新难度 = 难度 × 目标耗时 ÷ 实际耗时`（epoch 跑慢了降难、跑快了升难；
  实际耗时为 0 视为极快直接 ×4）。单次钳制在 [难度/4, 难度×4]，绝对边界
  [1, 120]。重定向完全由链上时间戳推导，索引器重放可复现（并有
  `DifficultyRetargeted` 事件）。
- 索引器会独立复算每个成功 PoW mint 的哈希；与链上不一致即停机（共识故障）。

## 信任模型（须向用户明示）

- Hub 完全无许可：PoW mint 规则全部链上强制，无效 mint 不花钱（只耗 gas）。
- PoW mint 的有效性 100% 链上可验证，无需信任任何节点。
- 余额账本由平台索引器权威判定（经典铭文模式）；账本可开源重放验证——任何人
  跑 `indexer.mjs` 都会得到相同结果（含 PoW 独立复验）。
- 市场依赖平台 oracle 确认托管：买家只能买到托管已验证的挂单，但需信任平台
  不确认无效挂单（`confirm` 有链上事件，可事后审计）。
- 索引器必须持续运行并备份 `indexer/state.json` 与 `events.jsonl`。
- **只用普通钱包（EOA），不要用智能合约钱包（Safe/ERC-4337）**：mint 仅限 EOA 直接
  调用；更重要的是，铭文余额按"接收地址"记账，若把铭文**转账/挂单到一个合约地址**，
  该合约几乎不可能再发出合规的 transfer 铭文，余额将**永久冻结**。前端会拦截明显的
  合约接收地址，但请务必在社区文档中强调这一点。
- 索引器只监听 Hub/Market 两个合约地址的**事件日志**（`eth_getLogs`），因此无论 tick
  是直接部署还是经 Safe/工厂内部调用部署，都能被正确索引，不会漏记或崩溃。
- 前端钱包加链用公共 RPC（Arc 官方 `rpc.mainnet.arc.io`）；后端如需付费端点写在
  服务器本地的 gitignored `config.production.json` / systemd `EnvironmentFile`，
  **勿泄露到前端**。

## 与 Robinhood Chain 版本（原 rob-20）的差异

- 协议标识 `"p":"rob-20"` → `"p":"arc-20"`（新链全新创世，历史账本不受影响）。
- 链：Robinhood Chain（4663）→ Arc（5042）；gas/计价单位 ETH → USDC（均为 18 位小数）。
- Memes launchpad（Uniswap v4，`launchpad/`）仍在 Robinhood Chain 上运行，未随本仓库
  迁移；如需在 Arc 重启，需要 Arc 侧的 v4 PoolManager/WETH 地址（配置
  `launchpadAddress` 等并在前端导航恢复 Memes 入口）。
