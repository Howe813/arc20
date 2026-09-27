// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "ETH_TRANSFER_FAILED");
    }
}
