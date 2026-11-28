// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Kiosk {
    mapping(address => uint256) public bal;
    bool private _inside;

    function put() external payable {
        bal[msg.sender] += msg.value;
    }

    function sweep() external {
        require(!_inside, "busy");
        _inside = true;
        uint256 a = bal[msg.sender];
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "xfer");
        bal[msg.sender] = 0;
        _inside = false;
    }

    function move(address to, uint256 a) external {
        require(bal[msg.sender] >= a, "low");
        bal[msg.sender] -= a;
        bal[to] += a;
    }
}

contract Turnstile {
    mapping(address => uint256) public bal;
    bool private _inside;

    function put() external payable {
        bal[msg.sender] += msg.value;
    }

    function exitAll() external {
        require(!_inside, "busy");
        _inside = true;
        uint256 a = bal[msg.sender];
        (bool ok, ) = msg.sender.call{value: a}("");
        require(ok, "xfer");
        bal[msg.sender] = 0;
        _inside = false;
    }
}
