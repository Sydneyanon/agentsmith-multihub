// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SdB {
    address public owner;

    event Closing(address indexed beneficiary);

    modifier onlyBy(address who) {
        require(msg.sender == who, "denied");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function shutdown(address payable beneficiary) external onlyBy(owner) {
        emit Closing(beneficiary);
        selfdestruct(beneficiary);
    }
}
