// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Operators {
    address public admin;
    mapping(address => bool) public operators;
    uint256 public joinFee = 1 ether;
    uint256 public param;

    constructor() {
        admin = msg.sender;
        operators[msg.sender] = true;
    }

    modifier onlyOperator() {
        require(operators[msg.sender], "op");
        _;
    }

    function addOperator(address who) external onlyOperator {
        operators[who] = true;
    }

    function join() external payable {
        require(msg.value >= joinFee, "fee");
        operators[msg.sender] = true;
    }

    function setParam(uint256 p) external onlyOperator {
        param = p;
    }
}
