pragma solidity ^0.8.20;
contract Ballot {
  uint256 public stage;
  uint256 public tally;
  uint256 public round;
  function vote() external {
    require(stage == 0, "closed");
    require(tally < 2, "full");
    tally += 1;
  }
  function pass() external {
    require(stage == 0, "closed");
    require(tally == 2, "quorum");
    stage = 1;
  }
  function newRound() external {
    require(stage == 1, "open");
    require(round < 50, "end");
    stage = 0;
    round += 1;
    tally = 0;
  }
}
