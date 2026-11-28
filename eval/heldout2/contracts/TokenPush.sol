// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TokenPush {
    function _exec(address t, bytes memory d) internal {
        (bool ok, ) = t.call(d);
        if (!ok) revert("exec");
    }

    function pushRaw(address token, address to, uint256 amt) external {
        token.call(abi.encodeWithSelector(0xa9059cbb, to, amt));
    }

    function pushChecked(address token, address to, uint256 amt) external {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amt));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "tf");
    }

    function pushViaHelper(address token, address to, uint256 amt) external {
        _exec(token, abi.encodeWithSelector(0xa9059cbb, to, amt));
    }

    function probe(address hook, bytes calldata d) external view {
        hook.staticcall(d);
    }
}
