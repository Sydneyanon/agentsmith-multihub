// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DustSweeper
/// @notice Single-use contract created by the factory to push ETH to a
///         recipient that rejects plain transfers; it never persists.
contract DustSweeper {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}

/// @title SweepFactory
/// @notice Forces small ETH balances onto recipients (e.g. contracts without a
///         receive function) when settling dust.
contract SweepFactory {
    address public immutable operator;

    event Swept(address indexed recipient, uint256 amount);

    error NotOperator();

    constructor() {
        operator = msg.sender;
    }

    receive() external payable {}

    function sweepTo(address payable recipient, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        new DustSweeper{value: amount}(recipient);
        emit Swept(recipient, amount);
    }
}
