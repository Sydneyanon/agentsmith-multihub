// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Switchboard {
    address public owner;
    mapping(address => bool) public approved;

    constructor() {
        owner = msg.sender;
    }

    function approve(address t, bool v) external {
        require(msg.sender == owner, "owner");
        approved[t] = v;
    }

    function forward(address target, bytes calldata data) external returns (bytes memory) {
        require(approved[target], "no");
        (bool ok, bytes memory ret) = target.delegatecall(data);
        require(ok, "fail");
        return ret;
    }
}
