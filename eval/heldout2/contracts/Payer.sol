// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Payer {
    mapping(address => uint256) public owed;

    function put(address who) external payable {
        owed[who] += msg.value;
    }

    function payOut(address payable to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        to.send(a);
    }
}
