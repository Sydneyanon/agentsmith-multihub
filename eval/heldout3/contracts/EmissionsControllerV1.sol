// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EmissionsInitGuard
abstract contract EmissionsInitGuard {
    bool private _initialized;

    error AlreadyInitialized();

    modifier initializer() {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _;
    }

    function _lockInitializers() internal {
        _initialized = true;
    }
}

/// @title ProxiableLite
/// @notice Upgrade logic living in the implementation (EIP-1822 style).
abstract contract ProxiableLite {
    /// @dev keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address private immutable __self = address(this);

    event Upgraded(address indexed implementation);

    error NotDelegated();
    error UpgradeCallFailed();

    modifier onlyProxy() {
        if (address(this) == __self) revert NotDelegated();
        _;
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable onlyProxy {
        _authorizeUpgrade(newImplementation);
        _setImplementation(newImplementation);
        if (data.length > 0) {
            (bool ok, ) = newImplementation.delegatecall(data);
            if (!ok) revert UpgradeCallFailed();
        }
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;

    function _setImplementation(address newImplementation) private {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
        emit Upgraded(newImplementation);
    }
}

/// @title EmissionsControllerV1
/// @notice Emission schedule controller deployed behind an ERC1967 proxy.
contract EmissionsControllerV1 is EmissionsInitGuard, ProxiableLite {
    address public owner;
    uint256 public emissionPerSecond;

    event EmissionUpdated(uint256 perSecond);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _lockInitializers();
    }

    function initialize(address owner_, uint256 emission_) external initializer {
        owner = owner_;
        emissionPerSecond = emission_;
    }

    function setEmission(uint256 perSecond) external onlyOwner {
        emissionPerSecond = perSecond;
        emit EmissionUpdated(perSecond);
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
