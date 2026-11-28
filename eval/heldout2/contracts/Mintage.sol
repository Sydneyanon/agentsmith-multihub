// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NotSteward();

contract Mintage {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    bool public halted;
    address public steward;

    event Minted(address indexed to, uint256 amount);

    constructor() {
        steward = msg.sender;
    }

    modifier gated() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    function mint(address to, uint256 amount) external gated {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(to, amount);
    }

    function halt() external {
        if (msg.sender != steward) revert NotSteward();
        halted = true;
    }
}
