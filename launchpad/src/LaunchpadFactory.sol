// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TaxedToken} from "./TaxedToken.sol";
import {V4TaxHook} from "./V4TaxHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SafeCast as V4SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title LaunchpadFactory
/// @notice One-shot fair-launch factory for {TaxedToken} meme coins on Uniswap v4.
///         Every launch seeds real liquidity in the same transaction, initializes a pool
///         wired to the shared {V4TaxHook}, and dev-buys for the creator with leftover ETH.
///
///         Fixed economics (not launcher-controllable):
///         - Pool LP fee = 0, so total trade friction is exactly the hook's 1% tax
///           (split 0.5% creator / 0.5% treasury). No LP fees accrue anywhere.
///         - tickSpacing = 60; opening price = 5-ETH virtual market cap over 1B supply.
///         - The initial LP position is held by the factory (liquidity locked).
contract LaunchpadFactory is Ownable, IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using V4SafeCast for int128;

    uint256 private constant LAUNCHED_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 private constant OPENING_VIRTUAL_MARKET_CAP = 5 ether;
    uint256 private constant Q96 = 1 << 96;

    /// @notice Fixed pool parameters — no launcher input, so no honeypot fee or price distortion.
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;

    /// @notice Leftover supply not seeded as liquidity is burned here (out of circulation, legible).
    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    V4TaxHook public immutable taxHook;
    address public immutable baseAsset;

    /// @notice Platform treasury bound into each token at launch. Updating it only affects future launches.
    address public treasury;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidV4TaxHook(address taxHook);
    error InvalidMetadata();
    error InvalidOpeningSqrtPrice(uint256 sqrtPriceX96);
    error InvalidInitialLiquidity();
    error InitialLiquiditySlippage(
        uint256 tokenAmount, uint256 maxTokenAmount, uint256 baseAmount, uint256 maxBaseAmount
    );
    error EthNotAccepted();
    error EthTransferFailed(address recipient, uint256 amount);
    error OnlyPoolManager();
    error UnexpectedLiquidityDelta();
    error UnexpectedDevBuyDelta();

    event TreasurySet(address indexed treasury);
    event TokenLaunched(
        address indexed creator,
        address indexed token,
        address baseAsset,
        address treasury,
        PoolId poolId,
        uint24 fee,
        int24 tickSpacing,
        uint160 sqrtPriceX96,
        uint256 openingVirtualMarketCap,
        string imageURI
    );
    event InitialLiquidityAdded(
        address indexed creator,
        address indexed token,
        PoolId indexed poolId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 tokenAmount,
        uint256 baseAmount,
        uint256 creatorBaseIn,
        uint256 creatorTokenOut
    );

    struct InitialLiquidityCallbackData {
        PoolKey key;
        address token;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 maxTokenAmount;
        uint256 maxBaseAmount;
        address creator;
    }

    constructor(IPoolManager poolManager_, V4TaxHook taxHook_, address baseAsset_, address treasury_, address initialOwner)
        Ownable(initialOwner)
    {
        if (
            address(poolManager_) == address(0) || address(taxHook_) == address(0) || baseAsset_ == address(0)
                || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (
            address(taxHook_.poolManager()) != address(poolManager_) || taxHook_.baseAsset() != baseAsset_
                || !taxHook_.hasExpectedHookPermissions()
        ) {
            revert InvalidV4TaxHook(address(taxHook_));
        }

        poolManager = poolManager_;
        taxHook = taxHook_;
        baseAsset = baseAsset_;
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Owner updates the platform treasury used by future launches.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) {
            revert ZeroAddress();
        }
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    receive() external payable {
        if (msg.sender != baseAsset) {
            revert EthNotAccepted();
        }
    }

    /// @notice Launch a meme coin: deploy the token, initialize its v4 pool, seed the
    ///         creator's ETH as single-sided locked liquidity, and dev-buy the rest for them.
    /// @param name          token name (1-32 chars)
    /// @param symbol        token symbol (1-11 chars)
    /// @param imageURI       off-chain avatar reference (e.g. ipfs://CID), 0-256 chars, emitted on-chain
    /// @param maxTokenAmount slippage bound on token consumed by the initial liquidity
    function launch(string calldata name, string calldata symbol, string calldata imageURI, uint256 maxTokenAmount)
        external
        payable
        returns (address token, PoolId poolId, uint256 tokenLiquidityAmount, uint256 baseLiquidityAmount)
    {
        if (msg.value == 0) {
            revert ZeroAmount();
        }
        if (maxTokenAmount == 0) {
            revert InvalidInitialLiquidity();
        }
        _validateMetadata(name, symbol, imageURI);

        IWETH9(baseAsset).deposit{value: msg.value}();

        TaxedToken deployed = new TaxedToken(
            name, symbol, address(this), LAUNCHED_TOKEN_SUPPLY, baseAsset, poolManager, msg.sender, treasury
        );
        token = address(deployed);

        PoolKey memory key = _buildTradingPoolKey(token);
        uint160 targetSqrtPriceX96 =
            _computeOpeningSqrtPriceX96(token, baseAsset, LAUNCHED_TOKEN_SUPPLY, OPENING_VIRTUAL_MARKET_CAP);
        (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            _computeOpeningVirtualLiquidity(token, targetSqrtPriceX96);

        poolId = taxHook.registerPool(key, token);
        poolManager.initialize(key, sqrtPriceX96);

        uint256 creatorBaseIn;
        uint256 creatorTokenOut;
        (tokenLiquidityAmount, baseLiquidityAmount, creatorBaseIn, creatorTokenOut) = _addInitialLiquidity(
            InitialLiquidityCallbackData({
                key: key,
                token: token,
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidity: liquidity,
                maxTokenAmount: maxTokenAmount,
                maxBaseAmount: msg.value,
                creator: msg.sender
            })
        );

        // Burn any supply not used to seed liquidity (out of circulation).
        uint256 remainingTokenBalance = deployed.balanceOf(address(this));
        if (remainingTokenBalance != 0) {
            IERC20(token).safeTransfer(BURN_ADDRESS, remainingTokenBalance);
        }
        _refundBaseAsset(msg.sender);

        emit TokenLaunched(
            msg.sender,
            token,
            baseAsset,
            treasury,
            poolId,
            POOL_FEE,
            TICK_SPACING,
            sqrtPriceX96,
            OPENING_VIRTUAL_MARKET_CAP,
            imageURI
        );
        emit InitialLiquidityAdded(
            msg.sender,
            token,
            poolId,
            tickLower,
            tickUpper,
            liquidity,
            tokenLiquidityAmount,
            baseLiquidityAmount,
            creatorBaseIn,
            creatorTokenOut
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) {
            revert OnlyPoolManager();
        }

        InitialLiquidityCallbackData memory callbackData = abi.decode(data, (InitialLiquidityCallbackData));
        (BalanceDelta delta, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            callbackData.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: callbackData.tickLower,
                tickUpper: callbackData.tickUpper,
                liquidityDelta: SafeCast.toInt256(uint256(callbackData.liquidity)),
                salt: bytes32(0)
            }),
            bytes("")
        );
        if (feesAccrued.amount0() != 0 || feesAccrued.amount1() != 0) {
            revert UnexpectedLiquidityDelta();
        }

        int128 amount0Delta = delta.amount0();
        int128 amount1Delta = delta.amount1();
        if (amount0Delta > 0 || amount1Delta > 0 || (amount0Delta == 0 && amount1Delta == 0)) {
            revert UnexpectedLiquidityDelta();
        }

        uint256 amount0 = amount0Delta == 0 ? 0 : uint256((-amount0Delta).toUint128());
        uint256 amount1 = amount1Delta == 0 ? 0 : uint256((-amount1Delta).toUint128());
        uint256 tokenAmount = Currency.unwrap(callbackData.key.currency0) == callbackData.token ? amount0 : amount1;
        uint256 baseAmount = Currency.unwrap(callbackData.key.currency0) == baseAsset ? amount0 : amount1;

        if (tokenAmount > callbackData.maxTokenAmount || baseAmount > callbackData.maxBaseAmount) {
            revert InitialLiquiditySlippage(
                tokenAmount, callbackData.maxTokenAmount, baseAmount, callbackData.maxBaseAmount
            );
        }

        _settleInitialLiquidityCurrency(callbackData.key.currency0, amount0);
        _settleInitialLiquidityCurrency(callbackData.key.currency1, amount1);

        uint256 baseAvailableForBuy = callbackData.maxBaseAmount - baseAmount;
        uint256 creatorTokenOut;
        uint256 creatorBaseIn;
        if (baseAvailableForBuy != 0) {
            (creatorBaseIn, creatorTokenOut) = _executeCreatorBuy(callbackData, baseAvailableForBuy);
        }

        return abi.encode(tokenAmount, baseAmount, creatorBaseIn, creatorTokenOut);
    }

    function _addInitialLiquidity(InitialLiquidityCallbackData memory callbackData)
        private
        returns (uint256 tokenAmount, uint256 baseAmount, uint256 creatorBaseIn, uint256 creatorTokenOut)
    {
        (tokenAmount, baseAmount, creatorBaseIn, creatorTokenOut) =
            abi.decode(poolManager.unlock(abi.encode(callbackData)), (uint256, uint256, uint256, uint256));
    }

    function _executeCreatorBuy(InitialLiquidityCallbackData memory callbackData, uint256 baseAmountIn)
        private
        returns (uint256 baseAmountSpent, uint256 tokenAmountOut)
    {
        bool zeroForOne = Currency.unwrap(callbackData.key.currency0) == baseAsset;
        BalanceDelta delta = poolManager.swap(
            callbackData.key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -SafeCast.toInt256(baseAmountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            bytes("")
        );

        int128 baseDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 tokenDelta = zeroForOne ? delta.amount1() : delta.amount0();
        if (baseDelta >= 0 || tokenDelta <= 0) {
            revert UnexpectedDevBuyDelta();
        }

        baseAmountSpent = uint256((-baseDelta).toUint128());
        tokenAmountOut = uint256(tokenDelta.toUint128());
        if (baseAmountSpent > baseAmountIn || tokenAmountOut == 0) {
            revert UnexpectedDevBuyDelta();
        }

        _settleInitialLiquidityCurrency(Currency.wrap(baseAsset), baseAmountSpent);
        poolManager.take(Currency.wrap(callbackData.token), callbackData.creator, tokenAmountOut);
    }

    function _settleInitialLiquidityCurrency(Currency currency, uint256 amount) private {
        if (amount == 0) {
            return;
        }

        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        uint256 paid = poolManager.settle();
        if (paid != amount) {
            revert UnexpectedLiquidityDelta();
        }
    }

    function _refundBaseAsset(address recipient) private {
        uint256 baseBalance = IERC20(baseAsset).balanceOf(address(this));
        if (baseBalance == 0) {
            return;
        }

        IWETH9(baseAsset).withdraw(baseBalance);
        _sendEth(recipient, baseBalance);
    }

    function _buildTradingPoolKey(address token) private view returns (PoolKey memory) {
        if (token == address(0)) {
            revert ZeroAddress();
        }

        (Currency currency0, Currency currency1) = token < baseAsset
            ? (Currency.wrap(token), Currency.wrap(baseAsset))
            : (Currency.wrap(baseAsset), Currency.wrap(token));

        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(taxHook))
        });
    }

    function _validateMetadata(string calldata name, string calldata symbol, string calldata imageURI) private pure {
        uint256 n = bytes(name).length;
        uint256 s = bytes(symbol).length;
        // imageURI is an opaque off-chain pointer (ipfs://CID / URL); optional, length-capped.
        if (n == 0 || n > 32 || s == 0 || s > 11 || bytes(imageURI).length > 256) {
            revert InvalidMetadata();
        }
    }

    function _computeOpeningVirtualLiquidity(address token, uint160 targetSqrtPriceX96)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        int24 openingTick = _floorToUsableTick(TickMath.getTickAtSqrtPrice(targetSqrtPriceX96), TICK_SPACING);
        bool tokenIsCurrency0 = token < baseAsset;

        if (tokenIsCurrency0) {
            tickLower = openingTick;
            tickUpper = TickMath.maxUsableTick(TICK_SPACING);
            sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tickLower);
            liquidity = _getLiquidityForAmount0(sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickUpper));
        } else {
            tickLower = TickMath.minUsableTick(TICK_SPACING);
            tickUpper = openingTick;
            sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tickUpper);
            liquidity = _getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), sqrtPriceX96);
        }

        if (tickLower >= tickUpper || liquidity == 0) {
            revert InvalidInitialLiquidity();
        }
    }

    function _getLiquidityForAmount0(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96) private pure returns (uint128) {
        uint256 intermediate = Math.mulDiv(sqrtPriceAX96, sqrtPriceBX96, Q96);
        return SafeCast.toUint128(Math.mulDiv(LAUNCHED_TOKEN_SUPPLY, intermediate, sqrtPriceBX96 - sqrtPriceAX96));
    }

    function _getLiquidityForAmount1(uint160 sqrtPriceAX96, uint160 sqrtPriceBX96) private pure returns (uint128) {
        return SafeCast.toUint128(Math.mulDiv(LAUNCHED_TOKEN_SUPPLY, Q96, sqrtPriceBX96 - sqrtPriceAX96));
    }

    function _floorToUsableTick(int24 tick, int24 tickSpacing) private pure returns (int24) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) {
            compressed -= 1;
        }
        return compressed * tickSpacing;
    }

    function _sendEth(address recipient, uint256 amount) private {
        (bool success,) = recipient.call{value: amount}("");
        if (!success) {
            revert EthTransferFailed(recipient, amount);
        }
    }

    function _computeOpeningSqrtPriceX96(
        address token,
        address quoteAsset,
        uint256 tokenSupply,
        uint256 openingVirtualMarketCap
    ) private pure returns (uint160 sqrtPriceX96) {
        if (token == address(0) || quoteAsset == address(0)) {
            revert ZeroAddress();
        }
        if (tokenSupply == 0 || openingVirtualMarketCap == 0) {
            revert ZeroAmount();
        }

        uint256 ratioX192 = token < quoteAsset
            ? Math.mulDiv(openingVirtualMarketCap, 1 << 192, tokenSupply)
            : Math.mulDiv(tokenSupply, 1 << 192, openingVirtualMarketCap);

        uint256 sqrtRatioX96 = Math.sqrt(ratioX192);
        if (sqrtRatioX96 < TickMath.MIN_SQRT_PRICE || sqrtRatioX96 >= TickMath.MAX_SQRT_PRICE) {
            revert InvalidOpeningSqrtPrice(sqrtRatioX96);
        }

        sqrtPriceX96 = SafeCast.toUint160(sqrtRatioX96);
    }
}
