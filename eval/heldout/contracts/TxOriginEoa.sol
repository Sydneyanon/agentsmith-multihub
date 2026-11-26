// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TxOriginEoa {
    mapping(address => uint256) public deposits;

    error ContractsNotAllowed();

    function deposit() external payable {
        if (tx.origin != msg.sender) revert ContractsNotAllowed();
        deposits[msg.sender] += msg.value;
    }

    function depositOf(address who) external view returns (uint256) {
        return deposits[who];
    }
}
