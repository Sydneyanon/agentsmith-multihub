// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Bank2 {
    mapping(address => uint256) public credits;
    mapping(address => bool) public claimed;

    function deposit() external payable { credits[msg.sender] += msg.value; }

    // pays the full credit, zeroes it only after the call
    function cashOut() external {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "none");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
        credits[msg.sender] = 0;
    }

    // unchecked subtraction after the call
    function withdrawUnchecked(uint256 amount) external {
        require(credits[msg.sender] >= amount, "low");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
        unchecked { credits[msg.sender] -= amount; }
    }

    // one-time bonus flagged only after paying
    function claimBonus() external {
        require(!claimed[msg.sender], "claimed");
        (bool ok, ) = msg.sender.call{value: 1 ether}("");
        require(ok, "fail");
        claimed[msg.sender] = true;
    }
}
