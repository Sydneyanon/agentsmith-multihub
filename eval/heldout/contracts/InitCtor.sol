// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InitCtor {
    address public owner;
    uint256 public cap;

    event Deployed(address indexed owner, uint256 cap);

    constructor(uint256 initialCap) {
        owner = msg.sender;
        cap = initialCap;
        emit Deployed(msg.sender, initialCap);
    }

    function remaining(uint256 used) external view returns (uint256) {
        return used >= cap ? 0 : cap - used;
    }
}
