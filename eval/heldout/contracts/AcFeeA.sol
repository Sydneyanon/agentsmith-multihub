// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AcFeeA {
    address public owner;
    uint256 public feeBps;

    event FeeUpdated(uint256 oldFee, uint256 newFee);

    constructor() {
        owner = msg.sender;
        feeBps = 30;
    }

    function setFee(uint256 newFee) external {
        require(newFee <= 1000, "fee too high");
        emit FeeUpdated(feeBps, newFee);
        feeBps = newFee;
    }

    function quote(uint256 amount) external view returns (uint256) {
        return (amount * feeBps) / 10_000;
    }
}
