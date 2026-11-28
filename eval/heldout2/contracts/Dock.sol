// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Keeper {
    address internal keeper;

    modifier onlyKeeper() {
        require(msg.sender == keeper, "keeper");
        _;
    }

    constructor() {
        keeper = msg.sender;
    }
}

contract Dock is Keeper {
    uint256 public rate;
    address public sink;

    function setRate(uint256 r) external onlyKeeper {
        rate = r;
    }

    function setSink(address s) external {
        sink = s;
    }
}
