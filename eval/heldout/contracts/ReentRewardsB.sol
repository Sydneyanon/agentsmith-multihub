// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReentRewardsB {
    mapping(address => uint256) public pending;
    address public immutable distributor;
    uint256 private entered;

    event Claimed(address indexed user, uint256 amount);

    modifier exclusive() {
        require(entered == 0, "in progress");
        entered = 1;
        _;
        entered = 0;
    }

    constructor() {
        distributor = msg.sender;
    }

    function accrue(address user) external payable {
        pending[user] += msg.value;
    }

    function claim() external exclusive {
        uint256 reward = pending[msg.sender];
        require(reward > 0, "no reward");
        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "send failed");
        pending[msg.sender] = 0;
        emit Claimed(msg.sender, reward);
    }
}
