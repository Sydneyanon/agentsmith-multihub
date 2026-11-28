// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VersionedInitializable
/// @notice Initializer bookkeeping for proxy-deployed logic contracts.
abstract contract VersionedInitializable {
    uint8 private _initVersion;
    bool private _initializing;

    event Initialized(uint8 version);

    error InvalidInitialization();
    error NotInitializing();

    modifier initializer() {
        _beginInit(1);
        _;
        _endInit(1);
    }

    modifier reinitializer(uint8 version) {
        _beginInit(version);
        _;
        _endInit(version);
    }

    modifier onlyInitializing() {
        if (!_initializing) revert NotInitializing();
        _;
    }

    function _beginInit(uint8 version) private {
        if (_initializing || _initVersion >= version) revert InvalidInitialization();
        _initVersion = version;
        _initializing = true;
    }

    function _endInit(uint8 version) private {
        _initializing = false;
        emit Initialized(version);
    }
}

/// @title StrategyRegistryUpgradeable
/// @notice Proxy-deployed registry of yield strategies that vaults may use.
contract StrategyRegistryUpgradeable is VersionedInitializable {
    address public owner;
    uint256 public maxStrategies;
    address[] internal _strategies;
    mapping(address => bool) public isRegistered;

    event OwnerSet(address indexed owner);
    event StrategyAdded(address indexed strategy);

    error NotOwner();
    error RegistryFull();
    error Duplicate();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Set up the registry behind its proxy.
    function initialize(address owner_, uint256 maxStrategies_) external {
        owner = owner_;
        maxStrategies = maxStrategies_;
        emit OwnerSet(owner_);
    }

    function addStrategy(address strategy) external onlyOwner {
        if (_strategies.length >= maxStrategies) revert RegistryFull();
        if (isRegistered[strategy]) revert Duplicate();
        isRegistered[strategy] = true;
        _strategies.push(strategy);
        emit StrategyAdded(strategy);
    }

    function strategies() external view returns (address[] memory) {
        return _strategies;
    }
}
