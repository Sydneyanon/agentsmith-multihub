// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

interface IScrollERC20Bridge {
    function depositERC20(address token, address to, uint256 amount, uint256 gasLimit) external payable;
    function finalizeWithdrawERC20(address l1Token, address l2Token, address from, address to, uint256 amount, bytes calldata data) external payable;
}
