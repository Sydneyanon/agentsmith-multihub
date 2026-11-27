// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEligibility {
    function isEligible(address who) external view returns (bool);
}

/// An airdrop gated by an eligibility contract. claim() asks an eligibility contract SUPPLIED BY THE CALLER, so an
/// attacker deploys one that always answers true and claims the airdrop. Cross-contract trust-boundary defect: the
/// external call is a view, there is no reentrancy and every write is keyed by the caller; the bug is which contract
/// is trusted. Effects precede the (view) interaction; if the source says no, the require reverts the claim.
contract AirdropTrustBad {
    uint256 public constant AMOUNT = 100 ether;
    IEligibility public immutable eligibility;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public claimed;

    constructor(IEligibility e) { eligibility = e; }

    function claim(IEligibility source) external {
        require(!claimed[msg.sender], "claimed");
        claimed[msg.sender] = true;
        balanceOf[msg.sender] += AMOUNT;
        // BUG (cross-contract): trusts an eligibility contract chosen by the caller instead of the configured one.
        require(source.isEligible(msg.sender), "not eligible");
    }
}
