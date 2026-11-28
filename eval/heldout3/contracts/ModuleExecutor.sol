// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleStorage
/// @notice Storage layout shared with strategy modules executed in context.
abstract contract ModuleStorage {
    address public owner;
    uint256 public totalDeployed;
    mapping(address => bool) public isModule;

    event ModuleExecuted(address indexed module, bytes4 selector);
    event ModuleSet(address indexed module, bool enabled);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error UnknownModule(address module);
    error ModuleCallFailed(bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyModule(address module) {
        if (!isModule[module]) revert UnknownModule(module);
        _;
    }
}

/// @title ModuleExecutor
/// @notice Treasury that runs allow-listed strategy modules in its own context.
contract ModuleExecutor is ModuleStorage {
    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    function setModule(address module, bool enabled) external onlyOwner {
        isModule[module] = enabled;
        emit ModuleSet(module, enabled);
    }

    /// @notice Run `data` from an allow-listed `module` against treasury storage.
    function execute(address module, bytes calldata data)
        external
        payable
        onlyOwner
        onlyModule(module)
        returns (bytes memory)
    {
        return _runModule(module, data);
    }

    /// @notice Batch several calls to this contract in one transaction.
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = address(this).delegatecall(calls[i]);
            if (!ok) revert ModuleCallFailed(ret);
            results[i] = ret;
        }
    }

    function _runModule(address module, bytes calldata data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = module.delegatecall(data);
        if (!ok) revert ModuleCallFailed(result);
        emit ModuleExecuted(module, bytes4(data[:4]));
    }
}
