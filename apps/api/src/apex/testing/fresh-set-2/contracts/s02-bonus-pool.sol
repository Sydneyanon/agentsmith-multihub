pragma solidity ^0.8.20;
contract BonusPool {
  address public owner;
  mapping(address => uint256) public balances;
  mapping(address => bool) public claimed;
  uint256 public pool;
  uint256 public constant BONUS = 1 ether / 10;
  constructor() { owner = msg.sender; }
  function fund() external payable {
    require(msg.sender == owner, "owner");
    pool += msg.value;
  }
  function deposit() external payable {
    balances[msg.sender] += msg.value;
  }
  function claim() external {
    require(balances[msg.sender] > 0, "no deposit");
    require(!claimed[msg.sender], "claimed");
    require(pool >= BONUS, "empty");
    claimed[msg.sender] = true;
    pool -= BONUS;
    balances[msg.sender] += BONUS;
  }
  function withdraw(uint256 amount) external {
    balances[msg.sender] -= amount;
    payable(msg.sender).transfer(amount);
  }
}
