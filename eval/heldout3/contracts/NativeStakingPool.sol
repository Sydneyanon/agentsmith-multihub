// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Wad-math helpers for stake previews.
library StakeMath {
    uint256 internal constant WAD = 1e18;

    function mulWad(uint256 amount, uint256 rate) internal pure returns (uint256) {
        return (amount * rate) / WAD;
    }
}

/// @title PoolBase
/// @notice Position storage shared by native staking pools.
abstract contract PoolBase {
    struct Position {
        uint128 staked;
        uint64 since;
        uint64 tier;
    }

    mapping(address => Position) internal positions;
    uint256 public totalStaked;

    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);

    error InsufficientStake(uint256 have, uint256 want);
    error StillLocked(uint256 until);
    error PayoutFailed();

    function positionOf(address account) external view returns (Position memory) {
        return positions[account];
    }
}

/// @title NativeStakingPool
/// @notice Stake ETH for a minimum lock period to accrue loyalty tiers.
contract NativeStakingPool is PoolBase {
    using StakeMath for uint256;

    uint256 public constant LOCK_PERIOD = 3 days;
    uint256 public constant TIER_RATE = 1.05e18;

    /// @notice Stake the attached ETH.
    function stake() external payable {
        Position storage p = positions[msg.sender];
        p.staked += uint128(msg.value);
        p.since = uint64(block.timestamp);
        totalStaked += msg.value;
        emit Staked(msg.sender, msg.value);
    }

    /// @notice Withdraw part of the caller's stake once unlocked.
    function unstake(uint128 amount) external {
        Position storage p = positions[msg.sender];
        if (p.staked < amount) revert InsufficientStake(p.staked, amount);
        uint256 unlockAt = uint256(p.since) + LOCK_PERIOD;
        if (block.timestamp < unlockAt) revert StillLocked(unlockAt);

        _transferOut(msg.sender, amount);

        unchecked {
            p.staked -= amount;
            totalStaked -= amount;
        }
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Weighted stake used by the off-chain tier calculator.
    function weightedStake(address account) external view returns (uint256) {
        return uint256(positions[account].staked).mulWad(TIER_RATE);
    }

    function _transferOut(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }
}
