// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Strongroom {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function withdraw(uint256 a) external {
        require(tx.origin == owner, "owner");
        payable(msg.sender).transfer(a);
    }

    function setOwner(address o) external {
        if (tx.origin != owner) revert("owner");
        owner = o;
    }
}
