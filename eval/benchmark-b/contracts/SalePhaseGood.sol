// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Matched secure variant of SalePhaseBad: claim() is correctly gated to the Ended phase, so allocations cannot be
/// claimed before they are finalised. Structurally identical; only the state guard differs. Flagging this claim is a
/// false positive.
contract SalePhaseGood {
    enum Phase { Setup, Active, Ended }
    Phase public phase;
    address public immutable owner;
    mapping(address => uint256) public allocation;
    mapping(address => uint256) public claimable;

    constructor() { owner = msg.sender; }

    function advance() external { require(msg.sender == owner, "owner"); if (phase != Phase.Ended) phase = Phase(uint8(phase) + 1); }
    function allocate(address to, uint256 amt) external { require(msg.sender == owner, "owner"); require(phase == Phase.Setup, "setup only"); allocation[to] = amt; }

    function claim() external {
        require(phase == Phase.Ended, "not ended");
        uint256 amt = allocation[msg.sender];
        allocation[msg.sender] = 0;
        claimable[msg.sender] += amt;
    }
}
