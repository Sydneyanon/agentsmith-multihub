import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'contracts')
HDR = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\n"

INITIALIZABLE = r'''abstract contract Initializable {
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
'''

OWNABLE_UP = r'''abstract contract OwnableUpgradeable is Initializable {
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
'''

IERC20 = r'''interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
'''

ERC1967_STORAGE = r'''abstract contract ERC1967Storage {
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
'''

ERC1967_PROXY = r'''contract ERC1967Proxy is ERC1967Storage {
    constructor(address implementation, bytes memory data) payable {
        _setImplementation(implementation);
        if (data.length > 0) {
            (bool ok, bytes memory ret) = implementation.delegatecall(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    fallback() external payable {
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

    receive() external payable {}
}
'''

def uups(only_proxy=True):
    guard = " onlyProxy" if only_proxy else ""
    return r'''abstract contract UUPSUpgradeable is Initializable, ERC1967Storage {
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

    function upgradeToAndCall(address newImplementation, bytes memory data) external payable''' + guard + r''' {
        _authorizeUpgrade(newImplementation);
        _setImplementation(newImplementation);
        if (data.length > 0) {
            (bool ok, ) = newImplementation.delegatecall(data);
            require(ok, "UUPS: upgrade call failed");
        }
    }
}
'''

def write(name, body):
    with open(os.path.join(OUT, name), 'w') as f:
        f.write(HDR + body)

# ---------- I01 / I02 : vault initialize with / without initializer modifier
def vault(mod):
    return INITIALIZABLE + "\n" + IERC20 + "\n" + r'''abstract contract PausableUpgradeable is Initializable {
    bool private _paused;
    address internal _pauser;

    event Paused(address account);
    event Unpaused(address account);

    function __Pausable_init(address pauser) internal onlyInitializing {
        _paused = false;
        _pauser = pauser;
    }

    modifier whenNotPaused() {
        require(!_paused, "Pausable: paused");
        _;
    }

    function pause() external {
        require(msg.sender == _pauser, "Pausable: not pauser");
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        require(msg.sender == _pauser, "Pausable: not pauser");
        _paused = false;
        emit Unpaused(msg.sender);
    }
}

contract YieldVault is PausableUpgradeable {
    IERC20 public asset;
    address public manager;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposited(address indexed account, uint256 assets, uint256 shares);
    event Redeemed(address indexed account, uint256 assets, uint256 shares);
    event ManagerSweep(address indexed to, uint256 amount);

    function initialize(IERC20 asset_, address manager_) external''' + mod + r''' {
        __Pausable_init(manager_);
        asset = asset_;
        manager = manager_;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function deposit(uint256 assets) external whenNotPaused returns (uint256 shares) {
        uint256 supply = totalShares;
        shares = supply == 0 ? assets : (assets * supply) / totalAssets();
        require(asset.transferFrom(msg.sender, address(this), assets), "transferFrom");
        totalShares = supply + shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, assets, shares);
    }

    function redeem(uint256 shares) external whenNotPaused returns (uint256 assets) {
        assets = (shares * totalAssets()) / totalShares;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        require(asset.transfer(msg.sender, assets), "transfer");
        emit Redeemed(msg.sender, assets, shares);
    }

    function emergencySweep(address to) external {
        require(msg.sender == manager, "manager");
        uint256 bal = totalAssets();
        require(asset.transfer(to, bal), "transfer");
        emit ManagerSweep(to, bal);
    }
}
'''
write("I01_YieldVault.sol", vault(""))
write("I02_YieldVault.sol", vault(" initializer"))

# ---------- I03 / I04 : inherited init function visibility
def rewards(init_sig):
    own = OWNABLE_UP.replace(
        "    function __Ownable_init(address initialOwner) internal onlyInitializing {",
        "    function __Ownable_init(address initialOwner) " + init_sig + " {")
    return INITIALIZABLE + "\n" + own + "\n" + r'''contract RewardsVault is Initializable, OwnableUpgradeable {
    uint256 public epochLength;
    uint256 public currentEpoch;
    mapping(uint256 => uint256) public epochBudget;

    event BudgetSet(uint256 indexed epoch, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    function initialize(address admin, uint256 epochLength_) external initializer {
        __Ownable_init(admin);
        epochLength = epochLength_;
    }

    receive() external payable {}

    function setBudget(uint256 epoch, uint256 amount) external onlyOwner {
        epochBudget[epoch] = amount;
        emit BudgetSet(epoch, amount);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount);
    }
}
'''
write("I03_RewardsVault.sol", rewards("public"))
write("I04_RewardsVault.sol", rewards("internal onlyInitializing"))

# ---------- I05 / I06 : UUPS implementation left initialisable (upgradeToAndCall callable on impl)
def lending(ctor):
    return INITIALIZABLE + "\n" + ERC1967_STORAGE + "\n" + uups(only_proxy=False) + "\n" + OWNABLE_UP + "\n" + r'''contract LendingPoolV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 public reserveFactorBps;
    mapping(address => uint256) public collateral;
    mapping(address => uint256) public debt;
''' + ctor + r'''
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
'''
write("I05_LendingPoolV1.sol", lending(""))
write("I06_LendingPoolV1.sol", lending('''
    constructor() {
        _disableInitializers();
    }
'''))

# ---------- I07 : reinitializer without access control
write("I07_MarketplaceV2.sol", INITIALIZABLE + "\n" + OWNABLE_UP + "\n" + r'''contract MarketplaceV1 is Initializable, OwnableUpgradeable {
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
''')

# ---------- I08 : hand-rolled flag never set
write("I08_PoolConfigurator.sol", r'''interface IPool {
    function setReserveActive(address asset, bool active) external;
}

contract PoolConfiguratorStorage {
    bool internal initialized;
    address public governor;
    address public pool;
    uint256 public flashFeeBps;
}

contract PoolConfigurator is PoolConfiguratorStorage {
    event GovernorSet(address indexed governor);
    event ReserveToggled(address indexed asset, bool active);

    modifier onlyGovernor() {
        require(msg.sender == governor, "governor");
        _;
    }

    function initialize(address governor_, address pool_, uint256 flashFeeBps_) external {
        require(!initialized, "already initialized");
        governor = governor_;
        pool = pool_;
        flashFeeBps = flashFeeBps_;
        emit GovernorSet(governor_);
    }

    function setReserveActive(address asset, bool active) external onlyGovernor {
        IPool(pool).setReserveActive(asset, active);
        emit ReserveToggled(asset, active);
    }

    function setFlashFee(uint256 bps) external onlyGovernor {
        require(bps <= 100, "fee");
        flashFeeBps = bps;
    }
}
''')

# ---------- I09 / I10 : owner==0 used as init guard, owner can be renounced
def bridge(fixed):
    flag_decl = "    bool private _initialized;\n" if fixed else ""
    guard = ('        require(!_initialized, "initialized");\n        _initialized = true;\n'
             if fixed else '        require(owner == address(0), "initialized");\n')
    return r'''contract BridgeEscrow {
    address public owner;
    address public relayer;
    uint256 public nonce;
''' + flag_decl + r'''    mapping(bytes32 => bool) public processed;

    event Locked(address indexed from, uint256 amount, uint256 indexed nonce);
    event Released(address indexed to, uint256 amount, bytes32 indexed id);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    function initialize(address owner_, address relayer_) external {
''' + guard + r'''        owner = owner_;
        relayer = relayer_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setRelayer(address r) external onlyOwner {
        relayer = r;
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function lock() external payable {
        require(msg.value > 0, "zero");
        emit Locked(msg.sender, msg.value, nonce++);
    }

    function release(address payable to, uint256 amount, bytes32 id) external {
        require(msg.sender == relayer, "relayer");
        require(!processed[id], "processed");
        processed[id] = true;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "release failed");
        emit Released(to, amount, id);
    }
}
'''
write("I09_BridgeEscrow.sol", bridge(False))
write("I10_BridgeEscrow.sol", bridge(True))

# ---------- I11 / I12 : beacon upgrade with / without owner check
def beacon(mod):
    return INITIALIZABLE + "\n" + OWNABLE_UP + "\n" + r'''interface IBeacon {
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

    function upgradeTo(address newImplementation) external''' + mod + r''' {
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
'''
write("I11_CreatorVaultBeacon.sol", beacon(" onlyOwner"))
write("I12_CreatorVaultBeacon.sol", beacon(""))

# ---------- I13 / I14 : UUPS authorize hook
def gauge(auth):
    return INITIALIZABLE + "\n" + ERC1967_STORAGE + "\n" + uups(True) + "\n" + OWNABLE_UP + "\n" + r'''contract GaugeController is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    mapping(address => uint256) public weightOf;
    uint256 public totalWeight;
    mapping(address => bool) public isGauge;

    event GaugeAdded(address indexed gauge, uint256 weight);

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __Ownable_init(admin);
    }

    function addGauge(address gauge, uint256 weight) external onlyOwner {
        require(!isGauge[gauge], "exists");
        isGauge[gauge] = true;
        weightOf[gauge] = weight;
        totalWeight += weight;
        emit GaugeAdded(gauge, weight);
    }

    function relativeWeight(address gauge) external view returns (uint256) {
        return totalWeight == 0 ? 0 : (weightOf[gauge] * 1e18) / totalWeight;
    }

    function _authorizeUpgrade(address newImplementation) internal override''' + auth + r''' {
        require(newImplementation != address(0), "zero implementation");
    }
}

''' + ERC1967_PROXY
write("I13_GaugeController.sol", gauge(""))
write("I14_GaugeController.sol", gauge(" onlyOwner"))

# ---------- I15 / I16 : transparent-style proxy admin functions
def transparent(mod):
    return ERC1967_STORAGE + "\n" + r'''contract TransparentProxy is ERC1967Storage {
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

    function upgradeTo(address newImplementation) external''' + mod + r''' {
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
'''
write("I15_TransparentProxy.sol", transparent(""))
write("I16_TransparentProxy.sol", transparent(" ifAdmin"))
print("ok")
