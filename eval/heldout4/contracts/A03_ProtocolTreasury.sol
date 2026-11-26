// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract RoleRegistry {
    address public admin;
    mapping(address => bool) public isOperator;

    event OperatorSet(address indexed account, bool enabled);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "admin only");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == admin || isOperator[msg.sender], "operator only");
        _;
    }

    function setOperator(address account, bool enabled) external {
        isOperator[account] = enabled;
        emit OperatorSet(account, enabled);
    }
}

contract ProtocolTreasury is RoleRegistry {
    event Disbursed(address indexed token, address indexed to, uint256 amount);
    event EtherDisbursed(address indexed to, uint256 amount);

    receive() external payable {}

    function disburse(IERC20 token, address to, uint256 amount) external onlyOperator {
        require(token.transfer(to, amount), "token transfer failed");
        emit Disbursed(address(token), to, amount);
    }

    function disburseEther(address payable to, uint256 amount) external onlyOperator {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ether transfer failed");
        emit EtherDisbursed(to, amount);
    }

    function setAdmin(address next) external onlyAdmin {
        require(next != address(0), "zero");
        admin = next;
    }
}
