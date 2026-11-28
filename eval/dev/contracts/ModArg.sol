// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ModArg {
    address public admin;
    address public other;
    modifier onlyBy(address who) { require(msg.sender == who, "denied"); _; }
    constructor() { admin = msg.sender; }
    function setOtherGuarded(address o) external onlyBy(admin) { other = o; }
    function setOtherWrongArg(address o, address who) external onlyBy(who) { other = o; }
}
