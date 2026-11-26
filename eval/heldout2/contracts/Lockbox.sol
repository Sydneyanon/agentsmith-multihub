// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Latch {
    uint256 private _door = 1;

    modifier oneAtATime() {
        require(_door == 1, "busy");
        _door = 2;
        _;
        _door = 1;
    }
}

contract Lockbox is Latch {
    mapping(address => uint256) public shares;

    function deposit() external payable {
        shares[msg.sender] += msg.value;
    }

    function redeem() external {
        uint256 s = shares[msg.sender];
        (bool ok, ) = payable(msg.sender).call{value: s}("");
        require(ok, "xfer");
        shares[msg.sender] = 0;
    }

    function top(address who) external payable oneAtATime {
        shares[who] += msg.value;
    }
}
