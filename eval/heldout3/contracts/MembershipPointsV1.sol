// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MembershipInitializable
abstract contract MembershipInitializable {
    bool private _initialized;
    bool internal _initializing;

    error AlreadyInitialized();
    error NotInitializing();

    modifier initializer() {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _initializing = true;
        _;
        _initializing = false;
    }

    modifier onlyInitializing() {
        if (!_initializing) revert NotInitializing();
        _;
    }
}

/// @title OwnableUpgradeableLite
/// @notice Ownership for proxy-deployed contracts.
abstract contract OwnableUpgradeableLite is MembershipInitializable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function __Ownable_init(address initialOwner) internal onlyInitializing {
        emit OwnershipTransferred(owner, initialOwner);
        owner = initialOwner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

/// @title PausableUpgradeableLite
abstract contract PausableUpgradeableLite is OwnableUpgradeableLite {
    bool public paused;

    error IsPaused();

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    function __Pausable_init() internal onlyInitializing {
        paused = false;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }
}

/// @title MembershipPointsV1
/// @notice Non-transferable membership balances issued by the owner.
contract MembershipPointsV1 is PausableUpgradeableLite {
    mapping(address => uint256) public pointsOf;

    event Issued(address indexed account, uint256 amount);

    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
        __Pausable_init();
    }

    function issue(address account, uint256 amount) external onlyOwner whenNotPaused {
        pointsOf[account] += amount;
        emit Issued(account, amount);
    }
}
