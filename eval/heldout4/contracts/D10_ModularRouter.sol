// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ModularRouterStorage {
    address public owner;
    mapping(bytes4 => address) public moduleFor;
    uint256 public totalVolume;
}

contract ModularRouter is ModularRouterStorage {
    event ModuleSet(bytes4 indexed selector, address indexed module);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "router: not owner");
        _;
    }

    function setModule(bytes4 selector, address module) external {
        moduleFor[selector] = module;
        emit ModuleSet(selector, module);
    }

    function setModules(bytes4[] calldata selectors, address module) external onlyOwner {
        for (uint256 i = 0; i < selectors.length; i++) {
            moduleFor[selectors[i]] = module;
            emit ModuleSet(selectors[i], module);
        }
    }

    receive() external payable {}

    fallback() external payable {
        address impl = moduleFor[msg.sig];
        require(impl != address(0), "router: unknown selector");
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}

contract SwapModule is ModularRouterStorage {
    function recordSwap(uint256 amount) external {
        totalVolume += amount;
    }
}
