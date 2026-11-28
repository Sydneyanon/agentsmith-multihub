// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InitFeeA {
    address public admin;
    uint256 public feeBps;

    event Setup(address admin, uint256 feeBps);

    function initialize(
        address admin_,
        uint256 feeBps_
    ) public {
        admin = admin_;
        feeBps = feeBps_;
        emit Setup(admin_, feeBps_);
    }

    function currentFee() external view returns (uint256) {
        return feeBps;
    }
}
