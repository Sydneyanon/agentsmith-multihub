// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFactory {
    function implFor(bytes32 id) external view returns (address);
}

contract Plugins {
    address public owner;
    IFactory public immutable factory;
    mapping(bytes32 => address) public slots;

    constructor(IFactory f) {
        owner = msg.sender;
        factory = f;
    }

    function register(bytes32 id, address impl) external {
        require(msg.sender == owner, "owner");
        slots[id] = impl;
    }

    function invoke(bytes32 id, bytes calldata data) external {
        address t = slots[id];
        require(t != address(0), "none");
        (bool ok, ) = t.delegatecall(data);
        require(ok, "fail");
    }

    function invokeFromFactory(bytes32 id, bytes calldata data) external {
        address t = factory.implFor(id);
        (bool ok, ) = t.delegatecall(data);
        require(ok, "fail");
    }

    function batch(bytes[] calldata calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = address(this).delegatecall(calls[i]);
            require(ok, "fail");
        }
    }
}
