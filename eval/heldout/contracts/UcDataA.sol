// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract UcDataA {
    address public owner;

    event Forwarded(address indexed target, uint256 value);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function forwardCall(address target, bytes calldata data) external payable onlyOwner {
        target.call{value: msg.value}(data);
        emit Forwarded(target, msg.value);
    }
}
