// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Relay {
    address public immutable IMPL;

    constructor(address impl) {
        IMPL = impl;
    }

    fallback() external payable {
        _go(IMPL, msg.data);
    }

    receive() external payable {}

    function exec(bytes calldata d) external returns (bytes memory) {
        return _go(IMPL, d);
    }

    function _go(address target, bytes memory d) internal returns (bytes memory) {
        return _raw(target, d);
    }

    function _raw(address target, bytes memory d) private returns (bytes memory) {
        (bool ok, bytes memory r) = target.delegatecall(d);
        require(ok, "raw");
        return r;
    }
}
