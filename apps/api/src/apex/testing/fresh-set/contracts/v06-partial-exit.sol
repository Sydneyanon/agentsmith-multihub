pragma solidity ^0.8.20;
contract PartialExit {
  mapping(address => uint256) public balances;
  uint256 public totalDeposits;
  uint256 public fees;
  function deposit() external payable {
    uint256 fee = msg.value / 100;
    balances[msg.sender] += msg.value - fee;
    totalDeposits += msg.value - fee;
    fees += fee;
  }
  function withdraw(uint256 amount) external {
    require(amount > 0, "zero");
    if (amount == balances[msg.sender]) {
      balances[msg.sender] = 0;
    } else {
      balances[msg.sender] -= amount;
      totalDeposits -= amount;
    }
    payable(msg.sender).transfer(amount);
  }
}
