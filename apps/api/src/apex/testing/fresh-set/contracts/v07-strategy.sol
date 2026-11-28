pragma solidity ^0.8.20;
contract Strategy {
  address public owner;
  mapping(address => uint256) public balances;
  uint256 public idle;
  uint256 public invested;
  constructor() { owner = msg.sender; }
  function deposit() external payable {
    balances[msg.sender] += msg.value;
    idle += msg.value;
  }
  function invest(uint256 amount) external {
    require(msg.sender == owner, "owner");
    idle -= amount;
    invested += amount;
  }
  function divest(uint256 amount) external {
    require(msg.sender == owner, "owner");
    invested -= amount;
    idle += amount;
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    if (idle >= amount) {
      idle -= amount;
    } else {
      idle = 0;
    }
    payable(msg.sender).transfer(amount);
  }
}
