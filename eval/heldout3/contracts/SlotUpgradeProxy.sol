// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DepositLogicV1
/// @notice Deposit bookkeeping intended to run behind a proxy.
contract DepositLogicV1 {
    address public owner;
    uint256 public feeBps;
    mapping(address => uint256) public balanceOf;

    event Deposited(address indexed account, uint256 amount);

    error NotOwner();
    error AlreadyInitialized();

    function initialize(address owner_, uint256 feeBps_) external {
        if (owner != address(0)) revert AlreadyInitialized();
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

/// @title SlotUpgradeProxy
/// @notice Minimal upgradeable proxy managed by a single admin; proxy state is
///         kept in hashed slots away from the implementation's layout.
contract SlotUpgradeProxy {
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);

    error NotAdmin();

    constructor(address impl, bytes memory initData) {
        _store(IMPL_SLOT, impl);
        _store(ADMIN_SLOT, msg.sender);
        if (initData.length > 0) {
            (bool ok, ) = impl.delegatecall(initData);
            require(ok, "init failed");
        }
    }

    function upgradeTo(address newImplementation) external {
        if (msg.sender != _load(ADMIN_SLOT)) revert NotAdmin();
        _store(IMPL_SLOT, newImplementation);
        emit Upgraded(newImplementation);
    }

    fallback() external payable {
        _delegate(_load(IMPL_SLOT));
    }

    receive() external payable {
        _delegate(_load(IMPL_SLOT));
    }

    function _store(bytes32 slot, address value) private {
        assembly {
            sstore(slot, value)
        }
    }

    function _load(bytes32 slot) private view returns (address value) {
        assembly {
            value := sload(slot)
        }
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
