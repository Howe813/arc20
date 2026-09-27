// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {TaxedToken} from "../src/TaxedToken.sol";
import {V4TaxHook} from "../src/V4TaxHook.sol";
import {HookMiner} from "./libraries/HookMiner.sol";

/// @notice Deploys the rob-20 meme launchpad (V4TaxHook + LaunchpadFactory) on Robinhood Chain.
///
/// Usage:
///   TREASURY=<platform treasury> \
///   forge script script/Deploy.s.sol --rpc-url <robinhood-rpc> --account <deployer> --broadcast
///
/// Env vars (POOL_MANAGER / BASE_ASSET default to Robinhood mainnet; OWNER defaults to deployer):
///   TREASURY     (required) platform treasury that receives 0.5% of every trade
///   POOL_MANAGER (opt) Uniswap v4 PoolManager   — default 0x8366a39CC670B4001A1121B8F6A443A643e40951
///   BASE_ASSET   (opt) WETH                      — default 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
///   OWNER        (opt) final owner of hook+factory — default deployer
contract Deploy is Script {
    address private constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address private constant DEFAULT_BASE_ASSET = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    uint256 private constant SEED_SUPPLY = 1_000_000_000 ether; // matches launched tokens' fixed supply
    uint160 private constant REQUIRED_HOOK_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    error ZeroAddress();
    error Create2FactoryMissing(address create2Factory);
    error HookDeploymentFailed(address expectedHook);
    error InvalidHookDeployment(address hook);

    function run() external returns (V4TaxHook hook, LaunchpadFactory factory, TaxedToken seed) {
        address poolManager = vm.envOr("POOL_MANAGER", DEFAULT_POOL_MANAGER);
        address baseAsset = vm.envOr("BASE_ASSET", DEFAULT_BASE_ASSET);
        address treasury = vm.envAddress("TREASURY");
        address deployer = msg.sender; // set by --account / --private-key
        address owner = vm.envOr("OWNER", deployer);

        if (poolManager == address(0) || baseAsset == address(0) || treasury == address(0) || owner == address(0)) {
            revert ZeroAddress();
        }
        if (CREATE2_FACTORY.code.length == 0) {
            revert Create2FactoryMissing(CREATE2_FACTORY);
        }

        // Deployer owns the hook first so it can call setFactory; ownership moves to `owner` after.
        bytes memory hookArgs = abi.encode(IPoolManager(poolManager), baseAsset, deployer);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, REQUIRED_HOOK_FLAGS, type(V4TaxHook).creationCode, hookArgs);

        vm.startBroadcast();

        hook = _deployHook(hookAddress, salt, hookArgs, poolManager, baseAsset);
        factory = new LaunchpadFactory(IPoolManager(poolManager), hook, baseAsset, treasury, owner);
        hook.setFactory(address(factory));
        if (owner != deployer) {
            hook.transferOwnership(owner);
        }

        // Verification seed: a standalone TaxedToken with the same bytecode as every
        // factory-launched token. Verify THIS once and Blockscout auto-shows the source
        // of all launched tokens via similar-match. It's never launched through the
        // factory, so it never emits TokenLaunched and never appears in the launchpad UI.
        seed = new TaxedToken(
            "rob20 Template", "TEMPLATE", deployer, SEED_SUPPLY, baseAsset, IPoolManager(poolManager), deployer, treasury
        );

        vm.stopBroadcast();

        console2.log("== rob-20 launchpad deployed ==");
        console2.log("V4TaxHook       ", address(hook));
        console2.logBytes32(salt);
        console2.log("LaunchpadFactory", address(factory));
        console2.log("SeedToken(verify)", address(seed));
        console2.log("PoolManager     ", poolManager);
        console2.log("BaseAsset(WETH) ", baseAsset);
        console2.log("Treasury        ", treasury);
        console2.log("Owner           ", owner);
    }

    function _deployHook(
        address hookAddress,
        bytes32 salt,
        bytes memory hookArgs,
        address poolManager,
        address baseAsset
    ) private returns (V4TaxHook hook) {
        if (hookAddress.code.length == 0) {
            bytes memory initCode = abi.encodePacked(type(V4TaxHook).creationCode, hookArgs);
            (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
            if (!success || hookAddress.code.length == 0) {
                revert HookDeploymentFailed(hookAddress);
            }
        }

        hook = V4TaxHook(hookAddress);
        if (
            address(hook.poolManager()) != poolManager || hook.baseAsset() != baseAsset
                || !hook.hasExpectedHookPermissions()
        ) {
            revert InvalidHookDeployment(hookAddress);
        }
    }
}
