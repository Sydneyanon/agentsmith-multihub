// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Checkpoint {
    address public owner;
    mapping(address => bool) public members;

    constructor() {
        owner = msg.sender;
    }

    modifier eoaOnly() {
        require(tx.origin == msg.sender, "contracts");
        _;
    }

    function join() external eoaOnly {
        members[msg.sender] = true;
    }

    function withdraw(uint256 a) external {
        require(msg.sender == owner, "owner");
        payable(msg.sender).transfer(a);
    }

    receive() external payable {}
}
