pragma solidity ^0.8.20;
contract RebasePool {
  address public owner;
  mapping(address => uint256) public stakes;
  uint256 public totalStaked;
  constructor() { owner = msg.sender; }
  function stake() external payable {
    stakes[msg.sender] += msg.value;
    totalStaked += msg.value;
  }
  function rebase() external payable {
    require(msg.sender == owner, "owner");
    require(totalStaked > 0, "empty");
    totalStaked += msg.value;
  }
  function unstake(uint256 amount) external {
    uint256 s = stakes[msg.sender];
    require(amount <= s, "too much");
    if (amount == s) {
      stakes[msg.sender] = 0;
    } else {
      stakes[msg.sender] = s - amount;
      totalStaked -= amount;
    }
    payable(msg.sender).transfer(amount);
  }
}
