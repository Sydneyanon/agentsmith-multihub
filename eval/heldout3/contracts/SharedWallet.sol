// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WalletLibrary
/// @notice Shared logic for lightweight wallets; executed via delegatecall so
///         every wallet keeps its own storage.
contract WalletLibrary {
    address public owner;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public lastDay;

    event OwnerSet(address indexed owner);
    event Sent(address indexed to, uint256 value);

    error NotOwner();
    error OverLimit();
    error SendFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function initWallet(address owner_, uint256 limit) external {
        owner = owner_;
        dailyLimit = limit;
        emit OwnerSet(owner_);
    }

    function spend(address payable to, uint256 value) external onlyOwner {
        uint256 today = block.timestamp / 1 days;
        if (today > lastDay) {
            lastDay = today;
            spentToday = 0;
        }
        if (spentToday + value > dailyLimit) revert OverLimit();
        spentToday += value;
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert SendFailed();
        emit Sent(to, value);
    }
}

/// @title SharedWallet
/// @notice Thin wallet that forwards every call to the shared library.
contract SharedWallet {
    address public owner;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public lastDay;
    address public immutable walletLibrary;

    error LibraryCallFailed();

    constructor(address library_, address owner_, uint256 limit) {
        walletLibrary = library_;
        (bool ok, ) = library_.delegatecall(abi.encodeCall(WalletLibrary.initWallet, (owner_, limit)));
        if (!ok) revert LibraryCallFailed();
    }

    receive() external payable {}

    fallback() external payable {
        (bool ok, bytes memory ret) = walletLibrary.delegatecall(msg.data);
        if (!ok) revert LibraryCallFailed();
        assembly {
            return(add(ret, 32), mload(ret))
        }
    }
}
