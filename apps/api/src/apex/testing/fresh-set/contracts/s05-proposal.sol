pragma solidity ^0.8.20;
contract Proposal {
  address public owner;
  uint256 public phase;
  uint256 public votes;
  mapping(address => bool) public voted;
  constructor() { owner = msg.sender; }
  function open() external {
    require(msg.sender == owner, "owner");
    require(phase == 0, "phase");
    phase = 1;
  }
  function vote() external {
    require(phase == 1, "phase");
    require(!voted[msg.sender], "voted");
    voted[msg.sender] = true;
    votes += 1;
  }
  function close() external {
    require(phase == 1, "phase");
    require(votes >= 2, "quorum");
    phase = 2;
  }
  function reopen() external {
    require(msg.sender == owner, "owner");
    require(phase == 2, "phase");
    phase = 1;
  }
  function execute() external {
    require(phase == 2, "phase");
    phase = 3;
  }
}
