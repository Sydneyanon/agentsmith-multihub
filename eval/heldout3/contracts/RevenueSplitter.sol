// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PayeeBook
/// @notice Static payee list with share weights.
abstract contract PayeeBook {
    address[] internal _payees;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public released;
    uint256 public totalShares;
    uint256 public totalReleased;

    error NoPayees();
    error LengthMismatch();

    constructor(address[] memory payees, uint256[] memory shares) {
        if (payees.length == 0) revert NoPayees();
        if (payees.length != shares.length) revert LengthMismatch();
        for (uint256 i = 0; i < payees.length; ++i) {
            _payees.push(payees[i]);
            sharesOf[payees[i]] = shares[i];
            totalShares += shares[i];
        }
    }

    function _pendingOf(address payee) internal view returns (uint256) {
        uint256 totalReceived = address(this).balance + totalReleased;
        return (totalReceived * sharesOf[payee]) / totalShares - released[payee];
    }
}

/// @title RevenueSplitter
/// @notice Collects protocol revenue and pushes it to payees pro rata.
contract RevenueSplitter is PayeeBook {
    event PaymentReleased(address indexed payee, uint256 amount);

    constructor(address[] memory payees, uint256[] memory shares) PayeeBook(payees, shares) {}

    receive() external payable {}

    /// @notice Push every payee's pending share.
    function distribute() external {
        uint256 count = _payees.length;
        uint256[] memory amounts = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            amounts[i] = _pendingOf(_payees[i]);
        }
        for (uint256 i = 0; i < count; ++i) {
            address payee = _payees[i];
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            released[payee] += amount;
            totalReleased += amount;
            payable(payee).call{value: amount}("");
            emit PaymentReleased(payee, amount);
        }
    }
}
