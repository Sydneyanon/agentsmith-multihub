// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
// Deliberate for the tests: a fully modelled ether ledger whose `sweep` breaks `totalManaged == sum(deposits)`, so the shadow stage has
// something it CAN model; whatever APEX says about it is recorded as APEX-generated and unvalidated, never as a finding.
pragma solidity ^0.8.20;

contract MockAssetManager {
    mapping(address => uint256) public deposits;
    uint256 public totalManaged;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "value");
        deposits[msg.sender] += msg.value;
        totalManaged += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(deposits[msg.sender] >= amount, "balance");
        deposits[msg.sender] -= amount;
        totalManaged -= amount;
        payable(msg.sender).transfer(amount);
    }

    function sweep(uint256 amount) external {
        require(totalManaged >= amount, "managed");
        totalManaged -= amount;
    }
}
