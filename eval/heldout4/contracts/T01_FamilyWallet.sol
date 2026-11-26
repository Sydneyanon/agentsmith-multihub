// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FamilyWallet {
    address public owner;
    mapping(address => uint256) public allowanceOf;

    event Sent(address indexed to, uint256 amount);
    event AllowanceSet(address indexed member, uint256 amount);

    constructor() payable {
        owner = msg.sender;
    }

    receive() external payable {}

    function setAllowance(address member, uint256 amount) external {
        require(msg.sender == owner, "owner");
        allowanceOf[member] = amount;
        emit AllowanceSet(member, amount);
    }

    function spend(uint256 amount) external {
        require(allowanceOf[msg.sender] >= amount, "allowance");
        allowanceOf[msg.sender] -= amount;
        _send(payable(msg.sender), amount);
    }

    function sendTo(address payable to, uint256 amount) external {
        require(tx.origin == owner, "owner");
        _send(to, amount);
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
        emit Sent(to, amount);
    }
}
