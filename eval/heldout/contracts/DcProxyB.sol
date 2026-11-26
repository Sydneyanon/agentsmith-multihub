// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcProxyB {
    address public owner;

    event Executed(address indexed target, bytes4 selector);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function execute(
        address target,
        bytes calldata data
    ) external payable onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.delegatecall(data);
        require(ok, "execution failed");
        emit Executed(target, bytes4(data[:4]));
        return ret;
    }
}
