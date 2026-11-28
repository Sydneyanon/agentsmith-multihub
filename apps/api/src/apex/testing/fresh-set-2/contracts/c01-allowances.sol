pragma solidity ^0.8.20;
contract Allowances {
  address public owner;
  mapping(address => uint256) public owed;
  uint256 public budget;
  uint256 public totalCollected;
  constructor() { owner = msg.sender; }
  function fund() external payable {
    require(msg.sender == owner, "owner");
    budget += msg.value;
  }
  function allot(address to, uint256 amount) external {
    require(msg.sender == owner, "owner");
    budget -= amount;
    owed[to] += amount;
  }
  function collect() external {
    uint256 a = owed[msg.sender];
    require(a > 0, "nothing");
    owed[msg.sender] = 0;
    totalCollected += a;
    payable(msg.sender).transfer(a);
  }
}
