// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/// @notice Stake a token, earn a reward token streamed at a fixed rate.
contract RewardPool {
    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    address public owner;
    uint256 public rewardRate;            // reward per second for the whole pool
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;  // scaled by 1e18
    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    constructor(IERC20 s, IERC20 r) { stakeToken = s; rewardToken = r; owner = msg.sender; lastUpdate = block.timestamp; }

    function setRewardRate(uint256 rate) external onlyOwner {
        _updatePool();
        rewardRate = rate;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (block.timestamp - lastUpdate) * rewardRate * 1e18 / totalStaked;
    }

    function earned(address a) public view returns (uint256) {
        return staked[a] * (rewardPerToken() - userRewardPerTokenPaid[a]) / 1e18 + rewards[a];
    }

    function _updatePool() internal {
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = block.timestamp;
    }

    function _updateUser(address a) internal {
        _updatePool();
        rewards[a] = earned(a);
        userRewardPerTokenPaid[a] = rewardPerTokenStored;
    }

    function stake(uint256 amount) external {
        _updatePool();
        require(stakeToken.transferFrom(msg.sender, address(this), amount), "transfer");
        staked[msg.sender] += amount;
        totalStaked += amount;
    }

    function withdraw(uint256 amount) external {
        _updateUser(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        require(stakeToken.transfer(msg.sender, amount), "transfer");
    }

    function claim() external {
        _updateUser(msg.sender);
        uint256 r = rewards[msg.sender];
        rewards[msg.sender] = 0;
        require(rewardToken.transfer(msg.sender, r), "transfer");
    }
}
