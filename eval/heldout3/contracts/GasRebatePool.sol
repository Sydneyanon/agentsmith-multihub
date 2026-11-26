// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RebateConfig
abstract contract RebateConfig {
    address public owner;
    uint256 public rebatePerSettle;

    event RebateUpdated(uint256 amount);

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }
}

/// @title GasRebatePool
/// @notice Keepers settle matured orders and are refunded a flat gas rebate,
///         paid to the account that signed the transaction so that keepers
///         operating through relay contracts are still reimbursed.
contract GasRebatePool is RebateConfig {
    mapping(uint256 => bool) public settled;
    mapping(uint256 => uint256) public maturity;

    event OrderSettled(uint256 indexed id, address indexed keeper);

    error NotMatured();
    error AlreadySettled();

    receive() external payable {}

    function registerOrder(uint256 id, uint256 maturesAt) external {
        if (maturity[id] == 0) {
            maturity[id] = maturesAt;
        }
    }

    function settle(uint256 id) external {
        if (settled[id]) revert AlreadySettled();
        if (maturity[id] == 0 || block.timestamp < maturity[id]) revert NotMatured();
        settled[id] = true;
        emit OrderSettled(id, tx.origin);
        payable(tx.origin).transfer(rebatePerSettle);
    }

    /// @notice Owner tunes the rebate; the ops console calls this via a relay.
    function setRebate(uint256 amount) external {
        if (tx.origin != owner && msg.sender != owner) revert NotOwner();
        rebatePerSettle = amount;
        emit RebateUpdated(amount);
    }
}
