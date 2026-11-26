// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Throttle {
    address public admin;
    uint256 public limit;
    uint256 public floor;
    uint256 public constant MAX = 1000;

    constructor() {
        admin = msg.sender;
    }

    function setLimit(uint256 v) external {
        if (v > MAX) {
            limit = MAX;
            return;
        }
        require(msg.sender == admin, "admin");
        limit = v;
    }

    function setFloor(uint256 v) external {
        if (v == floor) return;
        require(msg.sender == admin, "admin");
        floor = v;
    }
}
