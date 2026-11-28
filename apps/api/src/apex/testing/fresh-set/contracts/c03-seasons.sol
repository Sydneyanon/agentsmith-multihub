pragma solidity ^0.8.20;
contract Seasons {
  uint256 public season;
  uint256 public year;
  uint256 public entries;
  function enter() external {
    require(season < 2, "closed");
    entries += 1;
  }
  function advance() external {
    require(season < 2, "last");
    season += 1;
  }
  function rollover() external {
    require(season == 2, "early");
    require(year < 50, "end");
    season = 0;
    year += 1;
    entries = 0;
  }
}
