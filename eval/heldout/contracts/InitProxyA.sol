// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InitProxyA {
    address public owner;
    uint256 public cap;

    event Configured(address indexed owner, uint256 cap);

    function initialize(address newOwner, uint256 newCap) external {
        owner = newOwner;
        cap = newCap;
        emit Configured(newOwner, newCap);
    }

    function isOwner(address who) external view returns (bool) {
        return who == owner;
    }
}
