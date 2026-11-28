pragma solidity ^0.8.20;
contract Rebate {
  address public owner;
  mapping(address => uint256) public balances;
  uint256 public totalDeposited;
  uint256 public totalWithdrawn;
  uint256 public rebatePool;
  constructor() { owner = msg.sender; }
  function deposit() external payable {
    balances[msg.sender] += msg.value;
    totalDeposited += msg.value;
  }
  function fundRebates() external payable {
    require(msg.sender == owner, "owner");
    rebatePool += msg.value;
  }
  function grant(address to, uint256 amount) external {
    require(msg.sender == owner, "owner");
    rebatePool -= amount;
    balances[to] += amount;
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    totalWithdrawn += amount;
    payable(msg.sender).transfer(amount);
  }
}
