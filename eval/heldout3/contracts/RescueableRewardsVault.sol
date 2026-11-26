// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRewardToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title OwnedKeeper
/// @notice Owner plus an operational keeper. The keeper seat is claimed once by
///         the ops multisig during the deployment runbook.
abstract contract OwnedKeeper {
    address public owner;
    address public keeper;

    event KeeperSet(address indexed keeper);
    event OwnershipTransferred(address indexed from, address indexed to);

    error Unauthorized();
    error KeeperAlreadySet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner && msg.sender != keeper) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice One-time keeper bootstrap.
    function claimKeeper() external {
        if (keeper != address(0)) revert KeeperAlreadySet();
        keeper = msg.sender;
        emit KeeperSet(msg.sender);
    }

    function replaceKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }
}

/// @title RescueableRewardsVault
/// @notice Streams reward tokens to stakers; stray tokens can be rescued.
contract RescueableRewardsVault is OwnedKeeper {
    IRewardToken public immutable rewardToken;
    uint256 public rewardRate;
    uint64 public periodFinish;

    event RewardRateSet(uint256 rate, uint64 finish);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error CannotRescueRewardToken();
    error TransferFailed();

    constructor(IRewardToken token) {
        rewardToken = token;
    }

    function notifyRewardRate(uint256 rate, uint64 duration) external onlyOwnerOrKeeper {
        rewardRate = rate;
        periodFinish = uint64(block.timestamp) + duration;
        emit RewardRateSet(rate, periodFinish);
    }

    /// @notice Recover tokens sent to the vault by mistake.
    function rescueTokens(IRewardToken token, address to, uint256 amount) external onlyOwnerOrKeeper {
        if (address(token) == address(rewardToken)) revert CannotRescueRewardToken();
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Rescued(address(token), to, amount);
    }
}
