pragma solidity ^0.8.20;
contract TieredVault {
  mapping(address => uint256) public balances;
  uint256 public totalBalances;
  uint256 public fees;
  uint256 public constant TIER = 5 ether;
  function deposit() external payable {
    if (msg.value > TIER) {
      uint256 highFee = msg.value * 2 / 100;
      balances[msg.sender] += msg.value - highFee;
      fees += highFee;
      totalBalances += msg.value - highFee;
    } else {
      uint256 lowFee = msg.value / 100;
      balances[msg.sender] += msg.value - lowFee;
      fees += lowFee;
      totalBalances += msg.value - lowFee;
    }
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    totalBalances -= amount;
    payable(msg.sender).transfer(amount);
  }
}
