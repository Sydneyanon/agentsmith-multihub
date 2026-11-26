// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Router {
    address public owner;
    uint256 public total;

    constructor() {
        owner = msg.sender;
    }

    function forward(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.delegatecall(data);
        require(ok, "fail");
        return ret;
    }
}
