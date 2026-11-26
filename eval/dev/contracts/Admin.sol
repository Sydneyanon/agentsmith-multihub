// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Ownable {
    address public owner;
    modifier onlyOwner() { _checkOwner(); _; }
    function _checkOwner() internal view {
        require(msg.sender == owner, "not owner");
    }
}

contract Config is Ownable {
    uint256 public fee;
    address public oracle;
    mapping(address => bool) public minters;
    mapping(address => uint256) public supply;

    constructor() { owner = msg.sender; }

    function setFeeOpen(uint256 f) external { fee = f; }                       // unguarded: fee is not an authority var
    function setOracleOpen(address o) external { oracle = o; }                  // unguarded authority-like var
    function setOracleGuarded(address o) external onlyOwner { oracle = o; }
    function setOracleInBody(address o) external { require(msg.sender == owner, "no"); oracle = o; }
    function setOracleIf(address o) external { if (msg.sender != owner) revert(); oracle = o; }
    function addMinter(address m) external { minters[m] = true; }               // unguarded role grant
    function addMinterRole(address m) external { require(minters[msg.sender], "no"); minters[m] = true; }
    function transferOwner(address n) external { owner = n; _checkOwner(); }    // check AFTER the write
    function mint(address to, uint256 amt) external { supply[to] += amt; }      // unguarded mint
}
