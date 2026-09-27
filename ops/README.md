# arc-20 生产部署与运维手册

7×24 运行三个东西:**索引器**(记账权威)、**oracle**(确认挂单 + 结算买单)、**前端**(索引器直接托管静态站)。下面是从 Arc 主网部署到长期运维的完整流程。

## 0. 机器准备

- 一台 Linux VPS(2 vCPU / 2␣GB 起),装 Node ≥ 18、nginx、certbot。
- 建用户与目录:
  ```bash
  sudo useradd -r -m -d /opt/arc20 arc20
  sudo mkdir -p /opt/arc20/backups /etc/arc20
  # 把仓库部署到 /opt/arc20（含 indexer/、ops/、src/ 等）
  ```

## 1. 部署合约(Arc 主网,链 5042,gas 为 USDC)

```bash
cast wallet import platform --interactive     # 平台钱包（建议多签，见下）
cast wallet import oracle   --interactive     # oracle 专用低额热钱包

OWNER=<平台收款地址/多签> OPERATOR=<oracle地址> \
  forge script script/Deploy.s.sol --rpc-url arc --account platform --broadcast

# Arc explorer 开源验证（两个合约）
forge verify-contract <Hub> src/InscriptionHub.sol:InscriptionHub \
  --verifier blockscout --verifier-url https://explorer.arc.io/api/
forge verify-contract <Market> src/InscriptionMarket.sol:InscriptionMarket \
  --verifier blockscout --verifier-url https://explorer.arc.io/api/ \
  --constructor-args $(cast abi-encode "constructor(address,address)" <owner> <operator>)

# 发创世 tick arc（主网价 0.001 USDC）
cast send <Hub> "deployTick(string,uint64,uint128,uint32,uint128)" \
  arc 21000 1000 10 1000000000000000 --rpc-url arc --account platform
# 发 PoW 公平发射 tick mine（免费挖矿，难度 40 bits ≈ RTX 5090 30-45s/张，每 10 分钟 500 张重定向）
cast send <Hub> "deployPowTick(string,uint64,uint128,uint32,uint8,uint32,uint32)" \
  mine 21000 1000 10 40 500 600 --rpc-url arc --account platform
```

**owner 用多签**:owner 收 5% 手续费并能改 operator。用 Safe 多签而非单个 EOA——单钥丢失=手续费永久锁死,被盗=平台失控。

## 2. 配置

- 编辑 `indexer/config.production.json`:填 `hubAddress`/`marketAddress`/`deployBlock`(Hub 部署所在区块,explorer.arc.io 可查)。**deployBlock 必须 ≤ Hub 部署区块**。
- `sudo cp ops/oracle.env.example /etc/arc20/oracle.env`,填入 oracle 私钥,`sudo chmod 600 /etc/arc20/oracle.env && sudo chown root:root /etc/arc20/oracle.env`。
- (可选)`/etc/arc20/indexer.env` 里放 `RPC_URL=...`,把付费 RPC 端点从仓库里挪出来。

## 3. 启动服务

```bash
sudo cp ops/arc20-indexer.service ops/arc20-oracle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arc20-indexer     # 先起索引器，扫到链头
sudo systemctl enable --now arc20-oracle
journalctl -u arc20-indexer -f                # 看它 "scanned to …"
```

## 4. 前端 + TLS

前端由索引器在 3000 端口直接托管。nginx 只做 TLS + 限流 + SSE 透传:

```bash
# 在 /etc/nginx/nginx.conf 的 http{} 里加两条 zone（见 ops/nginx.conf 顶部注释）
sudo cp ops/nginx.conf /etc/nginx/sites-available/arc20
sudo ln -s /etc/nginx/sites-available/arc20 /etc/nginx/sites-enabled/
sudo certbot --nginx -d arc20.example.com
sudo nginx -t && sudo systemctl reload nginx
```

前端钱包加链用**公共 RPC**(Arc 官方 rpc.mainnet.arc.io,已在 app.js 里固定,不暴露付费端点)。

## 5. 备份 + 监控(cron)

```bash
sudo crontab -u arc20 -e
# 每 10 分钟备份账本，保留约 2 天
*/10 * * * * /opt/arc20/ops/backup.sh >> /var/log/arc20-backup.log 2>&1
# 每分钟健康检查，异常发 Slack
* * * * * WEBHOOK=https://hooks.slack.com/xxx /opt/arc20/ops/healthcheck.sh >/dev/null
```

`healthcheck.sh` 会在这些情况告警:索引器 API 挂了、落后链头 > 30 块(扫描卡住)、oracle 服务停了、confirm/settle 积压(oracle 卡住)。

## 运维要点 / 故障预案

- **索引器是记账权威**:必须持续运行 + 备份 `state.json`/`events.jsonl`。账本可从创世确定性重放——删状态重扫会得到逐字节相同结果(含 PoW 独立复验)。
- **索引器主动停机(exit 1)** 的三种情况:检测到链重组、某 tick 超发、或 PoW 复验与链上不一致(共识故障)。systemd 会重启,但若反复退出,按提示**删 state.json + events.jsonl 后重启**从创世重放(重放是确定的,恢复干净)。重组在单序列器 Arc 上罕见;PoW 不一致则必须先查代码再恢复。
- **oracle 密钥**:专用低额热钱包,只花 gas。定期补 gas。切勿把平台 owner(收费)私钥放这。
- **⚠️ 买单活性(审查发现,建议上线前处理)**:卖家 `accept` 了一个"永不结算"的买单,其账本余额会卡在托管里,直到 oracle 结算或买家撤单。实际中 oracle 秒级结算;但 oracle 长时间宕机 + 买家不撤 = 卡住。缓解:靠 healthcheck 的 settle 积压告警 + 快速恢复 oracle;更硬的做法是给索引器加"N 块内未结算自动释放 accept 托管"(尚未实现,可作为后续加固)。
- **买单信任模型(须向用户明示)**:买家 USDC 链上托管(撤单全额退),但结算依赖 operator 只对"索引器验证过真实交割"的买单调用 `settleBid`。`settleBid` 有链上事件可审计。
- **RPC 容量**:生产可用 Alchemy/dRPC/QuickNode 的 Arc 专用端点;索引器每批一次 `eth_getLogs` + 逐块 `eth_getBlockByNumber` + transfer 的 receipt 复核 + PoW 哈希复算。挖矿高峰前做一次压测。

## 升级合约后

合约字节码变了就是新地址。停 oracle+indexer → 部署新合约 → 更新 config 的地址/deployBlock → **删旧 state.json/events.jsonl** → 重启(索引器会补齐新状态字段,但换合约必须重扫)。
