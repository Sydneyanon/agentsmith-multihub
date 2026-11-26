// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ScopedAccessRegistry
/// @notice Protocol-wide registry of scoped administrators.
contract ScopedAccessRegistry {
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

/// @title ScopedRegistryClient
/// @notice Base for contracts whose admin functions are gated by the registry.
abstract contract ScopedRegistryClient {
    ScopedAccessRegistry public immutable registry;

    error NotRegistryAdmin(bytes32 scope);

    constructor(ScopedAccessRegistry registry_) {
        registry = registry_;
    }

    modifier onlyRegistryAdmin(bytes32 scope) {
        if (!registry.isAdmin(scope, msg.sender)) revert NotRegistryAdmin(scope);
        _;
    }
}

/// @title BorrowRateOracle
/// @notice Stores the protocol's borrow-rate curve parameters.
contract BorrowRateOracle is ScopedRegistryClient {
    bytes32 public constant RATES_SCOPE = keccak256("RATES");

    uint256 public baseRate;
    uint256 public slope;

    event RatesUpdated(uint256 baseRate, uint256 slope);

    constructor(ScopedAccessRegistry registry_) ScopedRegistryClient(registry_) {}

    function setRates(uint256 baseRate_, uint256 slope_) external onlyRegistryAdmin(RATES_SCOPE) {
        baseRate = baseRate_;
        slope = slope_;
        emit RatesUpdated(baseRate_, slope_);
    }

    function rateAt(uint256 utilisationWad) external view returns (uint256) {
        return baseRate + (slope * utilisationWad) / 1e18;
    }
}
