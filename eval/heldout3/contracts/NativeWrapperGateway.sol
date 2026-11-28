// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WrappedNative
/// @notice Plain wrapped-ETH token without transfer hooks.
contract WrappedNative {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InsufficientBalance();
    error InsufficientAllowance();
    error SendFailed();

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        emit Transfer(msg.sender, address(0), amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title NativeWrapperGateway
/// @notice Convenience router that wraps and unwraps on behalf of users and
///         keeps simple usage statistics.
contract NativeWrapperGateway {
    WrappedNative public immutable wrapped;

    uint256 public totalWrapped;
    uint256 public totalUnwrapped;
    mapping(address => uint256) public unwrapCount;

    event Wrapped(address indexed to, uint256 amount);
    event Unwrapped(address indexed to, uint256 amount);

    error SendFailed();
    error PullFailed();

    constructor(WrappedNative wrapped_) {
        wrapped = wrapped_;
    }

    receive() external payable {
        if (msg.sender != address(wrapped)) revert SendFailed();
    }

    /// @notice Wrap the attached ETH and forward the tokens to `to`.
    function wrapFor(address to) external payable {
        wrapped.deposit{value: msg.value}();
        bool ok = wrapped.transfer(to, msg.value);
        if (!ok) revert PullFailed();
        totalWrapped += msg.value;
        emit Wrapped(to, msg.value);
    }

    /// @notice Pull wrapped tokens from the caller and return native ETH.
    function unwrap(uint256 amount) external {
        bool pulled = wrapped.transferFrom(msg.sender, address(this), amount);
        if (!pulled) revert PullFailed();
        wrapped.withdraw(amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
        totalUnwrapped += amount;
        unwrapCount[msg.sender] += 1;
        emit Unwrapped(msg.sender, amount);
    }
}
