// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Teller {
    mapping(address => uint256) public ledger;

    event Paid(address indexed who, uint256 amount);

    function put() external payable {
        ledger[msg.sender] += msg.value;
    }

    function cashOut(uint256 amount) external {
        require(ledger[msg.sender] >= amount, "low");
        ledger[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send failed");
        emit Paid(msg.sender, amount);
    }
}
