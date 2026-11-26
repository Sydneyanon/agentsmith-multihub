// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Guarded {
    address public guardian;
    bool public paused;

    event PauseChanged(bool state);

    constructor() {
        guardian = msg.sender;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    function setPaused(bool p) external {
        require(msg.sender == guardian, "guardian only");
        paused = p;
        emit PauseChanged(p);
    }
}

contract EtherVault is Guarded {
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);

    function deposit() external payable whenNotPaused {
        require(msg.value > 0, "zero");
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdrawAll() external whenNotPaused {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");
        balances[msg.sender] = 0;
        totalDeposits -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Withdrawal(msg.sender, amount);
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
