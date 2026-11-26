// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcProxyA {
    address public owner;

    event Executed(address indexed target, bytes4 selector);

    constructor() {
        owner = msg.sender;
    }

    function execute(
        address target,
        bytes calldata data
    ) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.delegatecall(data);
        require(ok, "execution failed");
        emit Executed(target, bytes4(data[:4]));
        return ret;
    }
}
