// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcStoreA {
    address public owner;
    address public logic;

    event LogicChanged(address indexed logic);

    constructor(address initialLogic) {
        owner = msg.sender;
        logic = initialLogic;
    }

    function setLogic(address newLogic) external {
        logic = newLogic;
        emit LogicChanged(newLogic);
    }

    function forward(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = logic.delegatecall(data);
        require(ok, "forward failed");
        return ret;
    }
}
