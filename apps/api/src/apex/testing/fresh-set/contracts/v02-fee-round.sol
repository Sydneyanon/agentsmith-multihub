pragma solidity ^0.8.20;
contract FeeRound {
  address public owner;
  address public treasury;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  uint256 public constant FEE_BPS = 30;
  uint256 public constant BPS = 10000;
  constructor() { owner = msg.sender; treasury = msg.sender; }
  function mint(address to, uint256 amount) external {
    require(msg.sender == owner, "owner");
    balanceOf[to] += amount;
    totalSupply += amount;
  }
  function transfer(address to, uint256 amount) external {
    uint256 fee = amount * FEE_BPS / BPS;
    uint256 treasuryCut = (amount * FEE_BPS + BPS - 1) / BPS;
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount - fee;
    balanceOf[treasury] += treasuryCut;
  }
}
