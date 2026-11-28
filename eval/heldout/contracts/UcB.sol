// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract UcB {
    mapping(address => uint256) public balances;

    event Withdrawn(address indexed who, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send failed");
        emit Withdrawn(msg.sender, amount);
    }
}
