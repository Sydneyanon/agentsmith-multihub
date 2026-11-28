// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Simple ETH vault
contract ReentVaultA {
    mapping(address => uint256) public balances;

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    error NothingToWithdraw();

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
    }
}
