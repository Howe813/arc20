// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev e2e helper: forwards arbitrary calldata so tests can exercise
///      contract-mediated (internal-call) interactions with Hub/Market —
///      the pattern a Gnosis Safe or factory would produce.
contract CallProxy {
    function exec(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, "proxy call failed");
        return ret;
    }
}
