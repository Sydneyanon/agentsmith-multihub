// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error Denied();

library Auth {
    function enforce(address who, address expected) internal pure {
        if (who != expected) revert Denied();
    }

    function matches(address who, address expected) internal pure returns (bool) {
        return who == expected;
    }
}

contract Tap {
    address public steward;
    uint256 public flow;

    constructor() {
        steward = msg.sender;
    }

    function setFlow(uint256 f) external {
        Auth.enforce(msg.sender, steward);
        flow = f;
    }

    function setSteward(address s) external {
        steward = s;
    }

    function setFlowLoose(uint256 f) external {
        Auth.matches(msg.sender, steward);
        flow = f;
    }
}
