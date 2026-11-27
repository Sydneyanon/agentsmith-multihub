// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/PayoutSplitter.sol";
import "../src/IERC20.sol";
import "./Helpers.sol";

contract PayoutSplitterTest {
    // Issue 4: distribute() reverts entirely if transfer to ANY recipient fails,
    // so one bad recipient blocks all payouts and the funds stay locked forever
    // (the contract has no owner withdraw or escape hatch).
    function test_oneFailingRecipientLocksAllFunds() external {
        address alice = address(0xA11CE);
        address bob = address(0xB0B);
        address carol = address(0xCAC0);

        address[] memory rec = new address[](3);
        rec[0] = alice; rec[1] = bob; rec[2] = carol;
        uint256[] memory sh = new uint256[](3);
        sh[0] = 3_000; sh[1] = 4_000; sh[2] = 3_000; // sums to 10000

        // Token where transfer to bob always fails (returns false => require trips).
        BlockingERC20 token = new BlockingERC20("BLK", bob, false);

        PayoutSplitter splitter = new PayoutSplitter(IERC20(address(token)), rec, sh);
        token.mint(address(splitter), 1_000e18);

        // distribute() must revert because bob's leg fails.
        (bool ok,) = address(splitter).call(abi.encodeWithSignature("distribute()"));
        require(!ok, "distribute should have reverted");

        // No one received anything, despite alice's leg being first in the loop:
        // the revert rolls back the whole transaction.
        require(token.balanceOf(alice) == 0, "alice should get nothing");
        require(token.balanceOf(bob) == 0, "bob nothing");
        require(token.balanceOf(carol) == 0, "carol nothing");

        // Funds remain locked in the splitter.
        require(token.balanceOf(address(splitter)) == 1_000e18, "funds not locked");

        // There is NO other action that frees them: distribute() is the only state-changing
        // external function, and it keeps reverting while bob is blocked.
        (bool ok2,) = address(splitter).call(abi.encodeWithSignature("distribute()"));
        require(!ok2, "still blocked");
        require(token.balanceOf(address(splitter)) == 1_000e18, "still locked after retry");

        // IMPACT: 1000e18 tokens are permanently stuck; alice (owed 300e18) and
        // carol (owed 300e18) can never be paid as long as bob's transfer fails.
    }

    // Control: with a healthy token the same distribution succeeds, proving the
    // block above is caused by the failing recipient, not by setup.
    function test_controlHealthyTokenDistributes() external {
        address alice = address(0xA11CE);
        address bob = address(0xB0B);
        address carol = address(0xCAC0);
        address[] memory rec = new address[](3);
        rec[0] = alice; rec[1] = bob; rec[2] = carol;
        uint256[] memory sh = new uint256[](3);
        sh[0] = 3_000; sh[1] = 4_000; sh[2] = 3_000;

        MockERC20 token = new MockERC20("OK");
        PayoutSplitter splitter = new PayoutSplitter(IERC20(address(token)), rec, sh);
        token.mint(address(splitter), 1_000e18);

        splitter.distribute();
        require(token.balanceOf(alice) == 300e18, "alice paid");
        require(token.balanceOf(bob) == 400e18, "bob paid");
        require(token.balanceOf(carol) == 300e18, "carol paid");
        require(token.balanceOf(address(splitter)) == 0, "splitter emptied");
    }
}
