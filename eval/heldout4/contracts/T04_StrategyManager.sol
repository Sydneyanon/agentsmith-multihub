// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStrategy {
    function harvest() external returns (uint256);
    function withdrawAll(address to) external;
}

abstract contract Administered {
    address public administrator;

    constructor() {
        administrator = msg.sender;
    }

    modifier onlyAdministrator() {
        require(tx.origin == administrator, "not administrator");
        _;
    }

    function handover(address next) external onlyAdministrator {
        administrator = next;
    }
}

contract StrategyManager is Administered {
    IStrategy[] public strategies;
    mapping(address => bool) public approved;

    event StrategyAdded(address indexed strategy);
    event Evacuated(address indexed strategy, address indexed to);

    function addStrategy(IStrategy s) external onlyAdministrator {
        require(!approved[address(s)], "dup");
        approved[address(s)] = true;
        strategies.push(s);
        emit StrategyAdded(address(s));
    }

    function harvestAll() external returns (uint256 total) {
        for (uint256 i = 0; i < strategies.length; i++) {
            total += strategies[i].harvest();
        }
    }

    function evacuate(uint256 index, address to) external onlyAdministrator {
        IStrategy s = strategies[index];
        s.withdrawAll(to);
        emit Evacuated(address(s), to);
    }
}
