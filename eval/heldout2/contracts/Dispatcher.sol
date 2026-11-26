// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Dispatcher {
    error CallFailed();

    function ping(address t, bytes calldata d) external {
        (bool ok, ) = t.call(d);
        if (!ok) revert CallFailed();
    }
}
