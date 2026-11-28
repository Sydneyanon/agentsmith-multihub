pragma solidity ^0.8.20;
contract Membership {
  address public owner;
  mapping(address => uint256) public credit;
  uint256 public totalJoined;
  uint256 public totalLeft;
  uint256 public bonusPool;
  uint256 public constant BONUS = 1 ether / 20;
  constructor() { owner = msg.sender; }
  function fundBonus() external payable {
    require(msg.sender == owner, "owner");
    bonusPool += msg.value;
  }
  function bonus(address to) external {
    require(msg.sender == owner, "owner");
    bonusPool -= BONUS;
    credit[to] += BONUS;
  }
  function join() external payable {
    credit[msg.sender] += msg.value;
    totalJoined += msg.value;
  }
  function leave(uint256 amount) external {
    credit[msg.sender] -= amount;
    totalLeft += amount;
    payable(msg.sender).transfer(amount);
  }
}
