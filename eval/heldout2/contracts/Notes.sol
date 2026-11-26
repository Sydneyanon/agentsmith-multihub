// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Notes {
    string public constant DOC =
        "never delegatecall to unknown code; call onlyOwner paths only; tx.origin is not auth; selfdestruct is rare";

    event Logged(string what);

    // a plain delegatecall mention in a comment: x.delegatecall(data) is not executed here
    function describe() external pure returns (string memory) {
        return "delegatecall selfdestruct tx.origin";
    }

    function log(string calldata s) external {
        emit Logged(s);
    }
}
