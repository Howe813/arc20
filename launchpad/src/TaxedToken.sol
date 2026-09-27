// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title TaxedToken
/// @notice Fixed-supply ERC20 launched by {LaunchpadFactory}. The shared {V4TaxHook}
///         charges 1% on the WETH side of every swap and mints it to this contract as a
///         PoolManager ERC-6909 WETH claim. That claim balance IS the total accrued tax;
///         creator and treasury each own half and pull their share as real WETH.
///
///         Accounting is derived, not mirrored: no per-swap callback or storage write.
///         Only two counters (creatorWithdrawn / treasuryWithdrawn) are touched, and only
///         on withdrawal. This keeps the hot swap path callback-free.
contract TaxedToken is IUnlockCallback, ERC20 {
    using CurrencyLibrary for Currency;

    address public immutable baseAsset; // WETH
    IPoolManager public immutable poolManager;
    address public immutable launchFactory;

    /// @notice Receives half of every tax (the token creator).
    address public immutable creator;
    /// @notice Receives the other half of every tax (platform treasury).
    address public immutable treasury;

    /// @notice WETH already pulled by each beneficiary. `total accrued` is derived as
    ///         current claim balance + both counters, so these never decrease.
    uint256 public creatorWithdrawn;
    uint256 public treasuryWithdrawn;

    bool private _poolUnlockActive;

    error ZeroAddress();
    error ZeroAmount();
    error OnlyCreator();
    error OnlyTreasury();
    error OnlyPoolManager();
    error UnauthorizedUnlockCallback();
    error NothingToWithdraw();

    event CreatorWithdraw(address indexed to, uint256 amount);
    event TreasuryWithdraw(address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        address supplyRecipient,
        uint256 initialSupply,
        address baseAsset_,
        IPoolManager poolManager_,
        address creator_,
        address treasury_
    ) ERC20(name_, symbol_) {
        if (
            supplyRecipient == address(0) || baseAsset_ == address(0) || address(poolManager_) == address(0)
                || creator_ == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (initialSupply == 0) {
            revert ZeroAmount();
        }

        baseAsset = baseAsset_;
        poolManager = poolManager_;
        launchFactory = msg.sender;
        creator = creator_;
        treasury = treasury_;

        _mint(supplyRecipient, initialSupply);
    }

    /// @notice Total WETH tax ever accrued to this token (redeemed + still-held claims).
    function totalTaxAccrued() public view returns (uint256) {
        return _claimBalance() + creatorWithdrawn + treasuryWithdrawn;
    }

    /// @notice WETH the creator can still withdraw. Odd wei of the aggregate favors treasury.
    function pendingCreator() public view returns (uint256) {
        uint256 total = totalTaxAccrued();
        uint256 owedTotal = total / 2;
        return owedTotal - creatorWithdrawn;
    }

    /// @notice WETH the treasury can still withdraw.
    function pendingTreasury() public view returns (uint256) {
        uint256 total = totalTaxAccrued();
        uint256 owedTotal = total - (total / 2);
        return owedTotal - treasuryWithdrawn;
    }

    /// @notice Total unredeemed WETH tax held as PoolManager claims.
    function pendingTaxBase() external view returns (uint256) {
        return _claimBalance();
    }

    /// @notice Creator pulls their accrued WETH tax to `to`.
    function withdrawCreator(address to) external returns (uint256 amount) {
        if (msg.sender != creator) {
            revert OnlyCreator();
        }
        if (to == address(0)) {
            revert ZeroAddress();
        }
        amount = pendingCreator();
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        creatorWithdrawn += amount; // effects before interaction (CEI)
        _redeemTo(to, amount);
        emit CreatorWithdraw(to, amount);
    }

    /// @notice Treasury pulls its accrued WETH tax to `to`.
    function withdrawTreasury(address to) external returns (uint256 amount) {
        if (msg.sender != treasury) {
            revert OnlyTreasury();
        }
        if (to == address(0)) {
            revert ZeroAddress();
        }
        amount = pendingTreasury();
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        treasuryWithdrawn += amount; // effects before interaction (CEI)
        _redeemTo(to, amount);
        emit TreasuryWithdraw(to, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) {
            revert OnlyPoolManager();
        }
        if (!_poolUnlockActive) {
            revert UnauthorizedUnlockCallback();
        }

        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        Currency base = Currency.wrap(baseAsset);
        poolManager.burn(address(this), base.toId(), amount);
        poolManager.take(base, to, amount);
        return abi.encode(amount);
    }

    function _redeemTo(address to, uint256 amount) private {
        _poolUnlockActive = true;
        poolManager.unlock(abi.encode(to, amount));
        _poolUnlockActive = false;
    }

    function _claimBalance() private view returns (uint256) {
        return poolManager.balanceOf(address(this), uint256(uint160(baseAsset)));
    }
}
