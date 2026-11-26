// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Outbox {
    mapping(address => uint256) public owed;

    function put(address who) external payable {
        owed[who] += msg.value;
    }

    function _dispatch(address to, uint256 amt) internal returns (bool) {
        (bool ok, ) = to.call{value: amt}("");
        return ok;
    }

    function payOut(address to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        _dispatch(to, a);
    }

    function payOutChecked(address to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        require(_dispatch(to, a), "fail");
    }
}
