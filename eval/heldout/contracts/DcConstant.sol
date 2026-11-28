// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcConstant {
    address private constant IMPL = address(uint160(0xBEEF));
    uint256 public calls;

    event Forwarded(bytes4 selector);

    function run(bytes calldata data) external returns (bytes memory) {
        calls += 1;
        (bool ok, bytes memory ret) = IMPL.delegatecall(data);
        require(ok, "run failed");
        emit Forwarded(bytes4(data[:4]));
        return ret;
    }
}
