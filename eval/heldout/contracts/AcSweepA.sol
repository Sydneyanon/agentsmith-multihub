// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AcSweepA {
    address public treasurer;

    event Swept(address indexed to, uint256 amount);

    constructor() {
        treasurer = msg.sender;
    }

    receive() external payable {}

    function withdrawAll(address payable to) external {
        uint256 amount = address(this).balance;
        emit Swept(to, amount);
        to.transfer(amount);
    }
}
