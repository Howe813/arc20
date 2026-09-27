# arc-20 协议规范 v3 — Arc 链 PoW 铭文平台

arc-20 是 Arc（Circle L1，链 ID 5042，原生 gas 为 USDC，18 位小数）上的 calldata
铭文协议。铭文本体是交易 input data 中的 UTF-8 文本；除守门/市场两个基础设施合约外
链上不存在代币，所有余额由按本规范实现的索引器从链上数据确定性推导。
本文件是记账规则的唯一权威。

系统合约：
- **InscriptionHub**：tick 注册、mint 守门与 **PoW 验证**。无 owner、无许可、参数部署后不可改。
- **InscriptionMarket**：挂单托管与成交。买卖双边各收成交价 5% 平台费（合约常量）。

## 通用规则

1. 只有**执行成功**（receipt status = 1）的交易/事件才会被索引；回退的交易一律忽略。
2. 铭文文本必须与规范形式**逐字节一致**：ASCII、无空格、无换行、键顺序固定。
3. 同一区块内按 transactionIndex（交易内按日志顺序）结算。
4. tick 必须匹配 `^[a-z0-9]{1,8}$`（小写字母与数字，1–8 字节），全局唯一，先注册先得。
5. 数量/价格/nonce 均为十进制整数字符串，无前导零（nonce 的 `0` 合法）、无小数点。
   余额无小数位。所有 ETH 计价单位（wei）在 Arc 上即 USDC 的 18 位小数单位。

## op: deploy — 注册新 tick（PoW 公平发射）

调用 `InscriptionHub.deployTick(tick, maxMints, amountPerMint, walletLimit,
difficultyBits, epochMints, epochTargetSeconds)`
（selector `0x9f9ee0ee`）。约束（合约强制）：tick 规范且未被注册；
`1 ≤ maxMints ≤ 1e9`；`1 ≤ amountPerMint ≤ 1e15`；`1 ≤ walletLimit ≤ maxMints`；
`1 ≤ difficultyBits ≤ 120`；`1 ≤ epochMints ≤ maxMints`；
`1 ≤ epochTargetSeconds ≤ 365 天`。挖矿取代支付——tick 没有价格，铸造完全免费。

**索引规则**：`Deployed(tickHash, deployer, tick, maxMints, amountPerMint,
walletLimit, difficultyBits, epochMints, epochTargetSeconds)` 事件 → 注册 tick 及其
参数与 PoW 状态（difficultyBits, epochMints, epochTargetSeconds, epochMinted=0,
epochStart=区块时间戳）。

## op: mint — PoW 挖矿

用户（EOA 直接发起，`msg.sender == tx.origin`）向 **InscriptionHub** 发送 **0 ETH**
交易，calldata 为规范铭文（必须携带 nonce）：

```
data:,{"p":"arc-20","op":"mint","tick":"<tick>","amt":"<amountPerMint>","nonce":"<N>"}
```

`<N>` 匹配 `(0|[1-9][0-9]{0,39})`。合约解析 nonce 为 uint256 后验证（`mintsOf`
为该矿工对本 tick **已完成**的铸造张数，即本张铸成前的值）：

```
keccak256(abi.encodePacked(msg.sender, tickHash, uint256(N), uint64(mintsOf))) 的前导零位数 ≥ difficultyBits
```

- 预映像固定 92 字节：矿工地址（20B）++ tickHash（32B）++ nonce（uint256 大端 32B）
  ++ 铸造计数（uint64 大端 8B，`mintsOf[tickHash][msg.sender]` 的当前值）。
  **矿工地址与铸造计数都参与哈希**——解不能转借他人；铸造成功后计数 +1，
  同一 (地址, tick, nonce) 立即失效，故**每个解一次性使用**，不可复用。
- 「前导零位数 ≥ d」等价于 `uint256(hash) >> (256 - d) == 0`；因解随铸造计数
  一次性使用，每张 mint 都需要 ≈ 2^d 次**全新**尝试（公平发射成立——不存在
  挖出一个解就免费铸满全 tick 的捷径）。
- 不满足难度、缺 nonce、nonce 非规范、携带 ETH——一律整笔回退
  （`BadPow` / `BadInscription` / `WrongPayment`），无效 mint 只耗 gas。
- amt 的十进制位数以 **16 位为上限先检**（17+ 位数字直接 `BadInscription`，
  而非累加溢出 Panic）——固定宽度实现方在解析 amt 时务必先查位数再累加，
  避免复现同类溢出。
- 每张同样受 `walletLimit`、`maxMints`（SoldOut）约束。SoldOut 只是**铸币守门**：
  铸满后 mint 回退，仅此而已——它不产生任何交易资格；市场自第一张 mint 起即可
  交易（见 op: list、op: accept 与市场状态机），合约与索引器均不设售罄闸。

**索引规则**：`Inscribed(tickHash, minter, n)` →
`balances[tick][minter] += amountPerMint`；索引器独立复核 `n ≤ maxMints`，超发即停机。
索引器还**独立复算哈希**（扫描时取交易 calldata + 事件，按同一 92 字节预映像公式
——含该 minter **铸前**计数——重算并比对当前
difficultyBits；注意 epoch 填满那笔 mint 按重定向**前**的难度校验——与合约执行顺序
一致），不一致即视为共识故障停机；哈希实现见 `indexer/public/keccak.mjs`
（合约、索引器、前端矿工、e2e 四方共用同一预映像定义）。

### 难度重定向（difficulty retarget）

每完成 `epochMints` 张 mint 触发一次（在第 `epochMints` 张的 mint 交易内执行），
比特币式——慢了降难、快了升难，使下一个 epoch 回归目标时长：

```
elapsed = block.timestamp - epochStart
nd      = difficultyBits × epochTargetSeconds ÷ elapsed    // 慢 → 降难，快 → 升难
        （elapsed == 0 视为极快：直接 nd = difficultyBits × 4）
nd      = clamp(nd, difficultyBits/4, difficultyBits×4)    // 单次最多 ×4 加难 / ¼ 降难
nd      = clamp(nd, 1, 120)
```

随后 `epochStart = block.timestamp`、`epochMinted = 0`。若 `nd ≠ difficultyBits`
则更新并发出 `DifficultyRetargeted(tickHash, nd)`。全部由链上时间戳推导——
索引器按事件直接采用（无需重算），重放确定性成立。索引规则：
`DifficultyRetargeted` → `ticks[tick].pow.difficultyBits = nd`。

## op: transfer — 点对点转账

持有人向**接收方地址**发送交易（金额任意，通常 0），calldata：

```
data:,{"p":"arc-20","op":"transfer","tick":"<tick>","amt":"<N>"}
```

`<N>` 匹配 `^[1-9][0-9]{0,29}$`。**索引规则**（交易成功才结算）：
tick 已注册且 `balances[tick][from] ≥ N` → 划转 N 给 `to`；否则无效忽略。
`to` 为空（创建合约）忽略；转给自己有效但无净变动。发往 Hub/Market 的 transfer
文本会被合约回退，故余额不可能落在系统合约上。

## op: list — 市场挂单（托管）

卖家向 **InscriptionMarket** 发送 0 ETH 交易，calldata：

```
data:,{"p":"arc-20","op":"list","tick":"<tick>","amt":"<N>","price":"<wei>"}
```

`<N>` 同 transfer；`<price>` 匹配 `^[1-9][0-9]{0,29}$`（单位 wei = USDC 最小单位，
整单一口价）。市场合约解析并记录 Listing（id 自增，状态 Pending），发出 `Listed` 事件。

**索引规则**：`Listed(id, seller, tickHash, tick, amt, price)` →
若 `balances[tick][seller] ≥ N`：扣除 N 进入 `escrow[id]`，托管**有效**；
否则托管**无效**（永不确认，链上 Listing 沦为死单）。
市场自第一张 mint 起即可交易——托管有效性只看余额，无售罄闸（见下）。

## 市场状态机（合约 + 索引器）

### 共识规则：市场自第一张 mint 起可交易（无售罄闸）

**tick 无需铸完即可进入市场**——挂单托管（list）与买单交割（accept）的有效性
只取决于卖家账本余额（`balances[tick][seller] ≥ amt`），不存在售罄前置条件。
链上 InscriptionMarket 合约对 `totalMints`/`maxMints` 零引用；索引器同样**不设
售罄闸**（2026-09 移除，两侧一致）。余额不足的 list/accept 交易在链上照常成功，
是否有效**纯由索引器离线裁决**；第三方索引器若账本余额判定不同，将从
`Listed`/accept 起与官方账本分叉。余额不足被拒的 accept 在事件流中带结构化
原因 `reason: "insufficient-balance"`。

- `confirm(id)`（`0xba0179b5`，仅 operator）：Pending → Active。平台 oracle 只对
  托管有效的挂单调用 confirm——买家只能购买 Active 挂单，这是买家资金安全的
  信任锚（与经典铭文市场一致的平台托管模型，需明示用户）。
- `buy(id)`（`0xd96a094a`，payable）：状态必须 Active；
  `msg.value == price + floor(price*5%)`（买家承担 5%）；
  卖家即时收到 `price - floor(price*5%)`（卖家承担 5%；打款失败转入待领）；
  双边费用累积在合约内，owner 可提。发出 `Bought(id, buyer)`。
  **索引规则**：托管有效 → `escrow[id]` 划给买家。
- `cancel(id)`（`0x40e58ee5`，仅卖家，Pending/Active 可撤）：发出 `Cancelled(id)`。
  **索引规则**：托管有效 → `escrow[id]` 退回卖家。
- `cancelMany(uint256[] ids)`（`0x2b15e32b`）：批量撤单，**skip-any 语义**——非本人
  挂单、或已非 Pending/Active（成交/已撤）的条目逐单跳过（不回退），返回实际取消
  数；每个被取消的挂单逐单发出 `Cancelled(id)`。**索引规则**：与 `cancel` 相同
  （托管有效 → `escrow[id]` 退回卖家，逐单独立结算）。
- `sweep(uint256[] ids)`（`0x98b02275`，payable）：一笔买入多个 Active 挂单，跳过
  已成交/撤单/超预算的，多付部分退回买家（买家拒收则记入 `pendingProceeds`，经
  `claimProceeds` 领取）；全无可买则回退。每个成交等价于一次
  `buy`，索引规则相同（每个 `Bought` 事件独立结算）。

## 买单（双边盘：与挂单对称的流程）

买单由**买家链上托管 ETH(USDC)**、**卖家发 accept 铭文给 Market 链上绑定交割**、
**operator 结算**三步组成，与挂单对称（挂单是卖家托管铭文、买家 buy 结算）。

- `placeBid(tick, amt, price)`（`0xc7df5882`，payable）：买家挂买单，
  `msg.value == price + floor(price*5%)`（买家 5% 一并托管在合约里）。
  发出 `BidPlaced(id, bidder, tickHash, tick, amt, price)`。**索引规则**：记录买单
  （状态 Open）。买家 USDC 在链上安全托管，随时可 `cancelBid` 全额退回。
- **op: accept** — 卖家向 **InscriptionMarket** 发送 0 ETH 交易绑定某买单交割：
  ```
  data:,{"p":"arc-20","op":"accept","tick":"<tick>","bid":"<id>"}
  ```
  市场合约 fallback 逐字节解析该铭文（与 list 同一入口）：要求买单 **Open**、
  铭文 `tick` 与买单 `tickHash` 一致、且 `pendingSeller` 未被绑定——满足则
  **链上绑定** `bids[id].pendingSeller = msg.sender` 并发出
  `BidAccepted(id, seller, tickHash)`。绑定**先到先得、不可覆盖**（后来者回退
  `BidTaken`）。这是一条发往 Market 的 calldata 铭文——索引器以 `BidAccepted`
  事件为准记账（getLogs 只含成功交易，无需 receipt 复核）。**索引规则**：
  事件中的买单存在且 Open（链上保证，防御性校验）→ 检查
  `balances[tick][seller] ≥ amt`（无售罄闸，与 list 同规则，
  见「共识规则：市场自第一张 mint 起可交易」）：通过 → 扣除卖家 amt 进入
  `bidEscrow[id]`（托管有效），记录待结算卖家 = seller（即链上绑定者）；
  不通过 → 记 `accept { valid: false, reason: "insufficient-balance" }`，
  托管不生效、买单无有效 accept。**注意**：绑定者在
  索引器侧判定无效后，链上绑定已锁定、其他卖家无法再绑定——该买单无法结算，
  买家可 `cancelBid` 撤单退款，卖家无损失（铭文托管仅索引器侧，未扣减）。
  除上述两种 reason 外不存在其它无效 accept 路径：链上回退的 accept
  （非 Open/已绑定/tick 不匹配/格式错误）不产生任何事件。
- `settleBid(id, seller)`（`0xe55df556`，仅 operator）：Open → Filled；合约校验
  `seller == bids[id].pendingSeller`（**链上绑定强制**，否则回退
  `NotPendingSeller`）——operator **只能拖延结算、不能改道资金**；付绑定卖家
  `price - 5%`，两侧 5% 入平台费。发出 `BidFilled(id, seller)`。平台 oracle 只对
  "有有效 accept 托管"的买单、以索引器记录的绑定卖家（即链上 `pendingSeller`，
  两者同源于 `BidAccepted` 事件）结算。**索引规则**：`bidEscrow[id]`
  划给买家（bidder）；买单完成。
- `cancelBid(id)`（`0x9703ef35`，仅买家，Open 可撤）：退回买家托管 USDC（买家为
  合约且拒收时，改记 `pendingProceeds` 经 `claimProceeds` 领取——与卖家侧对称，
  撤单本身不被卡死），发出 `BidCancelled(id)`。**索引规则**：若已有 accept 托管
  → 退回给该卖家。

买家资金安全由**链上托管 + 链上 accept 绑定**共同保证：operator 密钥即使泄露，
也无法把未结算买单的托管资金付给绑定者以外的地址（只能拖延结算）；买家可随时
`cancelBid` 撤单退款止损。卖家交割后由 `BidFilled` 事件原子完成"付款 + 账本划转"，
若 oracle 不结算则卖家 accept 托管可随买单撤销退回，卖家不受损。

## 索引器实现要求

- 从部署区块起逐块扫描，落后链头 `confirmations`（默认 10）个区块。
- 合约操作以**成功交易的事件日志**为准；transfer 以 calldata 扫描 +
  receipt 复核为准（accept 已改为 `BidAccepted` 事件驱动，见买单章节）；
  PoW mint 额外做**独立哈希复验**（见上），失败即停机。
- 状态必须可从零重放：删除本地状态重扫必须得到逐字节相同的结果。
- 索引器即记账权威，须持续运行并备份 `state.json` 与 `events.jsonl`。
- 派生数据（非共识，供发现与展示）：每 tick 首次售罄（`totalMints` 达
  `maxMints`）时记录 `soldOutAt`（区块时间戳）与 `soldOutBlock`，并产出
  soldout 活动事件；按最近 mint 时间窗计算铸造速率与售罄 ETA；24h mint
  热度与活跃矿工数按最近 100 条 mint 记录统计（窗口有界，为下限估计）。
