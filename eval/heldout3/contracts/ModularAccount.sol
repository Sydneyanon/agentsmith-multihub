// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleRegistry
/// @notice Curated list of audited account modules maintained by the
///         ecosystem's security council.
contract ModuleRegistry {
    address public council;
    mapping(address => bool) public isApproved;

    event ModuleApproved(address indexed module, bool approved);

    error NotCouncil();

    constructor(address council_) {
        council = council_;
    }

    function setApproved(address module, bool approved) external {
        if (msg.sender != council) revert NotCouncil();
        isApproved[module] = approved;
        emit ModuleApproved(module, approved);
    }
}

/// @title AccountCore
abstract contract AccountCore {
    address public owner;
    uint256 public nonce;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
}

/// @title ModularAccount
/// @notice Smart account whose owner can run registry-approved modules in the
///         account's own context.
contract ModularAccount is AccountCore {
    ModuleRegistry public immutable registry;

    event ModuleRun(address indexed module, uint256 nonce);

    error ModuleNotApproved(address module);
    error ModuleReverted(bytes reason);

    constructor(ModuleRegistry registry_, address owner_) {
        registry = registry_;
        owner = owner_;
    }

    receive() external payable {}

    /// @notice Execute an approved module with the account's storage and balance.
    function runModule(address module, bytes calldata data) external onlyOwner returns (bytes memory) {
        if (!registry.isApproved(module)) revert ModuleNotApproved(module);
        nonce += 1;
        (bool ok, bytes memory ret) = module.delegatecall(data);
        if (!ok) revert ModuleReverted(ret);
        emit ModuleRun(module, nonce);
        return ret;
    }
}
