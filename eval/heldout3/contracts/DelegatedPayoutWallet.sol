// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WalletOwner
abstract contract WalletOwner {
    address public immutable owner;

    error Unauthorized();

    constructor(address owner_) {
        owner = owner_;
    }

    function _checkOwner() internal view virtual;
}

/// @title DelegatedPayoutWallet
/// @notice Owner wallet that also lets the owner trigger payouts through
///         helper contracts (batchers, schedulers) in the same transaction.
contract DelegatedPayoutWallet is WalletOwner {
    event Paid(address indexed to, uint256 amount);

    error SendFailed();

    constructor(address owner_) WalletOwner(owner_) {}

    receive() external payable {}

    function pay(address payable to, uint256 amount) external {
        _checkOwner();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Paid(to, amount);
    }

    function _checkOwner() internal view override {
        if (tx.origin != owner) revert Unauthorized();
    }
}
