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

interface IBeacon {
    function implementation() external view returns (address);
}

contract UpgradeableBeacon is IBeacon {
    address private _implementation;
    address public owner;

    event Upgraded(address indexed implementation);

    constructor(address implementation_) {
        owner = msg.sender;
        _setImplementation(implementation_);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "beacon: not owner");
        _;
    }

    function implementation() external view override returns (address) {
        return _implementation;
    }

    function upgradeTo(address newImplementation) external {
        _setImplementation(newImplementation);
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }

    function _setImplementation(address newImplementation) private {
        require(newImplementation.code.length > 0, "beacon: not a contract");
        _implementation = newImplementation;
        emit Upgraded(newImplementation);
    }
}

contract BeaconProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1)
    bytes32 private constant _BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    constructor(address beacon, bytes memory data) payable {
        bytes32 slot = _BEACON_SLOT;
        assembly {
            sstore(slot, beacon)
        }
        if (data.length > 0) {
            (bool ok, ) = IBeacon(beacon).implementation().delegatecall(data);
            require(ok, "BeaconProxy: init failed");
        }
    }

    fallback() external payable {
        bytes32 slot = _BEACON_SLOT;
        address beacon;
        assembly {
            beacon := sload(slot)
        }
        address impl = IBeacon(beacon).implementation();
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

contract CreatorVault is Initializable, OwnableUpgradeable {
    string public handle;
    uint256 public subscriptionPrice;
    mapping(address => uint64) public subscribedUntil;

    constructor() {
        _disableInitializers();
    }

    function initialize(address creator, string calldata handle_, uint256 price) external initializer {
        __Ownable_init(creator);
        handle = handle_;
        subscriptionPrice = price;
    }

    function subscribe() external payable {
        require(msg.value == subscriptionPrice, "price");
        uint64 base = subscribedUntil[msg.sender] > block.timestamp ? subscribedUntil[msg.sender] : uint64(block.timestamp);
        subscribedUntil[msg.sender] = base + 30 days;
    }

    function collect(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "collect failed");
    }
}

contract CreatorVaultFactory {
    UpgradeableBeacon public immutable beacon;
    address[] public vaults;

    event VaultCreated(address indexed creator, address vault);

    constructor(address implementation) {
        beacon = new UpgradeableBeacon(implementation);
        beacon.transferOwnership(msg.sender);
    }

    function create(string calldata handle, uint256 price) external returns (address vault) {
        vault = address(
            new BeaconProxy(
                address(beacon),
                abi.encodeCall(CreatorVault.initialize, (msg.sender, handle, price))
            )
        );
        vaults.push(vault);
        emit VaultCreated(msg.sender, vault);
    }
}
