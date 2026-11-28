pragma solidity ^0.8.20;
contract InflationVault {
  mapping(address => uint256) public shares;
  uint256 public totalShares;
  uint256 public totalAssets;
  uint256 public surplus;
  function deposit() external payable {
    uint256 s = totalShares == 0 ? msg.value : msg.value * totalShares / totalAssets;
    shares[msg.sender] += s;
    totalShares += s;
    totalAssets += msg.value;
  }
  function donate() external payable {
    surplus += msg.value;
  }
  function withdraw(uint256 s) external {
    uint256 a = s * totalAssets / totalShares;
    shares[msg.sender] -= s;
    totalShares -= s;
    totalAssets -= a;
    payable(msg.sender).transfer(a);
  }
}
