// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

library HookMiner {
    uint160 internal constant FLAG_MASK = Hooks.ALL_HOOK_MASK;
    uint256 internal constant MAX_LOOP = 1_000_000;

    error HookSaltNotFound();

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        flags = flags & FLAG_MASK;
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);

        for (uint256 i; i < MAX_LOOP; ++i) {
            hookAddress = computeAddress(deployer, bytes32(i), initCode);
            if ((uint160(hookAddress) & FLAG_MASK) == flags && hookAddress.code.length == 0) {
                return (hookAddress, bytes32(i));
            }
        }

        revert HookSaltNotFound();
    }

    function computeAddress(address deployer, bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(initCode))))));
    }
}
