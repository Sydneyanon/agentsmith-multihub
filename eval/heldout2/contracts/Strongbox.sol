// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Base latch. Words such as call, delegatecall and onlyOwner here are prose only.
abstract contract Latch {
    uint256 private _door = 1;

    modifier oneAtATime() {
        require(_door == 1, "busy");
        _door = 2;
        _;
        _door = 1;
    }
}

contract Strongbox is Latch {
    mapping(address => uint256) public shares;

    function deposit() external payable {
        shares[msg.sender] += msg.value;
    }

    function redeem() external oneAtATime {
        uint256 s = shares[msg.sender];
        (bool ok, ) = payable(msg.sender).call{value: s}("");
        require(ok, "xfer");
        shares[msg.sender] = 0;
    }

    function redeemTo(address to) external oneAtATime {
        uint256 s = shares[msg.sender];
        require(s > 0, "none");
        (bool ok, ) = payable(to).call{value: s}("");
        require(ok, "xfer");
        shares[msg.sender] = 0;
    }
}
