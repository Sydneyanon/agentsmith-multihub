// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Guarded {
    address internal admin;

    error Unauthorized();

    constructor() {
        admin = msg.sender;
    }

    function _checkAdmin() internal view {
        if (msg.sender != admin) revert Unauthorized();
    }
}

contract SdRole is Guarded {
    event Closing(address indexed beneficiary);

    function shutdown(address payable beneficiary) external {
        _checkAdmin();
        emit Closing(beneficiary);
        selfdestruct(beneficiary);
    }
}
