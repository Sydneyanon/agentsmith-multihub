// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/IERC20.sol";

interface IVm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}

contract MockERC20 is IERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(string memory n) { name = n; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allow");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        require(balanceOf[from] >= amount, "bal");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice ERC20 whose transfer to a specific blocked recipient fails (returns false/reverts).
contract BlockingERC20 is MockERC20 {
    address public blocked;
    bool public revertOnBlocked; // true => revert, false => return false

    constructor(string memory n, address blocked_, bool revert_) MockERC20(n) {
        blocked = blocked_;
        revertOnBlocked = revert_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == blocked) {
            if (revertOnBlocked) revert("blocked recipient");
            return false;
        }
        return super.transfer(to, amount);
    }
}
