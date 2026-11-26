// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract WalletLibrary {
    bool internal initialized;
    uint256 public required;
    address[] public owners;
    mapping(address => bool) public isOwner;
    mapping(bytes32 => uint256) public confirmations;
    mapping(bytes32 => mapping(address => bool)) public confirmedBy;

    event Confirmation(address indexed owner, bytes32 indexed operation);
    event Execution(bytes32 indexed operation, address to, uint256 value);

    constructor() {
        initialized = true;
    }

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not an owner");
        _;
    }

    modifier onlyManyOwners(bytes32 operation) {
        if (!confirmedBy[operation][msg.sender]) {
            confirmedBy[operation][msg.sender] = true;
            confirmations[operation]++;
            emit Confirmation(msg.sender, operation);
        }
        if (confirmations[operation] >= required) {
            _;
        }
    }

    function initWallet(address[] memory owners_, uint256 required_) public {
        require(!initialized, "already initialized");
        require(required_ > 0 && required_ <= owners_.length, "bad threshold");
        initialized = true;
        for (uint256 i = 0; i < owners_.length; i++) {
            owners.push(owners_[i]);
            isOwner[owners_[i]] = true;
        }
        required = required_;
    }

    function execute(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        onlyManyOwners(keccak256(abi.encode(to, value, data)))
    {
        (bool ok, ) = to.call{value: value}(data);
        require(ok, "execution failed");
        emit Execution(keccak256(abi.encode(to, value, data)), to, value);
    }

    function kill(address payable to) external onlyOwner {
        selfdestruct(to);
    }
}

contract Wallet {
    address public immutable walletLibrary;

    constructor(address lib, address[] memory owners_, uint256 required_) {
        walletLibrary = lib;
        (bool ok, ) = lib.delegatecall(abi.encodeWithSelector(WalletLibrary.initWallet.selector, owners_, required_));
        require(ok, "init failed");
    }

    receive() external payable {}

    fallback() external payable {
        address impl = walletLibrary;
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
