pragma solidity ^0.8.20;
contract DonationShares {
  mapping(address => uint256) public shares;
  uint256 public totalShares;
  uint256 public totalAssets;
  function deposit() external payable {
    uint256 s = totalShares == 0 ? msg.value : msg.value * totalShares / totalAssets;
    require(s > 0, "zero shares");
    require(totalShares > 0 || msg.value >= 1 ether, "seed");
    shares[msg.sender] += s;
    totalShares += s;
    totalAssets += msg.value;
  }
  function donate() external payable {
    require(totalShares >= 1 ether, "thin");
    require(msg.value <= totalAssets, "too large");
    totalAssets += msg.value;
  }
  function redeem(uint256 s) external {
    uint256 a = s * totalAssets / totalShares;
    shares[msg.sender] -= s;
    totalShares -= s;
    totalAssets -= a;
    payable(msg.sender).transfer(a);
  }
}
