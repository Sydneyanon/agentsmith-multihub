// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AcSweepB {
    bytes32 public constant ADMIN = keccak256("ADMIN");
    bytes32 public constant TREASURER = keccak256("TREASURER");

    mapping(bytes32 => mapping(address => bool)) private roles;

    event Swept(address indexed to, uint256 amount);
    event RoleGranted(bytes32 indexed role, address indexed who);

    constructor() {
        roles[ADMIN][msg.sender] = true;
        roles[TREASURER][msg.sender] = true;
    }

    receive() external payable {}

    function hasRole(bytes32 role, address who) public view returns (bool) {
        return roles[role][who];
    }

    function grantRole(bytes32 role, address who) external {
        require(hasRole(ADMIN, msg.sender), "missing admin role");
        roles[role][who] = true;
        emit RoleGranted(role, who);
    }

    function withdrawAll(address payable to) external {
        require(hasRole(TREASURER, msg.sender), "missing treasurer role");
        uint256 amount = address(this).balance;
        emit Swept(to, amount);
        to.transfer(amount);
    }
}
