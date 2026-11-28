pragma solidity ^0.8.20;
contract Cycle3 {
  uint256 public phase;
  uint256 public cycles;
  uint256 public marks;
  function mark() external {
    require(phase == 1, "not marking");
    require(marks < 3, "full");
    marks += 1;
  }
  function next() external {
    require(phase < 2, "last");
    phase += 1;
  }
  function wrap() external {
    require(phase == 2, "early");
    require(cycles < 40, "end");
    phase = 0;
    marks = 0;
    cycles += 1;
  }
}
