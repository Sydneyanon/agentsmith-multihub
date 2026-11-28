// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FairLaunch {
    uint256 public constant PRICE = 0.01 ether;
    uint256 public constant MAX_PER_TX = 5;

    address public immutable beneficiary;
    uint256 public sold;
    uint256 public immutable cap;
    mapping(address => uint256) public purchased;

    event Purchased(address indexed buyer, uint256 units);

    constructor(address beneficiary_, uint256 cap_) {
        beneficiary = beneficiary_;
        cap = cap_;
    }

    modifier callerIsUser() {
        require(tx.origin == msg.sender, "contracts not allowed");
        _;
    }

    function buy(uint256 units) external payable callerIsUser {
        require(units > 0 && units <= MAX_PER_TX, "units");
        require(msg.value == units * PRICE, "price");
        require(sold + units <= cap, "cap");
        sold += units;
        purchased[msg.sender] += units;
        emit Purchased(msg.sender, units);
    }

    function withdraw() external {
        require(msg.sender == beneficiary, "beneficiary");
        (bool ok, ) = beneficiary.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
