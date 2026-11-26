// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Enrollment {
    address public owner;
    uint256 public fee;
    bool private _ready;

    function initialize(address o, uint256 f) external {
        require(!_ready, "done");
        _ready = true;
        owner = o;
        fee = f;
    }

    function setFee(uint256 f) external {
        require(msg.sender == owner, "owner");
        fee = f;
    }
}
