// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILogic {
    function version() external view returns (uint256);
}

abstract contract Governed {
    address internal admin;

    modifier onlyAdmin(address who) {
        require(who == admin, "admin");
        _;
    }
}

contract Spoke is Governed {
    address public implementation;
    uint256 public currentVersion;

    constructor(address impl) {
        admin = msg.sender;
        implementation = impl;
        currentVersion = ILogic(impl).version();
    }

    function upgradeTo(address impl) external onlyAdmin(msg.sender) {
        uint256 v = ILogic(impl).version();
        require(v > currentVersion, "old");
        implementation = impl;
        currentVersion = v;
    }
}
