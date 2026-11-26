// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DistributionBook
/// @notice Static payee list with share weights.
abstract contract DistributionBook {
    address[] internal _payees;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public released;
    mapping(address => uint256) public owed;
    uint256 public totalShares;
    uint256 public totalReleased;
    uint256 public totalOwed;

    error NoPayees();
    error LengthMismatch();
    error NothingOwed();
    error SendFailed();

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
        uint256 totalReceived = address(this).balance - totalOwed + totalReleased;
        return (totalReceived * sharesOf[payee]) / totalShares - released[payee];
    }
}

/// @title RevenueDistributor
/// @notice Collects protocol revenue and pushes it to payees pro rata; a payee
///         that cannot receive is credited and can pull later.
contract RevenueDistributor is DistributionBook {
    event PaymentReleased(address indexed payee, uint256 amount);
    event PaymentDeferred(address indexed payee, uint256 amount);

    constructor(address[] memory payees, uint256[] memory shares) DistributionBook(payees, shares) {}

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
            (bool ok, ) = payable(payee).call{value: amount, gas: 30_000}("");
            if (ok) {
                emit PaymentReleased(payee, amount);
            } else {
                owed[payee] += amount;
                totalOwed += amount;
                emit PaymentDeferred(payee, amount);
            }
        }
    }

    /// @notice Pull a previously deferred payment.
    function claimOwed() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
