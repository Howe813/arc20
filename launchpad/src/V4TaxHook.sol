// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {SafeCast as OZSafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title V4TaxHook
/// @notice Shared Uniswap v4 hook that charges a fixed 1% tax on the WETH (base-asset)
///         side of buys and sells, minting the tax to the launched token as a
///         PoolManager ERC-6909 claim. The token derives creator/treasury balances from
///         that claim (no callback needed).
///
///         Hardened vs the Nonce original:
///         - beforeInitialize gates pool creation to factory-registered pools only,
///           so third parties can't squat the predictable token pool key (launch DoS).
///         - afterSwap reverts on partial fills for the beforeSwap-taxed swap shapes,
///           preventing the fixed tax from over-charging an unfilled amount.
///         - WETH is an immutable; per-pool config is a single storage slot.
contract V4TaxHook is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using SafeCast for int128;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BUY_TAX_BPS = 100;
    uint256 public constant SELL_TAX_BPS = 100;
    uint160 public constant REQUIRED_HOOK_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    IPoolManager public immutable poolManager;
    /// @notice The single base asset all launched pools trade against (WETH).
    address public immutable baseAsset;
    address public factory;

    struct PoolTaxConfig {
        address token;
        bool enabled;
    }

    mapping(PoolId poolId => PoolTaxConfig config) public poolTaxConfig;

    error ZeroAddress();
    error NotPoolManager();
    error NotFactory();
    error FactoryAlreadySet();
    error InvalidHookAddress(address hook);
    error InvalidPoolHook();
    error TokenNotInPool(address token);
    error BaseAssetNotInPool();
    error PoolAlreadyRegistered(PoolId poolId);
    error PoolNotRegistered(PoolId poolId);
    error UnsupportedHook();
    error TaxAmountOverflow();
    error PartialFillNotSupported();

    event FactorySet(address indexed factory);
    event PoolRegistered(PoolId indexed poolId, address indexed token, address indexed baseAsset);
    event V4TaxCollected(
        PoolId indexed poolId,
        address indexed token,
        address indexed sender,
        bool isBuy,
        uint256 grossAmount,
        uint256 taxAmount
    );

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) {
            revert NotPoolManager();
        }
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) {
            revert NotFactory();
        }
        _;
    }

    constructor(IPoolManager poolManager_, address baseAsset_, address initialOwner) Ownable(initialOwner) {
        if (address(poolManager_) == address(0) || baseAsset_ == address(0)) {
            revert ZeroAddress();
        }

        poolManager = poolManager_;
        baseAsset = baseAsset_;

        if ((uint160(address(this)) & Hooks.ALL_HOOK_MASK) != REQUIRED_HOOK_FLAGS) {
            revert InvalidHookAddress(address(this));
        }
    }

    function setFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) {
            revert ZeroAddress();
        }
        if (factory != address(0)) {
            revert FactoryAlreadySet();
        }

        factory = factory_;
        emit FactorySet(factory_);
    }

    function registerPool(PoolKey calldata key, address token) external onlyFactory returns (PoolId poolId) {
        if (token == address(0)) {
            revert ZeroAddress();
        }
        if (address(key.hooks) != address(this)) {
            revert InvalidPoolHook();
        }
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        // Exactly one side must be the token and the other must be this hook's base asset.
        if (currency0 == token) {
            if (currency1 != baseAsset) revert BaseAssetNotInPool();
        } else if (currency1 == token) {
            if (currency0 != baseAsset) revert BaseAssetNotInPool();
        } else {
            revert TokenNotInPool(token);
        }

        poolId = key.toId();
        if (poolTaxConfig[poolId].enabled) {
            revert PoolAlreadyRegistered(poolId);
        }

        poolTaxConfig[poolId] = PoolTaxConfig({token: token, enabled: true});
        emit PoolRegistered(poolId, token, baseAsset);
    }

    function hasExpectedHookPermissions() external view returns (bool) {
        return (uint160(address(this)) & Hooks.ALL_HOOK_MASK) == REQUIRED_HOOK_FLAGS;
    }

    /// @notice Only pools the factory has registered may be initialized with this hook.
    ///         Blocks a griefer from pre-initializing the predictable token pool key and
    ///         bricking the launch (which would otherwise revert on AlreadyInitialized).
    function beforeInitialize(address, PoolKey calldata key, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (!poolTaxConfig[key.toId()].enabled) {
            revert PoolNotRegistered(key.toId());
        }
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        PoolTaxConfig memory config = poolTaxConfig[poolId];
        if (!config.enabled) {
            revert PoolNotRegistered(poolId);
        }

        Currency specified = _specifiedCurrency(key, params);
        if (Currency.unwrap(specified) != baseAsset) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        bool isBuy = params.amountSpecified < 0;
        uint256 grossAmount = _absAmountSpecified(params.amountSpecified);
        uint256 taxAmount = _collectTax(poolId, config.token, specified, sender, isBuy, grossAmount);

        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(_toInt128(taxAmount), 0), 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolId poolId = key.toId();
        PoolTaxConfig memory config = poolTaxConfig[poolId];
        if (!config.enabled) {
            revert PoolNotRegistered(poolId);
        }

        Currency unspecified = _unspecifiedCurrency(key, params);
        if (Currency.unwrap(unspecified) == baseAsset) {
            // Base asset is the computed/output side — tax the actual filled amount here.
            int128 baseDelta = Currency.unwrap(key.currency0) == baseAsset ? delta.amount0() : delta.amount1();
            uint256 grossAmount = baseDelta < 0 ? uint256((-baseDelta).toUint128()) : uint256(baseDelta.toUint128());
            bool isBuy = baseDelta < 0;
            uint256 taxAmount = _collectTax(poolId, config.token, unspecified, sender, isBuy, grossAmount);
            return (IHooks.afterSwap.selector, _toInt128(taxAmount));
        }

        // Base asset is the specified side — already taxed in beforeSwap on the requested
        // amount. Reject partial fills so the fixed tax can't over-charge an unfilled amount.
        int128 specifiedDelta = Currency.unwrap(key.currency0) == baseAsset ? delta.amount0() : delta.amount1();
        uint256 gross = _absAmountSpecified(params.amountSpecified);
        uint256 tax = gross * (params.amountSpecified < 0 ? BUY_TAX_BPS : SELL_TAX_BPS) / BPS_DENOMINATOR;
        // Full fill: the pool's specified-side delta equals amountSpecified + hook tax (same sign).
        if (int256(specifiedDelta) != params.amountSpecified + int256(tax)) {
            revert PartialFillNotSupported();
        }
        return (IHooks.afterSwap.selector, 0);
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert UnsupportedHook();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert UnsupportedHook();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert UnsupportedHook();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert UnsupportedHook();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert UnsupportedHook();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnsupportedHook();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnsupportedHook();
    }

    function _collectTax(
        PoolId poolId,
        address token,
        Currency taxCurrency,
        address sender,
        bool isBuy,
        uint256 grossAmount
    ) private returns (uint256 taxAmount) {
        taxAmount = grossAmount * (isBuy ? BUY_TAX_BPS : SELL_TAX_BPS) / BPS_DENOMINATOR;
        if (taxAmount == 0) {
            return 0;
        }

        // Mint the tax as an ERC-6909 base-asset claim credited to the token contract.
        // The token derives creator/treasury balances from this claim — no callback.
        poolManager.mint(token, taxCurrency.toId(), taxAmount);

        emit V4TaxCollected(poolId, token, sender, isBuy, grossAmount, taxAmount);
    }

    function _specifiedCurrency(PoolKey calldata key, IPoolManager.SwapParams calldata params)
        private
        pure
        returns (Currency)
    {
        return (params.zeroForOne == (params.amountSpecified < 0)) ? key.currency0 : key.currency1;
    }

    function _unspecifiedCurrency(PoolKey calldata key, IPoolManager.SwapParams calldata params)
        private
        pure
        returns (Currency)
    {
        return (params.zeroForOne == (params.amountSpecified < 0)) ? key.currency1 : key.currency0;
    }

    function _absAmountSpecified(int256 amountSpecified) private pure returns (uint256) {
        if (amountSpecified == type(int256).min) {
            revert TaxAmountOverflow();
        }

        return amountSpecified < 0 ? OZSafeCast.toUint256(-amountSpecified) : OZSafeCast.toUint256(amountSpecified);
    }

    function _toInt128(uint256 value) private pure returns (int128) {
        if (value >= 1 << 127) {
            revert TaxAmountOverflow();
        }

        return value.toInt128();
    }
}
