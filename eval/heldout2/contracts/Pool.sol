// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IListener {
    function onFunds(address who, uint256 amount) external;
}

contract Pool {
    mapping(address => uint256) public bal;
    mapping(address => address) public hooks;

    function join(address hook) external payable {
        bal[msg.sender] += msg.value;
        hooks[msg.sender] = hook;
    }

    function exit(uint256 a) external {
        require(bal[msg.sender] >= a, "low");
        IListener(hooks[msg.sender]).onFunds(msg.sender, a);
        bal[msg.sender] -= a;
        (bool ok, ) = payable(msg.sender).call{value: a}("");
        require(ok, "xfer");
    }
}
