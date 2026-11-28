pragma solidity ^0.8.20;
contract Auction {
  address public owner;
  address public highestBidder;
  uint256 public highestBid;
  bool public ended;
  mapping(address => uint256) public pendingReturns;
  constructor() { owner = msg.sender; }
  function bid() external payable {
    require(!ended, "ended");
    require(msg.value > highestBid, "low");
    if (highestBid > 0) {
      pendingReturns[highestBidder] += highestBid;
    }
    highestBidder = msg.sender;
    highestBid = msg.value;
  }
  function withdrawRefund() external {
    uint256 a = pendingReturns[msg.sender];
    require(a > 0, "none");
    payable(msg.sender).transfer(a);
  }
  function end() external {
    require(msg.sender == owner, "owner");
    require(!ended, "ended");
    ended = true;
    payable(owner).transfer(highestBid);
  }
}
