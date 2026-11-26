// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AccessRegistry
/// @notice Protocol-wide registry of scoped administrators.
contract AccessRegistry {
    address public immutable root;
    mapping(bytes32 => mapping(address => bool)) public isAdmin;

    error NotRoot();

    constructor() {
        root = msg.sender;
    }

    function setAdmin(bytes32 scope, address account, bool enabled) external {
        if (msg.sender != root) revert NotRoot();
        isAdmin[scope][account] = enabled;
    }
}

/// @title RegistryClient
/// @notice Base for contracts whose admin functions are gated by the registry.
abstract contract RegistryClient {
    AccessRegistry public immutable registry;

    error NotRegistryAdmin(bytes32 scope);

    constructor(AccessRegistry registry_) {
        registry = registry_;
    }

    modifier onlyRegistryAdmin(bytes32 scope) {
        if (!registry.isAdmin(scope, tx.origin)) revert NotRegistryAdmin(scope);
        _;
    }
}

/// @title RateOracle
/// @notice Stores the protocol's borrow-rate curve parameters.
contract RateOracle is RegistryClient {
    bytes32 public constant RATES_SCOPE = keccak256("RATES");

    uint256 public baseRate;
    uint256 public slope;

    event RatesUpdated(uint256 baseRate, uint256 slope);

    constructor(AccessRegistry registry_) RegistryClient(registry_) {}

    function setRates(uint256 baseRate_, uint256 slope_) external onlyRegistryAdmin(RATES_SCOPE) {
        baseRate = baseRate_;
        slope = slope_;
        emit RatesUpdated(baseRate_, slope_);
    }

    function rateAt(uint256 utilisationWad) external view returns (uint256) {
        return baseRate + (slope * utilisationWad) / 1e18;
    }
}
