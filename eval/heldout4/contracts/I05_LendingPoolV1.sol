// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Initializable {
    uint8 private _initialized;
    bool private _initializing;

    event Initialized(uint8 version);

    modifier initializer() {
        bool isTopLevelCall = !_initializing;
        require(
            (isTopLevelCall && _initialized < 1) || (address(this).code.length == 0 && _initialized == 1),
            "Initializable: already initialized"
        );
        _initialized = 1;
        if (isTopLevelCall) {
            _initializing = true;
        }
        _;
        if (isTopLevelCall) {
            _initializing = false;
            emit Initialized(1);
        }
    }

    modifier reinitializer(uint8 version) {
        require(!_initializing && _initialized < version, "Initializable: already initialized");
        _initialized = version;
        _initializing = true;
        _;
        _initializing = false;
        emit Initialized(version);
    }

    modifier onlyInitializing() {
        require(_initializing, "Initializable: not initializing");
        _;
    }

    function _disableInitializers() internal virtual {
        require(!_initializing, "Initializable: initializing");
        if (_initialized != type(uint8).max) {
            _initialized = type(uint8).max;
            emit Initialized(type(uint8).max);
        }
    }

    function _getInitializedVersion() internal view returns (uint8) {
        return _initialized;
    }
}

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

abstract contract UUPSUpgradeable is Initializable, ERC1967Storage {
    address private immutable __self = address(this);

    modifier onlyProxy() {
        require(address(this) != __self, "UUPS: must be called through delegatecall");
        require(_getImplementation() == __self, "UUPS: not the active implementation");
        _;
    }

    function proxiableUUID() external pure returns (bytes32) {
        return _IMPLEMENTATION_SLOT;
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;

    function upgradeToAndCall(address newImplementation, bytes memory data) external payable {
        _authorizeUpgrade(newImplementation);
        _setImplementation(newImplementation);
        if (data.length > 0) {
            (bool ok, ) = newImplementation.delegatecall(data);
            require(ok, "UUPS: upgrade call failed");
        }
    }
}

abstract contract OwnableUpgradeable is Initializable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function __Ownable_init(address initialOwner) internal onlyInitializing {
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller is not the owner");
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Ownable: zero address");
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal {
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}

contract LendingPoolV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 public reserveFactorBps;
    mapping(address => uint256) public collateral;
    mapping(address => uint256) public debt;

    function initialize(address admin, uint256 reserveFactorBps_) external initializer {
        __Ownable_init(admin);
        reserveFactorBps = reserveFactorBps_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function supply() external payable {
        collateral[msg.sender] += msg.value;
    }

    function borrowLimit(address user) public view returns (uint256) {
        return (collateral[user] * 7_000) / 10_000;
    }

    function setReserveFactor(uint256 bps) external onlyOwner {
        require(bps <= 5_000, "too high");
        reserveFactorBps = bps;
    }
}
