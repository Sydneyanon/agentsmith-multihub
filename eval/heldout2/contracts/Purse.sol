// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Purse {
    address payable public owner;

    constructor() {
        owner = payable(msg.sender);
    }

    receive() external payable {}

    function flush() external {
        owner.transfer(address(this).balance);
    }

    function sweepTo(address payable to) external {
        to.transfer(address(this).balance);
    }

    function payout(address payable to, uint256 a) external {
        require(msg.sender == owner, "owner");
        to.transfer(a);
    }
}
