pragma solidity ^0.8.20;
contract Toggle {
  bool public a;
  uint256 public n;
  function flip() external {
    a = !a;
  }
  function bump() external {
    require(a, "off");
    require(n < 2, "cap");
    n += 1;
  }
  function clear() external {
    require(n == 2, "low");
    n = 0;
    a = false;
  }
}
