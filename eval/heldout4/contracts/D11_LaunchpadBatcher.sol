// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Launchpad {
    uint256 public constant TICKET_PRICE = 0.1 ether;

    address public immutable organizer;
    mapping(address => uint256) public tickets;
    mapping(address => uint256) public credit;
    uint256 public ticketsSold;

    constructor() {
        organizer = msg.sender;
    }

    function buyTickets() public payable {
        uint256 n = msg.value / TICKET_PRICE;
        require(n > 0, "too little");
        tickets[msg.sender] += n;
        ticketsSold += n;
        credit[msg.sender] += msg.value - n * TICKET_PRICE;
    }

    function topUpCredit() public payable {
        credit[msg.sender] += msg.value;
    }

    function withdrawCredit() external {
        uint256 c = credit[msg.sender];
        credit[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: c}("");
        require(ok, "withdraw failed");
    }

    function batch(bytes[] calldata calls) external payable {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = address(this).delegatecall(calls[i]);
            require(ok, "batch item failed");
        }
    }
}
