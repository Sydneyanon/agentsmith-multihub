// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PayoutOwner
abstract contract PayoutOwner {
    address public immutable owner;
    mapping(address => bool) public isOperator;

    error Unauthorized();

    constructor(address owner_) {
        owner = owner_;
    }

    function _checkOwnerOrOperator() internal view virtual;
}

/// @title PayoutWalletV2
/// @notice Owner wallet; helper contracts (batchers, schedulers) must be
///         registered as operators by the owner.
contract PayoutWalletV2 is PayoutOwner {
    event Paid(address indexed to, uint256 amount);
    event OperatorSet(address indexed operator, bool enabled);

    error SendFailed();

    constructor(address owner_) PayoutOwner(owner_) {}

    receive() external payable {}

    function setOperator(address operator, bool enabled) external {
        if (msg.sender != owner) revert Unauthorized();
        isOperator[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    function pay(address payable to, uint256 amount) external {
        _checkOwnerOrOperator();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SendFailed();
        emit Paid(to, amount);
    }

    function _checkOwnerOrOperator() internal view override {
        if (msg.sender != owner && !isOperator[msg.sender]) revert Unauthorized();
    }
}
