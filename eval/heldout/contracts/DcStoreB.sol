// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DcStoreB {
    address public owner;
    address public logic;

    event LogicChanged(address indexed logic);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address initialLogic) {
        owner = msg.sender;
        logic = initialLogic;
    }

    function setLogic(address newLogic) external onlyOwner {
        logic = newLogic;
        emit LogicChanged(newLogic);
    }

    function forward(bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = logic.delegatecall(data);
        require(ok, "forward failed");
        return ret;
    }
}
