// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
// Deliberate for the tests: `burnFrom` forgets the supply, and only that path writes the narrow `burns` counter, so the one
// counterexample touches a narrow-integer approximation and must be SUPPRESSED, never reported.
pragma solidity ^0.8.20;

contract BridgedToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public gateway;
    uint8 public burns;

    constructor() {
        gateway = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == gateway, "gateway");
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burnFrom(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        burns += 1;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
