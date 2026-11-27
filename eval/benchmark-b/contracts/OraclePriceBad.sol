// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceSource {
    function spot() external view returns (uint256);        // instantaneous AMM spot price, manipulable in one tx
    function twap() external view returns (uint256);        // time-weighted average price
    function lastUpdate() external view returns (uint256);  // timestamp of the twap observation
}

/// Collateral is valued from a single instantaneous spot price. An attacker can move the spot within one
/// transaction (flash-loan the pool), borrow against the inflated collateral, and leave the protocol undercollateralised.
/// The defect is the choice of price source, not any syntactic pattern: the call is a view, there is no reentrancy,
/// no missing modifier. A structural detector sees nothing wrong.
contract OraclePriceBad {
    IPriceSource public immutable price;
    mapping(address => uint256) public collateral;

    constructor(IPriceSource _price) { price = _price; }

    function deposit(uint256 amount) external { collateral[msg.sender] += amount; }

    function borrowPower(address user) external view returns (uint256) {
        // BUG (oracle-manipulation): values collateral at the manipulable spot price.
        return collateral[user] * price.spot();
    }
}
