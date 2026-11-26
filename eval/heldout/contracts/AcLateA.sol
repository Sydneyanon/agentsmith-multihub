// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AcLateA {
    address public owner;
    address public treasury;

    event TreasuryChanged(address indexed treasury);
    event Rejected(address indexed caller);

    constructor() {
        owner = msg.sender;
        treasury = msg.sender;
    }

    function setTreasury(address newTreasury) external {
        treasury = newTreasury;
        if (msg.sender != owner) {
            emit Rejected(msg.sender);
            return;
        }
        emit TreasuryChanged(newTreasury);
    }
}
