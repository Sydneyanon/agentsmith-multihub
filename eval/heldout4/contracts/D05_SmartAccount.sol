// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SmartAccount {
    address public owner;
    uint256 public nonce;
    mapping(address => bool) public trustedModule;

    event Executed(address indexed target, uint256 value, bytes data);
    event ModuleExecuted(address indexed module, bytes data);
    event ModuleTrusted(address indexed module, bool trusted);

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "account: not owner");
        _;
    }

    receive() external payable {}

    function setModule(address module, bool trusted) external onlyOwner {
        trustedModule[module] = trusted;
        emit ModuleTrusted(module, trusted);
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        nonce++;
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "call failed");
        emit Executed(target, value, data);
        return ret;
    }

    function executeModule(address module, bytes calldata data) external onlyOwner returns (bytes memory) {
        require(trustedModule[module], "module not trusted");
        nonce++;
        (bool ok, bytes memory ret) = module.delegatecall(data);
        require(ok, "module failed");
        emit ModuleExecuted(module, data);
        return ret;
    }
}

contract RecoveryModule {
    address public owner;

    function rotateOwner(address next) external {
        require(next != address(0), "zero");
        owner = next;
    }
}
