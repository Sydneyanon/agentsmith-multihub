// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LoyaltyInitializable
abstract contract LoyaltyInitializable {
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

/// @title OwnableInit
/// @notice Ownership for proxy-deployed contracts.
abstract contract OwnableInit is LoyaltyInitializable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function __Ownable_init(address initialOwner) public {
        emit OwnershipTransferred(owner, initialOwner);
        owner = initialOwner;
    }
}

/// @title PausableInit
abstract contract PausableInit is OwnableInit {
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

/// @title LoyaltyPointsV1
/// @notice Non-transferable loyalty balances issued by the owner.
contract LoyaltyPointsV1 is PausableInit {
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
