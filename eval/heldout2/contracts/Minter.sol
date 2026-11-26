// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Minter {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    bool public halted;
    address public steward;

    event Minted(address indexed to, uint256 amount);

    constructor() {
        steward = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function halt() external {
        halted = true;
    }
}
