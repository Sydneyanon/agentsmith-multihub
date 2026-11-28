// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RoleBoard {
    bytes32 public constant PAUSER = keccak256("PAUSER");
    bytes32 public constant FEE = keccak256("FEE");

    mapping(bytes32 => mapping(address => bool)) public holds;
    bool public paused;
    uint256 public fee;

    error Missing(bytes32 role);

    constructor() {
        holds[PAUSER][msg.sender] = true;
        holds[FEE][msg.sender] = true;
    }

    function _need(bytes32 role) internal view {
        if (!holds[role][msg.sender]) revert Missing(role);
    }

    modifier only(bytes32 role) {
        _need(role);
        _;
    }

    function pause() external only(PAUSER) {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }

    function setFee(uint256 f) external {
        _need(FEE);
        fee = f;
    }
}
