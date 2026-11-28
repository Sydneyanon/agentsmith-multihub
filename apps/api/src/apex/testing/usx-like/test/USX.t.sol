// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests (OUT OF SCOPE): a test-shaped contract outside the selected files.
pragma solidity ^0.8.20;

contract USXTest {
    uint256 public total;
    mapping(address => uint256) public seen;

    function setUp() external {
        total += 1;
        seen[msg.sender] += 2;
    }
}
