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
