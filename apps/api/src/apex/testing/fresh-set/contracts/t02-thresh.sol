pragma solidity ^0.8.20;
contract Thresh {
  uint256 public total;
  bool public full;
  function put(uint256 a) external {
    require(a <= 2 ether, "big");
    require(total + a <= 4 ether, "cap");
    total += a;
    if (total >= 3 ether) {
      full = true;
    }
  }
  function take() external {
    require(full, "not full");
    total = 0;
    full = false;
  }
}
