// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface ITaxed {
    function pendingTaxBase() external view returns (uint256);
}

/// @notice Live buy + sell against a launched coin's v4 pool on Robinhood testnet,
///         proving trades execute and the 1% tax accrues. Env: POOL_MANAGER, WETH, HOOK, TOKEN.
contract TradeTest is Script {
    using BalanceDeltaLibrary for BalanceDelta;

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address weth = vm.envAddress("WETH");
        address hook = vm.envAddress("HOOK");
        address token = vm.envAddress("TOKEN");

        PoolKey memory key = _key(token, weth, hook);

        vm.startBroadcast();
        PoolSwapTest router = new PoolSwapTest(IPoolManager(poolManager));

        // --- BUY: 0.001 WETH -> token (exact-in) ---
        IWETH9(weth).deposit{value: 0.001 ether}();
        IWETH9(weth).approve(address(router), type(uint256).max);

        uint256 tokBefore = IERC20(token).balanceOf(msg.sender);
        uint256 taxBefore = ITaxed(token).pendingTaxBase();
        bool buyZeroForOne = Currency.unwrap(key.currency0) == weth;
        _swap(router, key, buyZeroForOne, -int256(0.001 ether));
        uint256 tokBought = IERC20(token).balanceOf(msg.sender) - tokBefore;
        console2.log("BUY  0.001 WETH -> token received:", tokBought);
        console2.log("  tax accrued this trade (wei):", ITaxed(token).pendingTaxBase() - taxBefore);

        // --- SELL: half of what we just bought -> WETH (exact-in) ---
        uint256 sellAmt = tokBought / 2;
        IERC20(token).approve(address(router), type(uint256).max);
        uint256 wethBefore = IWETH9(weth).balanceOf(msg.sender);
        taxBefore = ITaxed(token).pendingTaxBase();
        bool sellZeroForOne = Currency.unwrap(key.currency0) == token;
        _swap(router, key, sellZeroForOne, -int256(sellAmt));
        console2.log("SELL token -> WETH received:", IWETH9(weth).balanceOf(msg.sender) - wethBefore);
        console2.log("  tax accrued this trade (wei):", ITaxed(token).pendingTaxBase() - taxBefore);
        console2.log("total pendingTaxBase now (wei):", ITaxed(token).pendingTaxBase());

        vm.stopBroadcast();
    }

    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, int256 amountSpecified) private {
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _key(address token, address weth, address hook) private pure returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < weth
            ? (Currency.wrap(token), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(hook)});
    }
}
