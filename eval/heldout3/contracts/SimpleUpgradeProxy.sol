// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VaultLogicV1
/// @notice Deposit bookkeeping intended to run behind a proxy.
contract VaultLogicV1 {
    address public owner;
    uint256 public feeBps;
    bool private _initialized;
    mapping(address => uint256) public balanceOf;

    event Deposited(address indexed account, uint256 amount);

    error NotOwner();
    error AlreadyInitialized();

    function initialize(address owner_, uint256 feeBps_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        owner = owner_;
        feeBps = feeBps_;
    }

    function setFee(uint256 feeBps_) external {
        if (msg.sender != owner) revert NotOwner();
        feeBps = feeBps_;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}

/// @title SimpleUpgradeProxy
/// @notice Minimal upgradeable proxy managed by a single admin.
contract SimpleUpgradeProxy {
    address public implementation;
    address public proxyAdmin;

    event Upgraded(address indexed implementation);

    error NotAdmin();

    constructor(address impl) {
        implementation = impl;
        proxyAdmin = msg.sender;
    }

    function upgradeTo(address newImplementation) external {
        if (msg.sender != proxyAdmin) revert NotAdmin();
        implementation = newImplementation;
        emit Upgraded(newImplementation);
    }

    fallback() external payable {
        _delegate(implementation);
    }

    receive() external payable {
        _delegate(implementation);
    }

    function _delegate(address impl) private {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
