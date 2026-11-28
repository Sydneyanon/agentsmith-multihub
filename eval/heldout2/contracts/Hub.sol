// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILogic {
    function version() external view returns (uint256);
}

contract Hub {
    address public admin;
    address public implementation;
    uint256 public currentVersion;

    constructor(address impl) {
        admin = msg.sender;
        implementation = impl;
        currentVersion = ILogic(impl).version();
    }

    function upgradeTo(address impl) external {
        uint256 v = ILogic(impl).version();
        require(v > currentVersion, "old");
        implementation = impl;
        currentVersion = v;
    }
}
