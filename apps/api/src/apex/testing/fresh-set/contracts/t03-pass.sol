pragma solidity ^0.8.20;
contract Pass {
  mapping(address => uint256) public bal;
  mapping(address => bool) public minted;
  function mint() external {
    require(!minted[msg.sender], "once");
    minted[msg.sender] = true;
    bal[msg.sender] += 1 ether;
  }
  function give(address to, uint256 a) external {
    require(bal[msg.sender] >= a, "funds");
    bal[msg.sender] -= a;
    bal[to] += a;
  }
}
