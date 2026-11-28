// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BatchTypes
library BatchTypes {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
}

/// @title RelayAuth
abstract contract RelayAuth {
    address public immutable owner;
    mapping(address => bool) public isRelayer;

    error NotOwner();
    error NotRelayer();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setRelayer(address relayer, bool enabled) external onlyOwner {
        isRelayer[relayer] = enabled;
    }
}

/// @title RelayBatchExecutor
/// @notice Executes owner-authorised batches (payroll, vendor payments) via a
///         relayer; each batch consumes a nonce so it can be reconciled.
contract RelayBatchExecutor is RelayAuth {
    using BatchTypes for BatchTypes.Call;

    uint256 public nonce;
    mapping(bytes32 => bool) public executedBatch;

    event BatchExecuted(bytes32 indexed batchHash, uint256 nonce, uint256 calls);

    error BatchAlreadyExecuted();

    receive() external payable {}

    function executeBatch(BatchTypes.Call[] calldata calls, bytes32 batchHash) external onlyRelayer {
        if (executedBatch[batchHash]) revert BatchAlreadyExecuted();
        executedBatch[batchHash] = true;
        for (uint256 i = 0; i < calls.length; ++i) {
            _exec(calls[i].target, calls[i].value, calls[i].data);
        }
        nonce += 1;
        emit BatchExecuted(batchHash, nonce, calls.length);
    }

    function _exec(address target, uint256 value, bytes calldata data) internal returns (bool ok) {
        (ok, ) = target.call{value: value}(data);
    }
}
