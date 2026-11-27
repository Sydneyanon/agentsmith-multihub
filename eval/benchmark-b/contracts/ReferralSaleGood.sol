// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Matched secure variant of ReferralSaleBad: the discount applies only when the referrer is an existing customer
/// and is not the buyer. Structurally identical; only the referral condition differs. Flagging this buy is a false
/// positive.
contract ReferralSaleGood {
    uint256 public constant PRICE = 1 ether;
    mapping(address => uint256) public purchased;

    function buy(address referrer) external payable {
        uint256 price = PRICE;
        if (referrer != address(0) && referrer != msg.sender && purchased[referrer] > 0) price = (PRICE * 90) / 100;
        require(msg.value == price, "price");
        purchased[msg.sender] += 1;
    }
}
