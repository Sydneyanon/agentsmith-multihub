pragma solidity ^0.8.20;
contract Treasury {
  address public owner;
  mapping(address => uint256) public balances;
  uint256 public totalDeposited;
  uint256 public totalWithdrawn;
  uint256 public reserve;
  constructor() { owner = msg.sender; }
  function fund() external payable {
    require(msg.sender == owner, "owner");
    reserve += msg.value;
  }
  function credit(address to, uint256 amount) external {
    require(msg.sender == owner, "owner");
    reserve -= amount;
    balances[to] += amount;
  }
  function deposit() external payable {
    balances[msg.sender] += msg.value;
    totalDeposited += msg.value;
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    totalWithdrawn += amount;
    payable(msg.sender).transfer(amount);
  }
  function withdrawAll() external {
    uint256 a = balances[msg.sender];
    balances[msg.sender] = 0;
    totalWithdrawn += a;
    payable(msg.sender).transfer(a);
  }
}
