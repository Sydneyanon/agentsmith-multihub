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

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

abstract contract PausableUpgradeable is Initializable {
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

    function initialize(IERC20 asset_, address manager_) external {
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
