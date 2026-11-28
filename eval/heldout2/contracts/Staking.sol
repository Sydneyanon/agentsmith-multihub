// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Once {
    bool private _done;

    modifier first() {
        require(!_done, "already");
        _done = true;
        _;
    }
}

contract Staking is Once {
    address public admin;
    address public rewardToken;
    uint256 public rate;

    function setup(address a, address t) external first {
        admin = a;
        rewardToken = t;
    }

    function reconfigure(address a, address t) external {
        admin = a;
        rewardToken = t;
    }
}
