// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Dispenser {
    mapping(address => uint256) public funds;
    mapping(address => bool) public claimed;
    uint256 public taken;
    uint256 public immutable cap;
    uint256 public reward = 1 ether;

    constructor(uint256 c) payable {
        cap = c;
    }

    function put() external payable {
        funds[msg.sender] += msg.value;
    }

    function pull(uint256 amt) external {
        uint256 b = funds[msg.sender];
        require(b >= amt, "low");
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "xfer");
        unchecked {
            funds[msg.sender] = b - amt;
        }
    }

    function pullChecked(uint256 amt) external {
        require(funds[msg.sender] >= amt, "low");
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "xfer");
        funds[msg.sender] -= amt;
    }

    function claim() external {
        require(!claimed[msg.sender], "done");
        (bool ok, ) = msg.sender.call{value: reward}("");
        require(ok, "xfer");
        claimed[msg.sender] = true;
    }

    function claimEarly() external {
        require(!claimed[msg.sender], "done");
        claimed[msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: reward}("");
        require(ok, "xfer");
    }

    function drip(uint256 n) external {
        require(taken + n <= cap, "cap");
        (bool ok, ) = msg.sender.call{value: n}("");
        require(ok, "xfer");
        taken += n;
    }
}
