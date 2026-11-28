pragma solidity ^0.8.20;
contract Steps {
  uint256 public s;
  bool public ok;
  function a() external {
    require(s == 0, "s");
    s = 1;
  }
  function b() external {
    require(s == 1, "s");
    s = 2;
  }
  function c(bool x) external {
    require(s == 2, "s");
    if (x) {
      s = 3;
      ok = true;
    } else {
      s = 0;
    }
  }
  function d() external payable {
    require(s == 3, "s");
    require(msg.value > 0, "v");
    s = 4;
  }
}
