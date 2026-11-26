// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract UcHelperC {
    mapping(address => uint256) public balances;

    event Withdrawn(address indexed who, uint256 amount);

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        require(_send(msg.sender, amount), "send failed");
        emit Withdrawn(msg.sender, amount);
    }

    function _send(address to, uint256 value) internal returns (bool ok) {
        (ok, ) = to.call{value: value}("");
    }
}
