// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Simple ETH vault
contract ReentVaultB {
    mapping(address => uint256) public balances;
    bool private busy;

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    error NothingToWithdraw();

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw() external {
        require(!busy, "busy");
        busy = true;
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
        busy = false;
        emit Withdrawn(msg.sender, amount);
    }
}
