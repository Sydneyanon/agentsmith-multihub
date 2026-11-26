// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

contract LotteryPot is Ownable {
    uint256 public constant TICKET = 0.01 ether;
    address[] public players;
    uint256 public round;

    event Entered(address indexed player, uint256 indexed round);
    event Drawn(address indexed winner, uint256 prize, uint256 indexed round);

    function enter() external payable {
        require(msg.value == TICKET, "ticket price");
        players.push(msg.sender);
        emit Entered(msg.sender, round);
    }

    function draw(uint256 seed) external onlyOwner {
        require(players.length > 0, "no players");
        address winner = players[uint256(keccak256(abi.encode(seed, block.prevrandao))) % players.length];
        uint256 prize = address(this).balance;
        delete players;
        round++;
        (bool ok, ) = winner.call{value: prize}("");
        require(ok, "payout failed");
        emit Drawn(winner, prize, round - 1);
    }

    function terminate() external onlyOwner {
        selfdestruct(payable(owner));
    }
}
