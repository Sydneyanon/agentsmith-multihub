// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Expiry {
    address public immutable factory;
    address payable public immutable treasury;
    uint256 public immutable deadline;

    constructor(address payable t, uint256 d) {
        factory = msg.sender;
        treasury = t;
        deadline = d;
    }

    receive() external payable {}

    function expire() external {
        require(block.timestamp > deadline, "early");
        selfdestruct(treasury);
    }

    function retire() external {
        require(msg.sender == factory, "factory");
        selfdestruct(treasury);
    }

    function finish() external {
        require(msg.sender == address(this), "self");
        selfdestruct(treasury);
    }
}
