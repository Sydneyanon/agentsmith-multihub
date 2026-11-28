pragma solidity ^0.8.20;
contract Lap {
  uint256 public lap;
  function tick() external {
    require(lap < 3, "full");
    lap += 1;
  }
  function clear() external {
    require(lap == 3, "early");
    lap = 0;
  }
}
