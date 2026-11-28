// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Exec {
    function run(address t, bytes memory d) internal returns (bytes memory) {
        (bool ok, bytes memory r) = t.delegatecall(d);
        require(ok, "exec");
        return r;
    }
}

contract Module {
    address public immutable base;

    constructor(address b) {
        base = b;
    }

    function runCustom(address t, bytes calldata d) external returns (bytes memory) {
        return Exec.run(t, d);
    }

    function runBase(bytes calldata d) external returns (bytes memory) {
        return Exec.run(base, d);
    }
}
