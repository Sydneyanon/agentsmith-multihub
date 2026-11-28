pragma solidity ^0.8.20;
contract Faucet {
  address public owner;
  mapping(address => uint256) public dripped;
  uint256 public totalDripped;
  uint256 public constant DRIP = 1 ether / 10;
  uint256 public constant LIMIT = 3 ether / 10;
  constructor() { owner = msg.sender; }
  function fill() external payable {
    require(msg.sender == owner, "owner");
  }
  function drip() external {
    require(dripped[msg.sender] + DRIP <= LIMIT, "limit");
    require(address(this).balance >= DRIP, "dry");
    dripped[msg.sender] += DRIP;
    totalDripped += DRIP;
    payable(msg.sender).transfer(DRIP);
  }
}
