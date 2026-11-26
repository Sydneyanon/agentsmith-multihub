// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Tracker {
    address public admin;
    address public relay;
    mapping(address => uint256) public lastSeen;
    mapping(address => bool) public approvedUsers;

    constructor(address r) {
        admin = msg.sender;
        relay = r;
    }

    function touch() external {
        lastSeen[tx.origin] = block.timestamp;
    }

    function refund() external payable {
        payable(tx.origin).transfer(msg.value);
    }

    function approveVia(address who) external {
        require(msg.sender == relay && tx.origin == admin, "path");
        approvedUsers[who] = true;
    }
}
