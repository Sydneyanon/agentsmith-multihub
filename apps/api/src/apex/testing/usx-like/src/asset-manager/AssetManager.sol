// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {IUSX} from "../interfaces/IUSX.sol";

contract AssetManager {
    IUSX public token;
    address public treasury;
    uint256 public totalManaged;
    uint256 public lastMove;
    mapping(address => uint256) public strategyBalance;
    address[] public strategies;

    constructor(IUSX t) {
        token = t;
        treasury = msg.sender;
    }

    function deposit(uint256 amount) external {
        require(msg.sender == treasury, "treasury");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer");
        totalManaged += amount;
        lastMove = block.timestamp;
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == treasury, "treasury");
        require(totalManaged >= amount, "managed");
        totalManaged -= amount;
        require(token.transfer(msg.sender, amount), "transfer");
    }

    function addStrategy(address s) external {
        require(msg.sender == treasury, "treasury");
        strategies.push(s);
    }
}
