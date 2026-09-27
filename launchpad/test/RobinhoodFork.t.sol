// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {TaxedToken} from "../src/TaxedToken.sol";
import {V4TaxHook} from "../src/V4TaxHook.sol";
import {HookMiner} from "../script/libraries/HookMiner.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice End-to-end fork test against Robinhood Chain's real Uniswap v4 deployment.
///         Confirms on-chain: CREATE2 hook-flag mining (now incl. BEFORE_INITIALIZE),
///         a fee-0 launch with seeded liquidity + creator dev-buy, external swaps charge
///         1% on the WETH side, and creator/treasury each withdraw their 50/50 WETH share.
///
///         RPC: ROBINHOOD_FORK_RPC or the public endpoint. Optionally pin a block with
///         ROBINHOOD_FORK_BLOCK for determinism. Skips gracefully if the fork fails.
contract RobinhoodForkTest is Test {
    using SafeCast for uint256;

    address private constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    string private constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

    address private constant TREASURY = address(0x7EE5);
    uint256 private constant INITIAL_SUPPLY = 1_000_000_000 ether;

    V4TaxHook private hook;

    receive() external payable {}

    function testForkRobinhoodLaunchTaxAndWithdraw() public {
        string memory rpcUrl = vm.envOr("ROBINHOOD_FORK_RPC", DEFAULT_RPC);
        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", uint256(0));
        try this.createFork(rpcUrl, forkBlock) {}
        catch {
            vm.skip(true, "cannot fork Robinhood RPC");
            return;
        }

        _assertV4Present();

        hook = _deployHookViaCreate2();
        LaunchpadFactory factory =
            new LaunchpadFactory(IPoolManager(POOL_MANAGER), hook, WETH, TREASURY, address(this));
        hook.setFactory(address(factory));

        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        vm.deal(address(this), 30 ether);

        (address tokenAddress,,,) = factory.launch{value: 5 ether}("Rob Fork", "RFORK", "ipfs://QmRobFork", INITIAL_SUPPLY);
        TaxedToken token = TaxedToken(tokenAddress);
        PoolKey memory key = _buildPoolKey(tokenAddress);

        assertEq(token.creator(), address(this));
        assertEq(token.treasury(), TREASURY);
        assertGt(token.balanceOf(POOL_MANAGER), 0);
        assertGt(token.pendingTaxBase(), 0); // dev-buy already taxed
        assertEq(_claim(tokenAddress), token.pendingTaxBase());

        // External buy through a real v4 swap router.
        IWETH9(WETH).deposit{value: 1 ether}();
        IWETH9(WETH).approve(address(swapRouter), type(uint256).max);

        uint256 tokenBefore = token.balanceOf(address(this));
        bool zeroForOne = Currency.unwrap(key.currency0) == WETH;
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -uint256(0.1 ether).toInt256(),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );

        assertGt(token.balanceOf(address(this)), tokenBefore);
        uint256 pending = token.pendingTaxBase();
        assertEq(token.pendingCreator() + token.pendingTreasury(), pending);
        assertLe(token.pendingTreasury() - token.pendingCreator(), 1);

        uint256 creatorOwed = token.pendingCreator();
        uint256 treasuryOwed = token.pendingTreasury();

        address creatorSink = address(0xC0FFEE);
        token.withdrawCreator(creatorSink);
        assertEq(IWETH9(WETH).balanceOf(creatorSink), creatorOwed);

        vm.prank(TREASURY);
        token.withdrawTreasury(TREASURY);
        assertEq(IWETH9(WETH).balanceOf(TREASURY), treasuryOwed);

        assertEq(token.pendingTaxBase(), 0);
        assertEq(_claim(tokenAddress), 0);
    }

    /// @dev external wrapper so the fork creation can be try/catch'd.
    function createFork(string calldata rpcUrl, uint256 forkBlock) external {
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
    }

    function _assertV4Present() private view {
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager missing");
        assertGt(WETH.code.length, 0, "WETH missing");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
        assertGt(CREATE2_FACTORY.code.length, 0, "CREATE2 factory missing");
    }

    function _deployHookViaCreate2() private returns (V4TaxHook deployed) {
        bytes memory hookArgs = abi.encode(IPoolManager(POOL_MANAGER), WETH, address(this));
        uint160 requiredFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, requiredFlags, type(V4TaxHook).creationCode, hookArgs);
        bytes memory initCode = abi.encodePacked(type(V4TaxHook).creationCode, hookArgs);

        (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        assertTrue(success, "hook deployment failed");

        deployed = V4TaxHook(hookAddress);
        assertGt(hookAddress.code.length, 0, "hook missing");
        assertTrue(deployed.hasExpectedHookPermissions());
    }

    function _claim(address account) private view returns (uint256) {
        return IPoolManager(POOL_MANAGER).balanceOf(account, uint256(uint160(WETH)));
    }

    function _buildPoolKey(address token_) private view returns (PoolKey memory) {
        (Currency currency0, Currency currency1) = token_ < WETH
            ? (Currency.wrap(token_), Currency.wrap(WETH))
            : (Currency.wrap(WETH), Currency.wrap(token_));
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }
}
