// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract UcDataB {
    address public owner;

    event Forwarded(address indexed target, uint256 value);
    error CallFailed(bytes reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function forwardCall(address target, bytes calldata data) external payable onlyOwner {
        (bool ok, bytes memory reason) = target.call{value: msg.value}(data);
        if (!ok) revert CallFailed(reason);
        emit Forwarded(target, msg.value);
    }
}
