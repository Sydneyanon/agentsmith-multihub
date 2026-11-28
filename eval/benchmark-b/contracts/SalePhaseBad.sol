// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A phased sale: Setup -> Active -> Ended. Allocations are only final once the sale has Ended; claim() must be
/// gated to the Ended phase. The bug is a wrong state guard — claim() checks `phase != Setup`, so it also succeeds
/// during Active, letting a buyer claim (and drain) tokens before allocations are finalised. Pure state-machine
/// defect: no external call, no missing modifier, correct arithmetic. A structural detector has no model of the
/// intended state transitions.
contract SalePhaseBad {
    enum Phase { Setup, Active, Ended }
    Phase public phase;
    address public immutable owner;
    mapping(address => uint256) public allocation;
    mapping(address => uint256) public claimable;

    constructor() { owner = msg.sender; }

    function advance() external { require(msg.sender == owner, "owner"); if (phase != Phase.Ended) phase = Phase(uint8(phase) + 1); }
    function allocate(address to, uint256 amt) external { require(msg.sender == owner, "owner"); require(phase == Phase.Setup, "setup only"); allocation[to] = amt; }

    function claim() external {
        // BUG (state-transition): must be `phase == Phase.Ended`; `!= Setup` also allows claims during Active.
        require(phase != Phase.Setup, "not started");
        uint256 amt = allocation[msg.sender];
        allocation[msg.sender] = 0;
        claimable[msg.sender] += amt;
    }
}
