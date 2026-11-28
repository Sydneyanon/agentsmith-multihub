// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NotOwner(address caller);

abstract contract Ownable {
    address internal _owner;

    constructor() {
        _owner = msg.sender;
    }

    function _checkOwner() internal view {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
    }
}

contract AcMintB is Ownable {
    string public name = "Demo Token";
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        _checkOwner();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
