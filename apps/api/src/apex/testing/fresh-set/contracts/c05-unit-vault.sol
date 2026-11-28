pragma solidity ^0.8.20;
contract UnitVault {
  mapping(address => uint256) public balances;
  uint256 public totalCredited;
  uint256 public dust;
  uint256 public constant UNIT = 1 ether / 10;
  function deposit() external payable {
    uint256 credited = msg.value / UNIT * UNIT;
    balances[msg.sender] += credited;
    totalCredited += credited;
    dust += msg.value - credited;
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    totalCredited -= amount;
    payable(msg.sender).transfer(amount);
  }
}
