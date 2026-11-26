// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title OracleInitializable
abstract contract OracleInitializable {
    bool private _initialized;

    error AlreadyInitialized();

    modifier initializer() {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _;
    }

    function _disableInitializers() internal {
        _initialized = true;
    }
}

/// @title OracleSlotUpgradeable
/// @notice UUPS-style upgrade entry point; the implementation pointer lives in
///         the ERC1967 slot of whichever contract executes this code.
abstract contract OracleSlotUpgradeable {
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    event Upgraded(address indexed implementation);

    error UpgradeCallFailed();

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable {
        _authorizeUpgrade(newImplementation);
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
        emit Upgraded(newImplementation);
        if (data.length > 0) {
            (bool ok, ) = newImplementation.delegatecall(data);
            if (!ok) revert UpgradeCallFailed();
        }
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;
}

/// @title OracleAdapterV1
/// @notice Normalises an external oracle answer to 18 decimals; deployed once
///         as an implementation and shared by many proxies.
contract OracleAdapterV1 is OracleInitializable, OracleSlotUpgradeable {
    address public owner;
    address public source;
    uint8 public sourceDecimals;

    event SourceUpdated(address indexed source, uint8 decimals);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address source_, uint8 decimals_) external initializer {
        owner = owner_;
        source = source_;
        sourceDecimals = decimals_;
        emit SourceUpdated(source_, decimals_);
    }

    function setSource(address source_, uint8 decimals_) external onlyOwner {
        source = source_;
        sourceDecimals = decimals_;
        emit SourceUpdated(source_, decimals_);
    }

    function scale(int256 answer) external view returns (int256) {
        if (sourceDecimals < 18) {
            return answer * int256(10 ** (18 - sourceDecimals));
        }
        return answer / int256(10 ** (sourceDecimals - 18));
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
