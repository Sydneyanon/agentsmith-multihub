// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PrepaidCreditLedger
/// @notice Users top up ETH credit that metered services draw down off-chain;
///         unused credit can be withdrawn at any time.
contract PrepaidCreditLedger {
    mapping(address => uint256) public creditOf;

    event ToppedUp(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error InsufficientCredit(uint256 available, uint256 requested);
    error WithdrawFailed();

    /// @notice Add the attached ETH to the caller's credit.
    function topUp() external payable {
        creditOf[msg.sender] += msg.value;
        emit ToppedUp(msg.sender, msg.value);
    }

    /// @notice Withdraw unused credit.
    function withdraw(uint256 amount) external {
        uint256 available = creditOf[msg.sender];
        if (available < amount) revert InsufficientCredit(available, amount);

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();

        creditOf[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);
    }
}
