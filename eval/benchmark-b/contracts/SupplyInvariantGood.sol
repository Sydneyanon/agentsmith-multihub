// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Matched secure variant of SupplyInvariantBad: burn() decrements both the holder's balance and totalSupply, so
/// the invariant sum(balances) == totalSupply holds after every operation. Structurally identical; only the missing
/// totalSupply update is restored. Flagging this burn is a false positive.
contract SupplyInvariantGood {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
        totalSupply = 1_000_000 ether;
    }

    function burn(uint256 amt) external {
        require(balanceOf[msg.sender] >= amt, "balance");
        balanceOf[msg.sender] -= amt;
        totalSupply -= amt;
    }
}
