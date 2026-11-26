// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC1967Slots
/// @notice Reads and writes the standard proxy storage slots.
abstract contract ERC1967Slots {
    /// @dev keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    /// @dev keccak256("eip1967.proxy.admin") - 1
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    function _implementation() internal view returns (address impl) {
        bytes32 slot = IMPL_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    function _admin() internal view returns (address adm) {
        bytes32 slot = ADMIN_SLOT;
        assembly {
            adm := sload(slot)
        }
    }

    function _setImplementation(address impl) internal {
        bytes32 slot = IMPL_SLOT;
        assembly {
            sstore(slot, impl)
        }
        emit Upgraded(impl);
    }

    function _setAdmin(address adm) internal {
        emit AdminChanged(_admin(), adm);
        bytes32 slot = ADMIN_SLOT;
        assembly {
            sstore(slot, adm)
        }
    }
}

/// @title AdminSlotProxy
/// @notice Transparent-style proxy: the admin manages upgrades, everyone else
///         is forwarded to the implementation.
contract AdminSlotProxy is ERC1967Slots {
    error InitCallFailed();

    constructor(address impl, address admin_, bytes memory data) payable {
        _setImplementation(impl);
        _setAdmin(admin_);
        if (data.length > 0) {
            (bool ok, ) = impl.delegatecall(data);
            if (!ok) revert InitCallFailed();
        }
    }

    modifier ifAdmin() {
        if (msg.sender == _admin()) {
            _;
        } else {
            _fallback();
        }
    }

    function upgradeTo(address newImplementation) external ifAdmin {
        _setImplementation(newImplementation);
    }

    function changeAdmin(address newAdmin) external {
        _setAdmin(newAdmin);
    }

    function admin() external ifAdmin returns (address) {
        return _admin();
    }

    fallback() external payable {
        _fallback();
    }

    receive() external payable {
        _fallback();
    }

    function _fallback() internal {
        _delegate(_implementation());
    }

    function _delegate(address impl) internal {
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
