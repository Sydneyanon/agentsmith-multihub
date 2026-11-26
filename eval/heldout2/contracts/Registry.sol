// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Registry {
    address public owner;
    address public oracle;
    mapping(address => uint256) public stake;

    constructor() {
        owner = msg.sender;
    }

    function stakeIn() external payable {
        stake[msg.sender] += msg.value;
    }

    function setOracle(address o) external {
        require(stake[msg.sender] > 0, "no stake");
        oracle = o;
    }

    function setOwner(address o) external {
        require(msg.sender != owner, "same");
        owner = o;
    }

    function setOracleSelf(address o) external {
        require(msg.sender == address(this), "self");
        oracle = o;
    }
}
