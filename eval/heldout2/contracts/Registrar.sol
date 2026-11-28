// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Registrar {
    address public owner;
    uint256 public fee;

    function initialize(address o, uint256 f) external {
        owner = o;
        fee = f;
    }

    function setFee(uint256 f) external {
        require(msg.sender == owner, "owner");
        fee = f;
    }
}
