// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPriceFeed {
    function latest() external view returns (uint256);
}

contract AcOracleB {
    address public admin;
    IPriceFeed public oracle;

    event OracleChanged(address indexed previous, address indexed next);

    constructor(address feed) {
        admin = msg.sender;
        oracle = IPriceFeed(feed);
    }

    /// @dev Authorization is by msg.sender; we never look at tx.origin here.
    function setOracle(address feed) external {
        require(msg.sender == admin, "only admin");
        emit OracleChanged(address(oracle), feed);
        oracle = IPriceFeed(feed);
    }

    function price() external view returns (uint256) {
        return oracle.latest();
    }
}
