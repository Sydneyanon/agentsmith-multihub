pragma solidity ^0.8.20;
contract ExitQueue {
  mapping(address => uint256) public balances;
  mapping(address => bool) public locked;
  mapping(address => bool) public exiting;
  uint256 public totalDeposits;
  function deposit() external payable {
    require(!locked[msg.sender], "locked");
    balances[msg.sender] += msg.value;
    totalDeposits += msg.value;
  }
  function lock() external {
    require(balances[msg.sender] > 0, "empty");
    locked[msg.sender] = true;
  }
  function requestExit() external {
    require(locked[msg.sender], "not locked");
    exiting[msg.sender] = true;
  }
  function exit() external {
    require(exiting[msg.sender], "not exiting");
    uint256 a = balances[msg.sender];
    balances[msg.sender] = 0;
    totalDeposits -= a;
    locked[msg.sender] = false;
    exiting[msg.sender] = false;
    payable(msg.sender).transfer(a);
  }
}
