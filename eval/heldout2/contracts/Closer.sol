// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Closer {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function close() external {
        selfdestruct(payable(msg.sender));
    }
}
