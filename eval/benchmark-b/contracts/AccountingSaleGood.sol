// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The matched secure variant of AccountingSaleBad: buy() credits msg.value / priceWei tokens, the correct amount
/// for a per-token price of priceWei. Structurally identical (same shape, same lack of external calls); only the
/// accounting is right. A detector that flags this buy() as vulnerable would be a false positive.
contract AccountingSaleGood {
    mapping(address => uint256) public balanceOf;
    uint256 public immutable priceWei; // wei per token
    uint256 public totalSold;

    constructor(uint256 _priceWei) {
        require(_priceWei > 0, "price");
        priceWei = _priceWei;
    }

    function buy() external payable {
        require(msg.value > 0, "no value");
        uint256 tokens = msg.value / priceWei;
        require(tokens > 0, "below unit price");
        balanceOf[msg.sender] += tokens;
        totalSold += tokens;
    }
}
