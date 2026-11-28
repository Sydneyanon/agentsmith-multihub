// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Gateway {
    address public owner;
    address public factory;
    bool private _locked;

    constructor() {
        _locked = true;
        factory = msg.sender;
    }

    function initialize(address o) external {
        require(!_locked, "locked");
        _locked = true;
        owner = o;
    }

    function configure(address o) external {
        require(msg.sender == factory, "factory");
        owner = o;
    }

    function bootstrap(address o) external {
        require(owner == address(0), "set");
        owner = o;
    }
}
