pragma solidity ^0.8.20;
contract StartVault {
  address public owner;
  bool public live;
  mapping(address => uint256) public balances;
  uint256 public totalDeposits;
  constructor() { owner = msg.sender; }
  function start() external {
    require(msg.sender == owner, "owner");
    live = true;
  }
  function deposit() external payable {
    balances[msg.sender] += msg.value;
    totalDeposits += msg.value;
  }
  function exit() external {
    require(live, "not live");
    uint256 a = balances[msg.sender];
    require(a > 0, "empty");
    balances[msg.sender] = 0;
    totalDeposits -= a;
    payable(msg.sender).transfer(a);
  }
}
