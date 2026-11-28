pragma solidity ^0.8.20;
contract Harvester {
  address public owner;
  mapping(address => uint256) public units;
  uint256 public totalUnits;
  uint256 public managed;
  constructor() { owner = msg.sender; }
  function join() external payable {
    uint256 u = totalUnits == 0 ? msg.value : msg.value * totalUnits / managed;
    require(u > 0, "zero units");
    units[msg.sender] += u;
    totalUnits += u;
    managed += msg.value;
  }
  function addYield() external payable {
    require(msg.sender == owner, "owner");
    require(totalUnits > 0, "empty");
    managed += msg.value;
  }
  function leave(uint256 u) external {
    uint256 a = u * managed / totalUnits;
    units[msg.sender] -= u;
    totalUnits -= u;
    managed -= a;
    payable(msg.sender).transfer(a);
  }
}
