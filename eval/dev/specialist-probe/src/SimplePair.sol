// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/// @notice Minimal constant-product pair (token0/token1) used as the collateral price source.
contract SimplePair {
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(IERC20 a, IERC20 b) { token0 = a; token1 = b; }

    function getReserves() external view returns (uint112, uint112) { return (reserve0, reserve1); }

    function sync() public {
        reserve0 = uint112(token0.balanceOf(address(this)));
        reserve1 = uint112(token1.balanceOf(address(this)));
    }

    /// @notice Swap token0 in for token1 out (caller transfers token0 first).
    function swap0For1(uint256 amountOut, address to) external {
        uint256 in0 = token0.balanceOf(address(this)) - reserve0;
        require(in0 > 0, "no input");
        uint256 k = uint256(reserve0) * reserve1;
        require((uint256(reserve0) + in0) * (uint256(reserve1) - amountOut) >= k, "k");
        require(token1.transfer(to, amountOut), "transfer");
        sync();
    }
}
