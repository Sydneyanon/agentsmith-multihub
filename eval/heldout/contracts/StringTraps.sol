// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Notes: do not call selfdestruct(x); do not use tx.origin; { braces } and ; are fine in text.
 */
contract StringTraps {
    string public constant HELP = "owner.call{value: 1}(\"\"); is risky; so is delegatecall(data);";
    uint256 public counter;

    // (bool ok, ) = msg.sender.call{value: 1}("");
    /* selfdestruct(payable(msg.sender)); */
    function describe() external pure returns (string memory) {
        return "tx.origin; selfdestruct(payable(x)); target.call(data); }";
    }

    function bump() external {
        counter += 1;
    }
}
