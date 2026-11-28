// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests (OUT OF SCOPE in the official selection). It carries a plain ether-accounting bug
// APEX could model, so a test can show the shadow stage never analyses a file outside the 20 in-scope paths.
pragma solidity ^0.8.20;

contract USXRebalancer {
    mapping(address => uint256) public credit;
    uint256 public totalCredit;

    function deposit() external payable {
        credit[msg.sender] += msg.value;
        totalCredit += msg.value;
    }

    function drain(uint256 amount) external {
        totalCredit -= amount;
    }
}
