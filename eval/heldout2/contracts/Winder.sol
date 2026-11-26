// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Winder {
    address public steward;

    constructor() {
        steward = msg.sender;
    }

    receive() external payable {}

    function shutdown() external {
        _wind();
    }

    function _wind() internal {
        _final(payable(steward));
    }

    function _final(address payable to) private {
        selfdestruct(to);
    }
}
