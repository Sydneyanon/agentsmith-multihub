// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DelayQueue
/// @notice Queue bookkeeping for delayed admin operations.
abstract contract DelayQueue {
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant GRACE_PERIOD = 14 days;

    address public admin;
    uint256 public delay;
    mapping(bytes32 => uint256) public queuedAt;

    event Queued(bytes32 indexed txHash, address target, uint256 value, bytes data, uint256 eta);
    event ExecutedTx(bytes32 indexed txHash);
    event Cancelled(bytes32 indexed txHash);
    event DelayUpdated(uint256 delay);

    error NotAdmin();
    error NotSelf();
    error NotQueued();
    error NotReady(uint256 eta);
    error Stale();
    error DelayTooShort();
    error CallReverted();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev Only reachable through a queued operation targeting this contract.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    function hashOf(address target, uint256 value, bytes calldata data, uint256 eta) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, eta));
    }
}

/// @title GovernanceTimelock
/// @notice Delays privileged protocol operations so users can exit first.
contract GovernanceTimelock is DelayQueue {
    constructor(address admin_, uint256 delay_) {
        if (delay_ < MIN_DELAY) revert DelayTooShort();
        admin = admin_;
        delay = delay_;
    }

    receive() external payable {}

    function queue(address target, uint256 value, bytes calldata data) external onlyAdmin returns (bytes32 h) {
        uint256 eta = block.timestamp + delay;
        h = hashOf(target, value, data, eta);
        queuedAt[h] = eta;
        emit Queued(h, target, value, data, eta);
    }

    function cancel(bytes32 h) external onlyAdmin {
        delete queuedAt[h];
        emit Cancelled(h);
    }

    function execute(address target, uint256 value, bytes calldata data, uint256 eta) external onlyAdmin {
        bytes32 h = hashOf(target, value, data, eta);
        if (queuedAt[h] == 0) revert NotQueued();
        if (block.timestamp < eta) revert NotReady(eta);
        if (block.timestamp > eta + GRACE_PERIOD) revert Stale();
        delete queuedAt[h];
        (bool ok, ) = target.call{value: value}(data);
        if (!ok) revert CallReverted();
        emit ExecutedTx(h);
    }

    /// @notice Change the delay applied to newly queued operations.
    function setDelay(uint256 newDelay) external onlySelf {
        if (newDelay < MIN_DELAY) revert DelayTooShort();
        delay = newDelay;
        emit DelayUpdated(newDelay);
    }
}
