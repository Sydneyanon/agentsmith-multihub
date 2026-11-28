pragma solidity ^0.8.20;
contract Cooldown {
  mapping(address => uint256) public staked;
  mapping(address => uint256) public cooling;
  mapping(address => uint256) public waited;
  uint256 public totalStaked;
  uint256 public totalCooling;
  function stake() external payable {
    staked[msg.sender] += msg.value;
    totalStaked += msg.value;
  }
  function requestUnstake(uint256 amount) external {
    staked[msg.sender] -= amount;
    totalStaked -= amount;
    cooling[msg.sender] += amount;
    totalCooling += amount;
    waited[msg.sender] = 0;
  }
  function wait() external {
    require(cooling[msg.sender] > 0, "idle");
    waited[msg.sender] += 1;
  }
  function cancel() external {
    uint256 c = cooling[msg.sender];
    require(c > 0, "idle");
    cooling[msg.sender] = 0;
    staked[msg.sender] += c;
    totalStaked += c;
  }
  function complete() external {
    require(waited[msg.sender] >= 2, "cooldown");
    uint256 c = cooling[msg.sender];
    cooling[msg.sender] = 0;
    totalCooling -= c;
    payable(msg.sender).transfer(c);
  }
}
