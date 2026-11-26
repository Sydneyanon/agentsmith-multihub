// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract InitFeeB {
    address public admin;
    uint256 public feeBps;
    bool private _done;

    event Setup(address admin, uint256 feeBps);

    modifier initializer() {
        require(!_done, "done");
        _done = true;
        _;
    }

    function initialize(
        address admin_,
        uint256 feeBps_
    ) public initializer {
        admin = admin_;
        feeBps = feeBps_;
        emit Setup(admin_, feeBps_);
    }

    function currentFee() external view returns (uint256) {
        return feeBps;
    }
}
