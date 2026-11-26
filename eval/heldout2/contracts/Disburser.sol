// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Disburser {
    mapping(address => uint256) public owed;

    error SendFailed();

    function put(address who) external payable {
        owed[who] += msg.value;
    }

    function payOut(address payable to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        require(to.send(a), "send");
    }

    function payOutAlt(address payable to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        if (!to.send(a)) revert SendFailed();
    }
}
