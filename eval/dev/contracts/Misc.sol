// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Misc {
    address public owner;
    address public impl;
    bool private ready;
    constructor() { owner = msg.sender; }

    function initOpen(address o) external { owner = o; }
    function initOnce(address o) external { require(!ready, "done"); ready = true; owner = o; }

    function fwdOpen(address target, bytes calldata data) external { (bool ok, ) = target.delegatecall(data); require(ok); }
    function fwdOwner(address target, bytes calldata data) external { require(msg.sender == owner); (bool ok, ) = target.delegatecall(data); require(ok); }
    function fwdImpl(bytes calldata data) external { (bool ok, ) = impl.delegatecall(data); require(ok); }
    function setImpl(address i) external { impl = i; }

    function ignored(address to) external payable { to.call{value: msg.value}(""); }
    function checked(address to) external payable { (bool ok, ) = to.call{value: msg.value}(""); require(ok); }
    function viaHelper(address to) external payable { _send(to, msg.value); }
    function viaHelperChecked(address to) external payable { require(_trySend(to, msg.value)); }
    function _send(address to, uint256 v) internal returns (bool) { (bool ok, ) = to.call{value: v}(""); return ok; }
    function _trySend(address to, uint256 v) internal returns (bool) { (bool ok, ) = to.call{value: v}(""); return ok; }

    function viaOrigin() external { require(tx.origin == owner, "no"); owner = address(0xdead); }
    function eoaOnly() external view returns (bool) { return tx.origin == msg.sender; }
    function eoaGate() external { require(tx.origin == msg.sender, "contracts not allowed"); ready = true; }

    function killOpen() external { selfdestruct(payable(msg.sender)); }
    function killOwner() external { require(msg.sender == owner); selfdestruct(payable(owner)); }
}
