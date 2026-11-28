// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Matched secure variant of SwapNoSlippageBad: swapAForB() takes a caller-chosen minimum output and reverts if the
/// pool gives less, so a front-run trade cannot push the victim below the price they accepted. Structurally
/// identical; only the slippage bound differs. Flagging this swap is a false positive.
contract SwapNoSlippageGood {
    uint256 public reserveA = 1_000 ether;
    uint256 public reserveB = 1_000 ether;
    mapping(address => uint256) public balA;
    mapping(address => uint256) public balB;

    function depositA() external payable { balA[msg.sender] += msg.value; }

    function swapAForB(uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        require(balA[msg.sender] >= amountIn, "balance");
        out = (amountIn * reserveB) / (reserveA + amountIn);
        require(out >= minOut, "slippage");
        balA[msg.sender] -= amountIn;
        balB[msg.sender] += out;
        reserveA += amountIn;
        reserveB -= out;
    }
}
