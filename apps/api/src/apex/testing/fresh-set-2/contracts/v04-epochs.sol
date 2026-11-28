pragma solidity ^0.8.20;
contract Epochs {
  address public owner;
  uint256 public stage;
  uint256 public epoch;
  constructor() { owner = msg.sender; }
  function step() external {
    require(stage < 3, "done");
    stage += 1;
  }
  function finish() external {
    require(stage == 3, "early");
    stage = 0;
    epoch += 1;
  }
  function abort() external {
    require(stage > 0, "idle");
    stage = 0;
    epoch += 1;
  }
}
