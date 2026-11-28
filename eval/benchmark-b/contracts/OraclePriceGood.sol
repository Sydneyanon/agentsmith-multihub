// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceSource {
    function spot() external view returns (uint256);
    function twap() external view returns (uint256);
    function lastUpdate() external view returns (uint256);
}

/// Matched secure variant of OraclePriceBad: values collateral from a time-weighted average price with a staleness
/// check, which a single-transaction spot manipulation cannot move. Structurally identical shape; only the price
/// source and the freshness guard differ. Flagging this borrowPower is a false positive.
contract OraclePriceGood {
    IPriceSource public immutable price;
    mapping(address => uint256) public collateral;

    constructor(IPriceSource _price) { price = _price; }

    function deposit(uint256 amount) external { collateral[msg.sender] += amount; }

    function borrowPower(address user) external view returns (uint256) {
        require(block.timestamp - price.lastUpdate() < 1 hours, "stale price");
        return collateral[user] * price.twap();
    }
}
