// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MarketLogic
/// @notice Order-book logic shared by many market proxies. Deployed once; each
///         proxy calls `initialize` through delegatecall.
contract MarketLogic {
    address public owner;
    bool public initialized;
    uint16 public takerFeeBps;
    mapping(address => uint256) public deposits;

    event Initialized(address indexed owner);
    event Retired(address indexed to);

    error NotOwner();
    error AlreadyInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function initialize(address owner_, uint16 feeBps) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        owner = owner_;
        takerFeeBps = feeBps;
        emit Initialized(owner_);
    }

    function deposit() external payable {
        deposits[msg.sender] += msg.value;
    }

    /// @notice Emergency shutdown that returns the market's ETH to the owner.
    function emergencyRetire() external onlyOwner {
        emit Retired(owner);
        selfdestruct(payable(owner));
    }
}

/// @title MarketProxy
/// @notice Forwards every call to the shared logic contract.
contract MarketProxy {
    address public immutable logic;

    constructor(address logic_, address owner_, uint16 feeBps) {
        logic = logic_;
        (bool ok, ) = logic_.delegatecall(abi.encodeCall(MarketLogic.initialize, (owner_, feeBps)));
        require(ok, "init failed");
    }

    fallback() external payable {
        address impl = logic;
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
