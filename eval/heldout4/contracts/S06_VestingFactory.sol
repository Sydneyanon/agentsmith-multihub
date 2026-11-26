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

contract VestingWallet is Initializable {
    address public beneficiary;
    address public controller;
    uint64 public start;
    uint64 public duration;
    uint256 public released;

    event EtherReleased(uint256 amount);

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
