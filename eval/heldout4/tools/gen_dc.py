import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from gen_init import write, INITIALIZABLE, OWNABLE_UP, ERC1967_STORAGE, uups

ASM_DELEGATE = r'''        assembly {
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
'''

# D01 forwarding proxy with receive
write("D01_PaymentSplitterProxy.sol", r'''contract PaymentSplitterLogic {
    address[] internal _payees;
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    mapping(address => uint256) public released;
    uint256 public totalReleased;
    bool internal _setup;

    event PaymentReceived(address from, uint256 amount);

    function setup(address[] calldata payees, uint256[] calldata shares_) external {
        require(!_setup, "setup done");
        _setup = true;
        for (uint256 i = 0; i < payees.length; i++) {
            _payees.push(payees[i]);
            shares[payees[i]] = shares_[i];
            totalShares += shares_[i];
        }
    }

    function onPayment() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    function release(address payable account) external {
        uint256 totalReceived = address(this).balance + totalReleased;
        uint256 due = (totalReceived * shares[account]) / totalShares - released[account];
        require(due > 0, "nothing due");
        released[account] += due;
        totalReleased += due;
        (bool ok, ) = account.call{value: due}("");
        require(ok, "release failed");
    }
}

contract PaymentSplitterProxy {
    address public immutable logic;

    constructor(address logic_, bytes memory setupData) {
        logic = logic_;
        (bool ok, ) = logic_.delegatecall(setupData);
        require(ok, "setup failed");
    }

    receive() external payable {
        (bool ok, ) = logic.delegatecall(abi.encodeWithSelector(PaymentSplitterLogic.onPayment.selector));
        require(ok, "payment hook failed");
    }

    fallback() external payable {
        address impl = logic;
''' + ASM_DELEGATE + r'''    }
}
''')

# D02 / D03 storage collision
def crowdsale(unstructured):
    if unstructured:
        proxy = r'''contract SaleProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address impl) {
        _store(IMPL_SLOT, impl);
        _store(ADMIN_SLOT, msg.sender);
    }

    function _store(bytes32 slot, address v) private {
        assembly {
            sstore(slot, v)
        }
    }

    function _load(bytes32 slot) private view returns (address v) {
        assembly {
            v := sload(slot)
        }
    }

    function upgrade(address next) external {
        require(msg.sender == _load(ADMIN_SLOT), "admin");
        _store(IMPL_SLOT, next);
    }

    fallback() external payable {
        address impl = _load(IMPL_SLOT);
'''
    else:
        proxy = r'''contract SaleProxy {
    address public implementation;
    address public admin;

    constructor(address impl) {
        implementation = impl;
        admin = msg.sender;
    }

    function upgrade(address next) external {
        require(msg.sender == admin, "admin");
        implementation = next;
    }

    fallback() external payable {
        address impl = implementation;
'''
    return r'''interface IMintable {
    function mint(address to, uint256 amount) external;
}

contract CrowdsaleLogic {
    address public token;
    address public owner;
    uint256 public rate;
    uint256 public raised;
    bool public initialized;

    event Bought(address indexed buyer, uint256 paid, uint256 tokens);

    function initialize(address token_, uint256 rate_) external {
        require(!initialized, "initialized");
        initialized = true;
        token = token_;
        owner = msg.sender;
        rate = rate_;
    }

    function buy() external payable {
        require(msg.value > 0, "zero");
        raised += msg.value;
        IMintable(token).mint(msg.sender, msg.value * rate);
        emit Bought(msg.sender, msg.value, msg.value * rate);
    }

    function withdraw() external {
        require(msg.sender == owner, "owner");
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}

''' + proxy + ASM_DELEGATE + "    }\n}\n"
write("D02_CrowdsaleProxy.sol", crowdsale(False))
write("D03_CrowdsaleProxy.sol", crowdsale(True))

# D04 / D05 smart account executeDelegate
def account(fixed):
    mod = " onlyOwner" if fixed else ""
    check = '        require(trustedModule[module], "module not trusted");\n' if fixed else ""
    return r'''contract SmartAccount {
    address public owner;
    uint256 public nonce;
    mapping(address => bool) public trustedModule;

    event Executed(address indexed target, uint256 value, bytes data);
    event ModuleExecuted(address indexed module, bytes data);
    event ModuleTrusted(address indexed module, bool trusted);

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "account: not owner");
        _;
    }

    receive() external payable {}

    function setModule(address module, bool trusted) external onlyOwner {
        trustedModule[module] = trusted;
        emit ModuleTrusted(module, trusted);
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        nonce++;
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "call failed");
        emit Executed(target, value, data);
        return ret;
    }

    function executeModule(address module, bytes calldata data) external''' + mod + r''' returns (bytes memory) {
''' + check + r'''        nonce++;
        (bool ok, bytes memory ret) = module.delegatecall(data);
        require(ok, "module failed");
        emit ModuleExecuted(module, data);
        return ret;
    }
}

contract RecoveryModule {
    address public owner;

    function rotateOwner(address next) external {
        require(next != address(0), "zero");
        owner = next;
    }
}
'''
write("D04_SmartAccount.sol", account(False))
write("D05_SmartAccount.sol", account(True))

# D06 multicall self delegatecall
write("D06_PositionManager.sol", r'''abstract contract Multicall {
    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract PositionManager is Multicall {
    struct Position {
        address owner;
        uint128 liquidity;
        int24 lower;
        int24 upper;
    }

    IERC20 public immutable token;
    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;

    constructor(IERC20 token_) {
        token = token_;
    }

    function open(uint128 liquidity, int24 lower, int24 upper) external returns (uint256 id) {
        require(lower < upper, "range");
        require(token.transferFrom(msg.sender, address(this), liquidity), "pull");
        id = nextId++;
        positions[id] = Position(msg.sender, liquidity, lower, upper);
    }

    function close(uint256 id) external {
        Position memory p = positions[id];
        require(p.owner == msg.sender, "not owner");
        delete positions[id];
        require(token.transfer(msg.sender, p.liquidity), "push");
    }

    function adjust(uint256 id, int24 lower, int24 upper) external {
        require(positions[id].owner == msg.sender, "not owner");
        require(lower < upper, "range");
        positions[id].lower = lower;
        positions[id].upper = upper;
    }
}
''')

# D07 / D08 mutable math library
def ratemodel(fixed):
    mod = " onlyOwner" if fixed else ""
    return r'''contract InterestMath {
    uint256 public baseRate;
    uint256 public slope;
    address public owner;

    function borrowRate(uint256 cash, uint256 borrows) external view returns (uint256) {
        if (borrows == 0) return baseRate;
        uint256 util = (borrows * 1e18) / (cash + borrows);
        return baseRate + (util * slope) / 1e18;
    }
}

contract RateModelRouter {
    uint256 public baseRate;
    uint256 public slope;
    address public owner;
    address public mathLib;

    event MathLibChanged(address indexed lib);

    constructor(address lib, uint256 base, uint256 slope_) {
        owner = msg.sender;
        mathLib = lib;
        baseRate = base;
        slope = slope_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    function setMathLib(address lib) external''' + mod + r''' {
        require(lib.code.length > 0, "not a contract");
        mathLib = lib;
        emit MathLibChanged(lib);
    }

    function setParams(uint256 base, uint256 slope_) external onlyOwner {
        baseRate = base;
        slope = slope_;
    }

    function compute(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = mathLib.delegatecall(data);
        require(ok, "compute failed");
        return ret;
    }
}
'''
write("D07_RateModelRouter.sol", ratemodel(False))
write("D08_RateModelRouter.sol", ratemodel(True))

# D09 / D10 selector router
def router(fixed):
    mod = " onlyOwner" if fixed else ""
    return r'''contract ModularRouterStorage {
    address public owner;
    mapping(bytes4 => address) public moduleFor;
    uint256 public totalVolume;
}

contract ModularRouter is ModularRouterStorage {
    event ModuleSet(bytes4 indexed selector, address indexed module);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "router: not owner");
        _;
    }

    function setModule(bytes4 selector, address module) external''' + mod + r''' {
        moduleFor[selector] = module;
        emit ModuleSet(selector, module);
    }

    function setModules(bytes4[] calldata selectors, address module) external onlyOwner {
        for (uint256 i = 0; i < selectors.length; i++) {
            moduleFor[selectors[i]] = module;
            emit ModuleSet(selectors[i], module);
        }
    }

    receive() external payable {}

    fallback() external payable {
        address impl = moduleFor[msg.sig];
        require(impl != address(0), "router: unknown selector");
''' + ASM_DELEGATE + r'''    }
}

contract SwapModule is ModularRouterStorage {
    function recordSwap(uint256 amount) external {
        totalVolume += amount;
    }
}
'''
write("D09_ModularRouter.sol", router(True))
write("D10_ModularRouter.sol", router(False))

# D11 payable batch with msg.value reuse
write("D11_LaunchpadBatcher.sol", r'''contract Launchpad {
    uint256 public constant TICKET_PRICE = 0.1 ether;

    address public immutable organizer;
    mapping(address => uint256) public tickets;
    mapping(address => uint256) public credit;
    uint256 public ticketsSold;

    constructor() {
        organizer = msg.sender;
    }

    function buyTickets() public payable {
        uint256 n = msg.value / TICKET_PRICE;
        require(n > 0, "too little");
        tickets[msg.sender] += n;
        ticketsSold += n;
        credit[msg.sender] += msg.value - n * TICKET_PRICE;
    }

    function topUpCredit() public payable {
        credit[msg.sender] += msg.value;
    }

    function withdrawCredit() external {
        uint256 c = credit[msg.sender];
        credit[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: c}("");
        require(ok, "withdraw failed");
    }

    function batch(bytes[] calldata calls) external payable {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = address(this).delegatecall(calls[i]);
            require(ok, "batch item failed");
        }
    }
}
''')

# D12 unchecked delegatecall result
write("D12_KeeperJobs.sol", r'''contract KeeperJobs {
    struct Job {
        address module;
        bytes payload;
        uint64 interval;
        uint64 lastRun;
        uint128 reward;
    }

    address public immutable governance;
    mapping(address => bool) public keepers;
    Job[] public jobs;
    mapping(address => uint256) public earned;

    event JobRun(uint256 indexed id, address indexed keeper);

    constructor() {
        governance = msg.sender;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance, "governance");
        _;
    }

    function setKeeper(address k, bool on) external onlyGovernance {
        keepers[k] = on;
    }

    function addJob(address module, bytes calldata payload, uint64 interval, uint128 reward) external onlyGovernance {
        jobs.push(Job(module, payload, interval, 0, reward));
    }

    function work(uint256 id) external {
        require(keepers[msg.sender], "keeper");
        Job storage j = jobs[id];
        require(block.timestamp >= j.lastRun + j.interval, "too soon");
        j.lastRun = uint64(block.timestamp);
        j.module.delegatecall(j.payload);
        earned[msg.sender] += j.reward;
        emit JobRun(id, msg.sender);
    }

    function claim() external {
        uint256 e = earned[msg.sender];
        earned[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: e}("");
        require(ok, "claim failed");
    }

    receive() external payable {}
}
''')

# ------------------------- selfdestruct
def giftcard(fixed):
    mod = " onlyIssuer" if fixed else ""
    return r'''contract GiftCardIssuer {
    address public issuer;

    constructor() {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, "issuer");
        _;
    }
}

contract GiftCards is GiftCardIssuer {
    mapping(bytes32 => uint256) public cardValue;

    event Issued(bytes32 indexed codeHash, uint256 value);
    event Redeemed(bytes32 indexed codeHash, address indexed to, uint256 value);

    function issue(bytes32 codeHash) external payable onlyIssuer {
        require(cardValue[codeHash] == 0, "exists");
        cardValue[codeHash] = msg.value;
        emit Issued(codeHash, msg.value);
    }

    function redeem(string calldata code, address payable to) external {
        bytes32 h = keccak256(bytes(code));
        uint256 v = cardValue[h];
        require(v > 0, "unknown card");
        cardValue[h] = 0;
        (bool ok, ) = to.call{value: v}("");
        require(ok, "redeem failed");
        emit Redeemed(h, to, v);
    }

    function shutdown(address payable to) external''' + mod + r''' {
        selfdestruct(to);
    }
}
'''
write("S01_GiftCards.sol", giftcard(False))
write("S02_GiftCards.sol", giftcard(True))

def parity(fixed):
    ctor = r'''
    constructor() {
        initialized = true;
    }
''' if fixed else ""
    return r'''contract WalletLibrary {
    bool internal initialized;
    uint256 public required;
    address[] public owners;
    mapping(address => bool) public isOwner;
    mapping(bytes32 => uint256) public confirmations;
    mapping(bytes32 => mapping(address => bool)) public confirmedBy;

    event Confirmation(address indexed owner, bytes32 indexed operation);
    event Execution(bytes32 indexed operation, address to, uint256 value);
''' + ctor + r'''
    modifier onlyOwner() {
        require(isOwner[msg.sender], "not an owner");
        _;
    }

    modifier onlyManyOwners(bytes32 operation) {
        if (!confirmedBy[operation][msg.sender]) {
            confirmedBy[operation][msg.sender] = true;
            confirmations[operation]++;
            emit Confirmation(msg.sender, operation);
        }
        if (confirmations[operation] >= required) {
            _;
        }
    }

    function initWallet(address[] memory owners_, uint256 required_) public {
        require(!initialized, "already initialized");
        require(required_ > 0 && required_ <= owners_.length, "bad threshold");
        initialized = true;
        for (uint256 i = 0; i < owners_.length; i++) {
            owners.push(owners_[i]);
            isOwner[owners_[i]] = true;
        }
        required = required_;
    }

    function execute(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        onlyManyOwners(keccak256(abi.encode(to, value, data)))
    {
        (bool ok, ) = to.call{value: value}(data);
        require(ok, "execution failed");
        emit Execution(keccak256(abi.encode(to, value, data)), to, value);
    }

    function kill(address payable to) external onlyOwner {
        selfdestruct(to);
    }
}

contract Wallet {
    address public immutable walletLibrary;

    constructor(address lib, address[] memory owners_, uint256 required_) {
        walletLibrary = lib;
        (bool ok, ) = lib.delegatecall(abi.encodeWithSelector(WalletLibrary.initWallet.selector, owners_, required_));
        require(ok, "init failed");
    }

    receive() external payable {}

    fallback() external payable {
        address impl = walletLibrary;
''' + ASM_DELEGATE + r'''    }
}
'''
write("S03_MultisigWallet.sol", parity(False))
write("S04_MultisigWallet.sol", parity(True))

# S05 UUPS logic with owner-gated selfdestruct
write("S05_SubscriptionHub.sol", INITIALIZABLE + "\n" + ERC1967_STORAGE + "\n" + uups(True) + "\n" + OWNABLE_UP + "\n" + r'''contract SubscriptionHub is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 public monthlyPrice;
    mapping(address => uint64) public paidUntil;

    event Subscribed(address indexed user, uint64 until);

    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, uint256 price) external initializer {
        __Ownable_init(admin);
        monthlyPrice = price;
    }

    function subscribe(uint8 months) external payable {
        require(months > 0, "months");
        require(msg.value == monthlyPrice * months, "price");
        uint64 start = paidUntil[msg.sender] > block.timestamp ? paidUntil[msg.sender] : uint64(block.timestamp);
        paidUntil[msg.sender] = start + uint64(months) * 30 days;
        emit Subscribed(msg.sender, paidUntil[msg.sender]);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Winds the service down and returns all held funds to the treasury.
    function decommission(address payable treasury) external onlyOwner onlyProxy {
        selfdestruct(treasury);
    }
}
''')

# S06 / S07 clone implementation left initialisable
def clones(fixed):
    ctor = r'''
    constructor() {
        _disableInitializers();
    }
''' if fixed else ""
    return INITIALIZABLE + "\n" + r'''contract VestingWallet is Initializable {
    address public beneficiary;
    address public controller;
    uint64 public start;
    uint64 public duration;
    uint256 public released;

    event EtherReleased(uint256 amount);
''' + ctor + r'''
    function initialize(address beneficiary_, address controller_, uint64 start_, uint64 duration_) external initializer {
        beneficiary = beneficiary_;
        controller = controller_;
        start = start_;
        duration = duration_;
    }

    receive() external payable {}

    function vestedAmount(uint64 ts) public view returns (uint256) {
        uint256 total = address(this).balance + released;
        if (ts < start) return 0;
        if (ts >= start + duration) return total;
        return (total * (ts - start)) / duration;
    }

    function release() external {
        uint256 amount = vestedAmount(uint64(block.timestamp)) - released;
        released += amount;
        (bool ok, ) = beneficiary.call{value: amount}("");
        require(ok, "release failed");
        emit EtherReleased(amount);
    }

    function revoke(address payable refundTo) external {
        require(msg.sender == controller, "controller");
        selfdestruct(refundTo);
    }
}

contract VestingFactory {
    address public immutable implementation;
    address public immutable controller;
    address[] public wallets;

    constructor() {
        implementation = address(new VestingWallet());
        controller = msg.sender;
    }

    function create(address beneficiary, uint64 start, uint64 duration) external payable returns (address w) {
        require(msg.sender == controller, "controller");
        w = _clone(implementation);
        VestingWallet(payable(w)).initialize(beneficiary, controller, start, duration);
        (bool ok, ) = w.call{value: msg.value}("");
        require(ok, "fund failed");
        wallets.push(w);
    }

    function _clone(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "clone failed");
    }
}
'''
write("S06_VestingFactory.sol", clones(False))
write("S07_VestingFactory.sol", clones(True))

# S08 / S09 inherited ownership transfer + selfdestruct
def lottery(fixed):
    mod = " onlyOwner" if fixed else ""
    return r'''abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transferOwnership(address newOwner) public''' + mod + r''' {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

contract LotteryPot is Ownable {
    uint256 public constant TICKET = 0.01 ether;
    address[] public players;
    uint256 public round;

    event Entered(address indexed player, uint256 indexed round);
    event Drawn(address indexed winner, uint256 prize, uint256 indexed round);

    function enter() external payable {
        require(msg.value == TICKET, "ticket price");
        players.push(msg.sender);
        emit Entered(msg.sender, round);
    }

    function draw(uint256 seed) external onlyOwner {
        require(players.length > 0, "no players");
        address winner = players[uint256(keccak256(abi.encode(seed, block.prevrandao))) % players.length];
        uint256 prize = address(this).balance;
        delete players;
        round++;
        (bool ok, ) = winner.call{value: prize}("");
        require(ok, "payout failed");
        emit Drawn(winner, prize, round - 1);
    }

    function terminate() external onlyOwner {
        selfdestruct(payable(owner));
    }
}
'''
write("S08_LotteryPot.sol", lottery(False))
write("S09_LotteryPot.sol", lottery(True))
print("ok")
