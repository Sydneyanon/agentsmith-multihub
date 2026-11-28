// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A sale with a referral discount. The business rule: a buyer gets 10% off only when referred by an existing
/// customer other than themselves. buy() grants the discount for ANY non-zero referrer, including the buyer's own
/// address or an address that never bought, so every buyer can always pay 90% by naming any address. Pure
/// business-logic defect: no external call, every write is keyed by the caller, the arithmetic is correct.
contract ReferralSaleBad {
    uint256 public constant PRICE = 1 ether;
    mapping(address => uint256) public purchased;

    function buy(address referrer) external payable {
        uint256 price = PRICE;
        // BUG (business-logic): any non-zero referrer earns the discount, including self and non-customers.
        if (referrer != address(0)) price = (PRICE * 90) / 100;
        require(msg.value == price, "price");
        purchased[msg.sender] += 1;
    }
}
