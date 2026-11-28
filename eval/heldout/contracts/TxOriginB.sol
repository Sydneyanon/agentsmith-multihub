// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TxOriginB {
    address public owner;

    event Withdrawn(address indexed to, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function withdraw(address payable to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        emit Withdrawn(to, amount);
        to.transfer(amount);
    }
}
