# 演示栈 / 常驻环境 共识版本切换清单(R4 运维清单)

> 背景:合约/索引器/前端在 R2(共识 v2:PoW 预映像含铸造计数)与 R3(共识 v4:
> 买单 accept 链上绑定 `pendingSeller`)升级了共识;长期运行的演示栈
> (anvil:8545 + indexer:3000)若仍使用旧版已部署合约,则处于「旧链 + 新索引器/
> 新前端」组合:浏览器矿工的解会被合约拒(BadPow)、买单结算会被合约回退。
> 本清单供运维窗口一次性收敛到最新共识。执行后请在 docs/worklog.md 记录。

## 0. 前置

- [ ] 确认无进行中的演示/走查(停机窗口内操作)
- [ ] 备份当前 `indexer/config*.json`、`state.json`、`events.jsonl`
- [ ] `git status` 干净,`forge build` 通过

## 1. 重新部署双合约(Hub + Market)

```bash
# 以演示栈使用的部署 key / RPC(8545)为准;顺序:Hub 先、Market 后
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
# 或按 README「上线步骤」用 cast 逐个部署;记录两个新地址
```

- [ ] 新 **InscriptionHub** 地址:`0x…`
- [ ] 新 **InscriptionMarket** 地址(owner=operator):`0x…`

## 2. 更新索引器配置

- [ ] `indexer/config.json`(及演示用的 `config*.json` 变体):
  - [ ] `hubAddress` → 新 Hub
  - [ ] `marketAddress` → 新 Market
  - [ ] `deployBlock` → 部署所在区块(或 0,从 genesis 重扫)
- [ ] 删除旧 `state.json` / `events.jsonl`(旧链账本与新共识不兼容,重放从零开始)
- [ ] 可选:`PINATA_JWT`(若需 pin)、`PIN_TOKEN`(若需跨机调用 pin 端点)

## 3. 重启进程

- [ ] 重启 anvil:8545(或连接已含新合约的链)
- [ ] 重启 indexer:3000(`node indexer/indexer.mjs`)——静态前端随之更新
- [ ] 重启 oracle(如部署):`ORACLE_ACCOUNT/… node indexer/oracle.mjs`
- [ ] **不要**复用旧链上的 tick/挂单/买单:全部按新共识重新部署/创建

## 4. 验证(缺一不可)

- [ ] `curl -s localhost:3000/api/status` 返回且 `lastBlock` 前进
- [ ] 浏览器打开 `http://localhost:3000`,硬刷新(Ctrl+F5)
- [ ] 用低难度 tick(d≤8)在浏览器矿工挖出一张并上链成功(验证共识 v2 预映像)
- [ ] 下一个买单 → 卖家 Fill(accept 发往 **Market**)→ oracle 结算到账
      (验证共识 v4 绑定 + settleBid 只付绑定卖家)
- [ ] `bash ops/healthcheck.sh` 绿灯(或按环境配置 API/RPC/ORACLE_ADDR)

## 5. 记录

- [ ] 在 docs/worklog.md 追加「演示栈已切换到 v2/v4 共识」与日期
