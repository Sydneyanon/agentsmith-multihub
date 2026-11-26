// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Conduit {
    address public logic;
    address public admin;

    constructor(address l) {
        logic = l;
        admin = msg.sender;
    }

    function setLogic(address l) external {
        logic = l;
    }

    receive() external payable {}

    fallback() external payable {
        _run(logic);
    }

    function _run(address t) internal {
        (bool ok, bytes memory ret) = t.delegatecall(msg.data);
        require(ok, "run");
        assembly {
            return(add(ret, 32), mload(ret))
        }
    }
}
