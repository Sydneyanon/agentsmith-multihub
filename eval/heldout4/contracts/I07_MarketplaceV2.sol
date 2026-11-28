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

contract MarketplaceV1 is Initializable, OwnableUpgradeable {
    uint256 public listingFee;
    mapping(uint256 => address) public sellerOf;
    mapping(uint256 => uint256) public priceOf;
    uint256 public nextListing;

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, uint256 fee) external initializer {
        __Ownable_init(admin);
        listingFee = fee;
    }

    function list(uint256 price) external payable returns (uint256 id) {
        require(msg.value == listingFee, "fee");
        id = nextListing++;
        sellerOf[id] = msg.sender;
        priceOf[id] = price;
    }
}

contract MarketplaceV2 is MarketplaceV1 {
    address public feeRecipient;
    uint256 public protocolCutBps;

    function initializeV2(address feeRecipient_, uint256 cutBps) external reinitializer(2) {
        require(cutBps <= 1_000, "cut");
        feeRecipient = feeRecipient_;
        protocolCutBps = cutBps;
    }

    function sweepFees() external {
        (bool ok, ) = feeRecipient.call{value: address(this).balance}("");
        require(ok, "sweep failed");
    }
}
