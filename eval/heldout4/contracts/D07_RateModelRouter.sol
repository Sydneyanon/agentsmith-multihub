// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InterestMath {
    uint256 public baseRate;
    uint256 public slope;
    address public owner;

    function borrowRate(uint256 cash, uint256 borrows) external view returns (uint256) {
        if (borrows == 0) return baseRate;
        uint256 util = (borrows * 1e18) / (cash + borrows);
        return baseRate + (util * slope) / 1e18;
    }
}

contract RateModelRouter {
    uint256 public baseRate;
    uint256 public slope;
    address public owner;
    address public mathLib;

    event MathLibChanged(address indexed lib);

    constructor(address lib, uint256 base, uint256 slope_) {
        owner = msg.sender;
        mathLib = lib;
        baseRate = base;
        slope = slope_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    function setMathLib(address lib) external {
        require(lib.code.length > 0, "not a contract");
        mathLib = lib;
        emit MathLibChanged(lib);
    }

    function setParams(uint256 base, uint256 slope_) external onlyOwner {
        baseRate = base;
        slope = slope_;
    }

    function compute(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = mathLib.delegatecall(data);
        require(ok, "compute failed");
        return ret;
    }
}
