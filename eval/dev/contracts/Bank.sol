// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Bank {
    mapping(address => uint256) public balances;
    uint256 private lockState = 1;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // classic: call before update
    function withdrawBad(uint256 amount) external {
        require(balances[msg.sender] >= amount, "low");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
        balances[msg.sender] = balances[msg.sender] - amount;
    }

    // checks-effects-interactions
    function withdrawCei(uint256 amount) external {
        require(balances[msg.sender] >= amount, "low");
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
    }

    // hand-rolled lock
    function withdrawLocked(uint256 amount) external {
        require(lockState == 1, "busy");
        lockState = 2;
        require(balances[msg.sender] >= amount, "low");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "fail");
        balances[msg.sender] -= amount;
        lockState = 1;
    }

    // call hidden in a helper
    function withdrawHelper(uint256 amount) external {
        require(balances[msg.sender] >= amount, "low");
        _pay(msg.sender, amount);
        balances[msg.sender] -= amount;
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "fail");
    }
}
