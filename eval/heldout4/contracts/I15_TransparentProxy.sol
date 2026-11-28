// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract ERC1967Storage {
    // keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // keccak256("eip1967.proxy.admin") - 1
    bytes32 internal constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    function _getImplementation() internal view returns (address impl) {
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    function _setImplementation(address newImplementation) internal {
        require(newImplementation.code.length > 0, "ERC1967: not a contract");
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
        emit Upgraded(newImplementation);
    }

    function _getAdmin() internal view returns (address adm) {
        bytes32 slot = _ADMIN_SLOT;
        assembly {
            adm := sload(slot)
        }
    }

    function _setAdmin(address newAdmin) internal {
        require(newAdmin != address(0), "ERC1967: zero admin");
        emit AdminChanged(_getAdmin(), newAdmin);
        bytes32 slot = _ADMIN_SLOT;
        assembly {
            sstore(slot, newAdmin)
        }
    }
}

contract TransparentProxy is ERC1967Storage {
    constructor(address logic, address admin_, bytes memory data) payable {
        _setAdmin(admin_);
        _setImplementation(logic);
        if (data.length > 0) {
            (bool ok, ) = logic.delegatecall(data);
            require(ok, "proxy: init failed");
        }
    }

    modifier ifAdmin() {
        if (msg.sender == _getAdmin()) {
            _;
        } else {
            _fallback();
        }
    }

    function admin() external ifAdmin returns (address) {
        return _getAdmin();
    }

    function implementation() external ifAdmin returns (address) {
        return _getImplementation();
    }

    function changeAdmin(address newAdmin) external ifAdmin {
        _setAdmin(newAdmin);
    }

    function upgradeTo(address newImplementation) external {
        _setImplementation(newImplementation);
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ifAdmin {
        _setImplementation(newImplementation);
        (bool ok, ) = newImplementation.delegatecall(data);
        require(ok, "proxy: call failed");
    }

    fallback() external payable {
        _fallback();
    }

    receive() external payable {
        _fallback();
    }

    function _fallback() internal {
        require(msg.sender != _getAdmin(), "proxy: admin cannot fallback");
        address impl = _getImplementation();
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

contract ProxyAdmin {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function upgrade(TransparentProxy proxy, address implementation) external {
        require(msg.sender == owner, "ProxyAdmin: not owner");
        proxy.upgradeTo(implementation);
    }
}
