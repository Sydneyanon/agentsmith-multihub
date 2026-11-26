// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vesting {
    bool public ready;
    address public beneficiary;
    uint256 public start;

    function init(address b, uint256 s) external {
        require(!ready, "ready");
        beneficiary = b;
        start = s;
    }

    function initTwo(address b, uint256 s) external {
        require(!ready, "ready");
        ready = true;
        beneficiary = b;
        start = s;
    }
}
