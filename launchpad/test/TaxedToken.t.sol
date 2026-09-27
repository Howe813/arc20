// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {TaxedToken} from "../src/TaxedToken.sol";
import {V4TaxHook} from "../src/V4TaxHook.sol";
import {HookMiner} from "../script/libraries/HookMiner.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// @notice Local (no-fork) exercise of the hardened 1% launchpad: each swap taxes 1% on
///         the WETH side (fee-0 pool, so total friction is exactly 1%), split 50/50
///         creator/treasury, pulled as WETH; covers exact-in and exact-out both directions,
///         dust, partial-fill rejection, pool-squat blocking, multi-token, and access control.
contract TaxedTokenTest is Test {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using SafeCast for int128;
    using PoolIdLibrary for PoolKey;

    uint256 private constant INITIAL_SUPPLY = 1_000_000_000 ether;
    uint24 private constant FEE = 0;
    int24 private constant TICK_SPACING = 60;
    address private constant TREASURY = address(0x7EE5);

    MockWETH private base;
    PoolManager private manager;
    PoolSwapTest private swapRouter;
    V4TaxHook private hook;
    LaunchpadFactory private factory;
    TaxedToken private token;
    PoolKey private key;

    receive() external payable {}

    function setUp() public {
        base = new MockWETH();
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));

        hook = _deployHookAtFlaggedAddress();
        factory = new LaunchpadFactory(IPoolManager(address(manager)), hook, address(base), TREASURY, address(this));
        hook.setFactory(address(factory));

        // address(this) is the creator (msg.sender); launch seeds 1 ETH of liquidity + dev-buy.
        vm.deal(address(this), 100 ether);
        (address tokenAddress,,,) = factory.launch{value: 1 ether}("Rob Launch", "ROBL", "ipfs://QmRobLaunch", INITIAL_SUPPLY);
        token = TaxedToken(tokenAddress);
        key = _buildPoolKey(tokenAddress);

        // Fund this test with WETH + token approvals so it can trade.
        base.mint(address(this), 100 ether);
        token.approve(address(swapRouter), type(uint256).max);
        base.approve(address(swapRouter), type(uint256).max);
    }

    function testLaunchWiring() public view {
        assertEq(token.name(), "Rob Launch");
        assertEq(token.totalSupply(), INITIAL_SUPPLY);
        assertEq(token.baseAsset(), address(base));
        assertEq(token.creator(), address(this));
        assertEq(token.treasury(), TREASURY);
        assertEq(hook.BUY_TAX_BPS(), 100);
        assertEq(hook.SELL_TAX_BPS(), 100);
        assertEq(uint256(factory.POOL_FEE()), 0);
        assertEq(int256(factory.TICK_SPACING()), 60);

        (address registeredToken, bool enabled) = hook.poolTaxConfig(key.toId());
        assertEq(registeredToken, address(token));
        assertTrue(enabled);

        // Creator got dev-buy tokens; leftover supply was burned; claims invariant holds.
        assertGt(token.balanceOf(address(this)), 0);
        assertGt(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0);
        assertEq(_claim(address(token)), token.pendingTaxBase());
        assertEq(token.pendingCreator() + token.pendingTreasury(), _claim(address(token)));
    }

    function testOpeningSqrtPriceMatchesFiveEthCap() public view {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), key.toId());
        // Price moved up after the dev-buy, so it must be >= the opening price.
        uint160 opening = _computeFiveEthOpeningSqrtPriceX96(address(token), address(base));
        bool tokenIsC0 = address(token) < address(base);
        if (tokenIsC0) {
            assertGe(sqrtPriceX96, opening);
        } else {
            assertLe(sqrtPriceX96, opening);
        }
    }

    function testBuyExactInChargesOnePercentSplit() public {
        uint256 before = token.pendingTaxBase();
        uint256 baseIn = 1 ether;
        _swapBaseExactInput(baseIn);

        uint256 taxed = token.pendingTaxBase() - before;
        assertEq(taxed, baseIn * 100 / 10_000); // exactly 1% of the specified WETH input
        _assertSplitInvariant();
    }

    function testSellExactInChargesOnePercent() public {
        uint256 sellAmount = token.balanceOf(address(this)) / 4;
        uint256 before = token.pendingTaxBase();
        _swapTokenExactInput(sellAmount);

        assertGt(token.pendingTaxBase(), before); // tax charged on the WETH received
        _assertSplitInvariant();
    }

    function testBuyExactOutputTaxesWethInput() public {
        // Exact-out buy: specify token out; tax is charged on the WETH input side (afterSwap).
        uint256 before = token.pendingTaxBase();
        uint256 tokenOut = 1_000_000 ether;
        bool zeroForOne = Currency.unwrap(key.currency0) == address(base);
        _swap(zeroForOne, int256(tokenOut)); // positive = exact output

        assertGt(token.pendingTaxBase(), before);
        _assertSplitInvariant();
    }

    function testSellExactOutputTaxesWethOutput() public {
        // Exact-out sell: specify a modest WETH out the pool can fill; tax charged in beforeSwap.
        uint256 before = token.pendingTaxBase();
        uint256 wethOut = 0.01 ether;
        bool zeroForOne = Currency.unwrap(key.currency0) == address(token);
        _swap(zeroForOne, int256(wethOut)); // positive = exact output (WETH out)

        assertEq(token.pendingTaxBase() - before, wethOut * 100 / 10_000); // 1% of requested WETH
        _assertSplitInvariant();
    }

    function testExactOutputSellPartialFillReverts() public {
        // Request far more WETH than the pool can output -> partial fill -> hook reverts.
        uint256 hugeWethOut = 1_000_000 ether;
        bool zeroForOne = Currency.unwrap(key.currency0) == address(token);
        vm.expectRevert(); // PartialFillNotSupported bubbles through the swap router
        _swap(zeroForOne, int256(hugeWethOut));
    }

    function testDustSwapChargesNoTax() public {
        // 50 wei WETH in -> tax = 50*100/10000 = 0 -> swap succeeds, nothing accrues.
        uint256 before = token.pendingTaxBase();
        _swapBaseExactInput(50);
        assertEq(token.pendingTaxBase(), before);
    }

    function testCreatorAndTreasuryWithdraw() public {
        _swapBaseExactInput(3 ether);
        _swapTokenExactInput(token.balanceOf(address(this)) / 3);

        uint256 creatorOwed = token.pendingCreator();
        uint256 treasuryOwed = token.pendingTreasury();
        assertGt(creatorOwed, 0);
        assertGt(treasuryOwed, 0);
        // odd wei of the aggregate favors treasury
        assertLe(treasuryOwed - creatorOwed, 1);

        address sink = address(0xC0FFEE);
        assertEq(token.withdrawCreator(sink), creatorOwed);
        assertEq(base.balanceOf(sink), creatorOwed);

        vm.prank(TREASURY);
        assertEq(token.withdrawTreasury(TREASURY), treasuryOwed);
        assertEq(base.balanceOf(TREASURY), treasuryOwed);

        assertEq(token.pendingTaxBase(), 0);
        assertEq(_claim(address(token)), 0);
    }

    function testRepeatedAccrueWithdrawCycles() public {
        for (uint256 i = 0; i < 3; i++) {
            _swapBaseExactInput(1 ether);
            uint256 c = token.pendingCreator();
            uint256 t = token.pendingTreasury();
            if (c > 0) token.withdrawCreator(address(this));
            if (t > 0) {
                vm.prank(TREASURY);
                token.withdrawTreasury(TREASURY);
            }
            _assertSplitInvariant();
        }
        assertEq(token.pendingTaxBase(), 0);
    }

    function testOnlyBeneficiariesCanWithdraw() public {
        _swapBaseExactInput(1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(TaxedToken.OnlyCreator.selector);
        token.withdrawCreator(address(0xBAD));

        vm.prank(address(0xBAD));
        vm.expectRevert(TaxedToken.OnlyTreasury.selector);
        token.withdrawTreasury(address(0xBAD));
    }

    function testWithdrawNothingReverts() public {
        // Drain the creator's dev-buy accrual first, then a second withdraw has nothing left.
        if (token.pendingCreator() > 0) token.withdrawCreator(address(this));
        vm.expectRevert(TaxedToken.NothingToWithdraw.selector);
        token.withdrawCreator(address(this));
    }

    function testThirdPartyPoolInitializeIsBlocked() public {
        // An unregistered pool key naming our hook must not be initializable (launch-DoS guard).
        PoolKey memory rogue = PoolKey({
            currency0: address(0xABCD) < address(base) ? Currency.wrap(address(0xABCD)) : Currency.wrap(address(base)),
            currency1: address(0xABCD) < address(base) ? Currency.wrap(address(base)) : Currency.wrap(address(0xABCD)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        manager.initialize(rogue, TickMath.MIN_SQRT_PRICE + 1e18);
    }

    function testMultipleTokensShareOneHook() public {
        (address t2,,,) = factory.launch{value: 1 ether}("Second", "SEC", "ipfs://QmSecond", INITIAL_SUPPLY);
        TaxedToken token2 = TaxedToken(t2);
        PoolKey memory key2 = _buildPoolKey(t2);

        token2.approve(address(swapRouter), type(uint256).max);
        // Trade token1 and token2; each accrues to its own contract independently.
        _swapBaseExactInput(1 ether);
        uint256 t1Pending = token.pendingTaxBase();

        bool zeroForOne2 = Currency.unwrap(key2.currency0) == address(base);
        swapRouter.swap(
            key2,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne2,
                amountSpecified: -int256(1 ether),
                sqrtPriceLimitX96: zeroForOne2 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );

        assertEq(token.pendingTaxBase(), t1Pending); // token1 unaffected by token2 trade
        assertGt(token2.pendingTaxBase(), 0);
        assertEq(_claim(t2), token2.pendingTaxBase());
    }

    function testFuzzBuyTaxIsExactlyOnePercent(uint96 rawIn) public {
        uint256 baseIn = uint256(rawIn);
        vm.assume(baseIn >= 1e4 && baseIn <= 50 ether); // above dust, within seeded liquidity
        base.mint(address(this), baseIn);
        uint256 before = token.pendingTaxBase();
        _swapBaseExactInput(baseIn);
        assertEq(token.pendingTaxBase() - before, baseIn / 100);
        _assertSplitInvariant();
    }

    function testLaunchEmitsImageURI() public {
        vm.recordLogs();
        (address t,,,) = factory.launch{value: 1 ether}("Img Coin", "IMG", "ipfs://QmAvatar123", INITIAL_SUPPLY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256(
            "TokenLaunched(address,address,address,address,bytes32,uint24,int24,uint160,uint256,string)"
        );
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != sig) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), t); // token = 2nd indexed
            (,,,,,,, string memory uri) =
                abi.decode(logs[i].data, (address, address, bytes32, uint24, int24, uint160, uint256, string));
            assertEq(uri, "ipfs://QmAvatar123");
            found = true;
        }
        assertTrue(found, "TokenLaunched not emitted");
    }

    function testLaunchRejectsOversizeImageURI() public {
        string memory big = string(new bytes(257)); // > 256 cap
        vm.expectRevert(LaunchpadFactory.InvalidMetadata.selector);
        factory.launch{value: 1 ether}("N", "S", big, INITIAL_SUPPLY);
    }

    // --- helpers ---

    function _assertSplitInvariant() private view {
        assertEq(token.pendingCreator() + token.pendingTreasury(), _claim(address(token)));
        assertEq(_claim(address(token)), token.pendingTaxBase());
    }

    function _swapBaseExactInput(uint256 amountIn) private returns (BalanceDelta) {
        bool zeroForOne = Currency.unwrap(key.currency0) == address(base);
        return _swap(zeroForOne, -amountIn.toInt256());
    }

    function _swapTokenExactInput(uint256 amountIn) private returns (BalanceDelta) {
        bool zeroForOne = Currency.unwrap(key.currency0) == address(token);
        return _swap(zeroForOne, -amountIn.toInt256());
    }

    function _swap(bool zeroForOne, int256 amountSpecified) private returns (BalanceDelta) {
        return swapRouter.swap(
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

    function _claim(address account) private view returns (uint256) {
        return manager.balanceOf(account, uint256(uint160(address(base))));
    }

    function _buildPoolKey(address token_) private view returns (PoolKey memory) {
        (Currency currency0, Currency currency1) = token_ < address(base)
            ? (Currency.wrap(token_), Currency.wrap(address(base)))
            : (Currency.wrap(address(base)), Currency.wrap(token_));
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _computeFiveEthOpeningSqrtPriceX96(address launchedToken, address quoteAsset)
        private
        pure
        returns (uint160)
    {
        uint256 ratioX192 = launchedToken < quoteAsset
            ? Math.mulDiv(5 ether, 1 << 192, INITIAL_SUPPLY)
            : Math.mulDiv(INITIAL_SUPPLY, 1 << 192, 5 ether);
        return uint160(Math.sqrt(ratioX192));
    }

    function _deployHookAtFlaggedAddress() private returns (V4TaxHook deployed) {
        bytes memory hookArgs = abi.encode(IPoolManager(address(manager)), address(base), address(this));
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (address predicted, bytes32 salt) = HookMiner.find(address(this), flags, type(V4TaxHook).creationCode, hookArgs);
        deployed = new V4TaxHook{salt: salt}(IPoolManager(address(manager)), address(base), address(this));
        assertEq(address(deployed), predicted);
    }
}
