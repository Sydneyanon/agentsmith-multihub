// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReentRewardsA {
    mapping(address => uint256) public pending;
    address public immutable distributor;

    event Claimed(address indexed user, uint256 amount);

    constructor() {
        distributor = msg.sender;
    }

    function accrue(address user) external payable {
        pending[user] += msg.value;
    }

    function claim() external {
        uint256 reward = pending[msg.sender];
        require(reward > 0, "no reward");
        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "send failed");
        pending[msg.sender] = 0;
        emit Claimed(msg.sender, reward);
    }
}
