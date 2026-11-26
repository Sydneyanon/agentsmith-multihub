// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Generic re-entering counterparty used by the ground-truth experiments. It forwards one call to a target and, from its receive and
/// fallback hooks (when enough gas is forwarded, so NOT under a 2300-gas transfer), makes up to `maxHooks` further calls, swallowing failures.
contract Attacker {
    address public target;
    bytes public again;
    uint256 public hooks;
    uint256 public maxHooks;
    uint256 public hookFailures;

    function configure(address t, bytes calldata a, uint256 m) external {
        target = t;
        again = a;
        maxHooks = m;
        hooks = 0;
        hookFailures = 0;
    }

    function exec(bytes calldata data) external payable returns (bool ok) {
        (ok, ) = target.call{value: msg.value}(data);
    }

    function _hook() internal {
        if (gasleft() > 20000 && hooks < maxHooks) {
            hooks++;
            (bool ok, ) = target.call(again);
            if (!ok) hookFailures++;
        }
    }

    receive() external payable { _hook(); }
    fallback() external payable { _hook(); }
}
