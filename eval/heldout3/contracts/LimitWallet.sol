// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LimitWalletLogic
/// @notice Shared logic for lightweight wallets; executed via delegatecall so
///         every wallet keeps its own storage.
contract LimitWalletLogic {
    address public owner;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public lastDay;

    event OwnerSet(address indexed owner);
    event Sent(address indexed to, uint256 value);

    error NotOwner();
    error AlreadyInitialized();
    error OverLimit();
    error SendFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function initWallet(address owner_, uint256 limit) external {
        if (owner != address(0)) revert AlreadyInitialized();
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

/// @title LimitWallet
/// @notice Thin wallet that forwards spending calls to the shared logic.
contract LimitWallet {
    address public owner;
    uint256 public dailyLimit;
    uint256 public spentToday;
    uint256 public lastDay;
    address public immutable logic;

    error LogicCallFailed();
    error UnsupportedSelector(bytes4 selector);

    constructor(address logic_, address owner_, uint256 limit) {
        logic = logic_;
        (bool ok, ) = logic_.delegatecall(abi.encodeCall(LimitWalletLogic.initWallet, (owner_, limit)));
        if (!ok) revert LogicCallFailed();
    }

    receive() external payable {}

    fallback() external payable {
        if (msg.sig != LimitWalletLogic.spend.selector) revert UnsupportedSelector(msg.sig);
        (bool ok, bytes memory ret) = logic.delegatecall(msg.data);
        if (!ok) revert LogicCallFailed();
        assembly {
            return(add(ret, 32), mload(ret))
        }
    }
}
