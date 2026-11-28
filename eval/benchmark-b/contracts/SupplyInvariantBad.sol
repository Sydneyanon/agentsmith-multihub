// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A minimal token whose protocol invariant is: sum of all balances == totalSupply, always. burn() breaks it: it
/// decrements the holder's balance but forgets to decrement totalSupply. After any burn, totalSupply overstates the
/// real circulating amount, which corrupts every downstream calculation that trusts totalSupply (price per share,
/// reward rates, collateral factors). No external call, no missing modifier, no overflow — the arithmetic is locally
/// consistent; only the cross-field invariant is violated. A structural detector has no notion of the invariant.
contract SupplyInvariantBad {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
        totalSupply = 1_000_000 ether;
    }

    function burn(uint256 amt) external {
        require(balanceOf[msg.sender] >= amt, "balance");
        // BUG (protocol-invariant): decrements the balance but not totalSupply, so sum(balances) != totalSupply.
        balanceOf[msg.sender] -= amt;
    }
}
