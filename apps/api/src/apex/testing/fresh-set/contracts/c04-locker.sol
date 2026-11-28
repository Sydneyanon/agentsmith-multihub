pragma solidity ^0.8.20;
contract Locker {
  mapping(address => uint256) public available;
  mapping(address => uint256) public locked;
  uint256 public totalHeld;
  function deposit() external payable {
    available[msg.sender] += msg.value;
    totalHeld += msg.value;
  }
  function lock(uint256 amount) external {
    available[msg.sender] -= amount;
    locked[msg.sender] += amount;
  }
  function unlock(uint256 amount) external {
    locked[msg.sender] -= amount;
    available[msg.sender] += amount;
  }
  function withdraw(uint256 amount) external {
    available[msg.sender] -= amount;
    totalHeld -= amount;
    payable(msg.sender).transfer(amount);
  }
}
