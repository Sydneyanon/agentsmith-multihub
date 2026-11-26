// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PayrollSplitter {
    struct Payee {
        address payable account;
        uint96 shareBps;
    }

    address public immutable controller;
    Payee[] public payees;
    uint256 public lastRun;

    event Distributed(uint256 total, uint256 when);

    constructor(Payee[] memory list) {
        controller = msg.sender;
        uint256 sum;
        for (uint256 i = 0; i < list.length; i++) {
            payees.push(list[i]);
            sum += list[i].shareBps;
        }
        require(sum == 10_000, "shares");
    }

    receive() external payable {}

    function distribute() external {
        require(msg.sender == controller, "controller");
        uint256 total = address(this).balance;
        for (uint256 i = 0; i < payees.length; i++) {
            uint256 cut = (total * payees[i].shareBps) / 10_000;
            require(payees[i].account.send(cut), "payout failed");
        }
        lastRun = block.timestamp;
        emit Distributed(total, block.timestamp);
    }
}
