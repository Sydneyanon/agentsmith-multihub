// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VaultOwnable
abstract contract VaultOwnable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

/// @title LegacyFeeVault
/// @notice First-generation fee vault kept alive until the migration to the
///         new router completes; can be decommissioned afterwards.
contract LegacyFeeVault is VaultOwnable {
    uint256 public collected;

    event FeeReceived(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Decommissioned(address indexed beneficiary, uint256 balance);

    error SendFailed();

    receive() external payable {
        collected += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Withdrawn(to, amount);
    }

    /// @notice Retire the vault and forward any remaining balance.
    function decommission(address payable beneficiary) external {
        emit Decommissioned(beneficiary, address(this).balance);
        selfdestruct(beneficiary);
    }
}
