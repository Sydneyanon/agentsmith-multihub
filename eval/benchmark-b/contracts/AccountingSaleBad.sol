// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A fixed-price token sale with an accounting bug: buy() divides where it must multiply, so a buyer who sends
/// `priceWei` ether is credited `tokensPerWei / 1` ... no — it credits `msg.value / priceWei` as if priceWei were
/// a per-token divisor, but priceWei is the price of ONE token in wei. The correct amount is msg.value / priceWei
/// tokens; the bug multiplies by priceWei instead, minting far more than paid for. No external calls, no reentrancy:
/// the only defect is the arithmetic that governs how much value the buyer receives.
contract AccountingSaleBad {
    mapping(address => uint256) public balanceOf;
    uint256 public immutable priceWei; // wei per token
    uint256 public totalSold;

    constructor(uint256 _priceWei) {
        priceWei = _priceWei;
    }

    function buy() external payable {
        require(msg.value > 0, "no value");
        // BUG (accounting-error): credits msg.value * priceWei tokens. For priceWei > 1 this mints vastly more
        // tokens than the buyer paid for; the sale leaks value on every purchase.
        uint256 tokens = msg.value * priceWei;
        balanceOf[msg.sender] += tokens;
        totalSold += tokens;
    }
}
