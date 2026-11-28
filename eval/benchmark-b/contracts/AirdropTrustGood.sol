// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEligibility {
    function isEligible(address who) external view returns (bool);
}

/// Matched secure variant of AirdropTrustBad: claim() consults only the eligibility contract fixed at construction.
/// Structurally identical; only the trusted contract differs. Flagging this claim is a false positive.
contract AirdropTrustGood {
    uint256 public constant AMOUNT = 100 ether;
    IEligibility public immutable eligibility;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public claimed;

    constructor(IEligibility e) { eligibility = e; }

    function claim() external {
        require(!claimed[msg.sender], "claimed");
        claimed[msg.sender] = true;
        balanceOf[msg.sender] += AMOUNT;
        require(eligibility.isEligible(msg.sender), "not eligible");
    }
}
