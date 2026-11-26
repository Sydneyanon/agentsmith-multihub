// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Caller {
    event Done(address target, bool ok);

    function ping(address t, bytes calldata d) external {
        (bool ok, ) = t.call(d);
    }

    function pingLogged(address t, bytes calldata d) external {
        (bool ok, ) = t.call(d);
        emit Done(t, ok);
    }
}
