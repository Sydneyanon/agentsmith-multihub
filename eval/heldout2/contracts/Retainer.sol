// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Retainer {
    mapping(address => uint256) public held;

    function fund(address who) external payable {
        held[who] += msg.value;
    }

    function release() external {
        _settle(msg.sender);
    }

    function _settle(address to) internal {
        uint256 amt = held[to];
        require(amt > 0, "empty");
        held[to] = 0;
        _push(to, amt);
    }

    function _push(address to, uint256 amt) private {
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "push");
    }
}
