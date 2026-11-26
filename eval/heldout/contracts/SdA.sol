// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SdA {
    address public owner;

    event Closing(address indexed beneficiary);

    constructor() {
        owner = msg.sender;
    }

    function shutdown(address payable beneficiary) external {
        emit Closing(beneficiary);
        selfdestruct(beneficiary);
    }
}
