// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A constant-product pool with an internal ledger. swapAForB() accepts whatever output the pool gives at execution
/// time: there is no minimum-output bound, so a searcher who sees the swap pending can trade first, move the price,
/// and let the victim execute at the worse rate (a sandwich). Transaction-ordering defect: the result depends on
/// which transactions land before it. No external call, writes keyed by the caller, correct AMM arithmetic.
contract SwapNoSlippageBad {
    uint256 public reserveA = 1_000 ether;
    uint256 public reserveB = 1_000 ether;
    mapping(address => uint256) public balA;
    mapping(address => uint256) public balB;

    function depositA() external payable { balA[msg.sender] += msg.value; }

    function swapAForB(uint256 amountIn) external returns (uint256 out) {
        require(balA[msg.sender] >= amountIn, "balance");
        // BUG (transaction-ordering): no minimum-output bound, so the trade executes at any price a front-runner sets.
        out = (amountIn * reserveB) / (reserveA + amountIn);
        balA[msg.sender] -= amountIn;
        balB[msg.sender] += out;
        reserveA += amountIn;
        reserveB -= out;
    }
}
