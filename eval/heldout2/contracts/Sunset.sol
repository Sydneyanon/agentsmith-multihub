// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Authority {
    address public steward;

    modifier only(address who) {
        require(msg.sender == who, "auth");
        _;
    }
}

contract Sunset is Authority {
    constructor() {
        steward = msg.sender;
    }

    receive() external payable {}

    function shutdown() external only(steward) {
        _wind();
    }

    function _wind() internal {
        selfdestruct(payable(steward));
    }
}
