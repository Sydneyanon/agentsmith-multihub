// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ExecutorStorage
/// @notice Storage layout shared with strategy modules executed in context.
abstract contract ExecutorStorage {
    address public owner;
    uint256 public totalDeployed;
    mapping(address => uint256) public deployedTo;

    event ModuleExecuted(address indexed module, bytes4 selector);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error ModuleCallFailed(bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
}

/// @title StrategyExecutor
/// @notice Treasury that runs strategy modules in its own context so modules
///         can move treasury funds directly.
contract StrategyExecutor is ExecutorStorage {
    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Run `data` from `module` against treasury storage.
    function execute(address module, bytes calldata data) external payable returns (bytes memory) {
        return _runModule(module, data);
    }

    function _runModule(address module, bytes calldata data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = module.delegatecall(data);
        if (!ok) revert ModuleCallFailed(result);
        emit ModuleExecuted(module, bytes4(data[:4]));
    }
}
