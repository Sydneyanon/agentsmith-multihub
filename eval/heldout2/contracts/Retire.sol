// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Retire {
    address public owner;

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function close() external {
        if (msg.sender != owner) revert NotOwner();
        selfdestruct(payable(owner));
    }
}
