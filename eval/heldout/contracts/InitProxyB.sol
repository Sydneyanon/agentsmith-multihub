// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InitProxyB {
    address public owner;
    uint256 public cap;
    bool private initialized;

    event Configured(address indexed owner, uint256 cap);

    function initialize(address newOwner, uint256 newCap) external {
        require(!initialized, "already initialized");
        initialized = true;
        owner = newOwner;
        cap = newCap;
        emit Configured(newOwner, newCap);
    }

    function isOwner(address who) external view returns (bool) {
        return who == owner;
    }
}
