# rob-20 Launchpad (Memes)

Fair-launch factory for real ERC-20 meme coins on Robinhood Chain, built on Uniswap v4.
Each launch deploys a fixed-supply token, initializes a v4 pool, seeds locked liquidity,
and dev-buys the remainder for the creator — all in one transaction. A v4 hook charges a
flat **1% tax on both buys and sells** (WETH side), split 50/50 between the coin's creator
and the platform treasury (0.5% each). No dividends, no in-app trading — the pool is a
standard v4 pool, tradeable anywhere.

## Contracts (`src/`)

- **`TaxedToken.sol`** — fixed 1B supply ERC-20. Creator/treasury fees accrue as PoolManager
  WETH claims (ERC-6909) and are derived on-read from the claim balance minus withdrawn
  counters; `withdrawCreator` / `withdrawTreasury` unlock → burn claim → take WETH.
- **`V4TaxHook.sol`** — beforeSwap/afterSwap hook. `BUY_TAX_BPS = SELL_TAX_BPS = 100`.
  Requires `BEFORE_INITIALIZE` (blocks pool-squatting), reverts on partial fills.
- **`LaunchpadFactory.sol`** — single `launch(name, symbol, imageURI, maxTokenAmount)` path,
  `POOL_FEE = 0`, `TICK_SPACING = 60`. Emits `TokenLaunched(...)`. Leftover supply burned.

`imageURI` is an `ipfs://` reference to a metadata JSON (`{ image, twitter, website, telegram }`);
the indexer resolves it for the Memes UI.

## Mainnet (chain 4663) — LIVE

| Contract | Address |
| --- | --- |
| LaunchpadFactory | `0x28fb2656313029A7753950AadAF828aBeCb99358` |
| V4TaxHook | `0xD90979AC6D802D8F87FC93DC29FE5767EC0960CC` |
| PoolManager (v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

## Build & test

Dependencies are git submodules pinned to specific commits — clone recursively:

```sh
git clone --recursive https://github.com/Howe813/rob-20.git
# or, in an existing checkout:
git submodule update --init --recursive
```

```sh
cd launchpad
forge build
forge test
```

Solidity 0.8.26, `via_ir = true`, `optimizer_runs = 200`, evm `cancun`.

## Deploy

```sh
TREASURY=<platform treasury> \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url <rpc> --private-key <key> --broadcast --slow
```

`OWNER` defaults to the deployer; `POOL_MANAGER` / `BASE_ASSET` default to Robinhood
mainnet. The script mines the hook address (CREATE2 flag bits), deploys hook + factory,
wires them, and deploys a standalone seed `TaxedToken` so Blockscout's bytecode DB has a
verified twin (see `../indexer/verify-keeper.mjs` for the auto-verification keeper).
