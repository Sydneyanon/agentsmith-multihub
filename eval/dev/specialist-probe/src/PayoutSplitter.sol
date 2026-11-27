// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/// @notice Holds a token and pays it out to a fixed list of recipients by share.
contract PayoutSplitter {
    IERC20 public immutable token;
    address[] public recipients;
    uint256[] public sharesBps;
    address public owner;

    constructor(IERC20 t, address[] memory r, uint256[] memory s) {
        require(r.length == s.length, "len");
        uint256 sum;
        for (uint256 i = 0; i < s.length; i++) sum += s[i];
        require(sum == 10_000, "sum");
        token = t; recipients = r; sharesBps = s; owner = msg.sender;
    }

    /// @notice Anyone may trigger a distribution of the current balance.
    function distribute() external {
        uint256 bal = token.balanceOf(address(this));
        for (uint256 i = 0; i < recipients.length; i++) {
            require(token.transfer(recipients[i], bal * sharesBps[i] / 10_000), "transfer");
        }
    }
}
