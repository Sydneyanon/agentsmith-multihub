// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMintable {
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

contract SaleProxy {
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
