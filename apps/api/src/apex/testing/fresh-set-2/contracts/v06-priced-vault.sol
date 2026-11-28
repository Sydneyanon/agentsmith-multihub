pragma solidity ^0.8.20;
contract PricedVault {
  address public owner;
  mapping(address => uint256) public shares;
  uint256 public totalShares;
  uint256 public totalAssets;
  constructor() { owner = msg.sender; }
  function deposit() external payable {
    uint256 s = totalShares == 0 ? msg.value : msg.value * totalShares / totalAssets;
    require(s > 0, "zero shares");
    shares[msg.sender] += s;
    totalShares += s;
    totalAssets += msg.value;
  }
  function harvest() external payable {
    require(msg.sender == owner, "owner");
    require(totalShares > 0, "empty");
    totalAssets += msg.value;
  }
  function redeem(uint256 s) external {
    uint256 a = s * totalAssets / totalShares;
    shares[msg.sender] -= s;
    totalShares -= a;
    totalAssets -= a;
    payable(msg.sender).transfer(a);
  }
}
