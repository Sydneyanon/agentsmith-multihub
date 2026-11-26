// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcImmutable {
    address public immutable implementation;

    constructor(address impl) {
        implementation = impl;
    }

    fallback() external payable {
        (bool ok, bytes memory ret) = implementation.delegatecall(msg.data);
        require(ok, "delegate failed");
        assembly {
            return(add(ret, 32), mload(ret))
        }
    }

    receive() external payable {}
}
