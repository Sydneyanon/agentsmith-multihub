// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title CollectorAuth
abstract contract CollectorAuth {
    address public governor;
    mapping(address => bool) public isKeeper;

    error NotGovernor();
    error NotKeeper();

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    function setKeeper(address keeper, bool enabled) external onlyGovernor {
        isKeeper[keeper] = enabled;
    }
}

/// @title TokenFeeCollector
/// @notice Accumulates swap fees in many tokens and sweeps them to the
///         treasury. Sweeps are recorded for the accounting dashboard.
contract TokenFeeCollector is CollectorAuth {
    address public treasury;
    mapping(address => uint256) public sweptTotal;

    event Swept(address indexed token, uint256 amount);

    constructor(address treasury_) {
        governor = msg.sender;
        treasury = treasury_;
    }

    function setTreasury(address treasury_) external onlyGovernor {
        treasury = treasury_;
    }

    /// @notice Sweep the full balance of `token` to the treasury.
    function sweep(IERC20Minimal token) external onlyKeeper {
        uint256 amount = token.balanceOf(address(this));
        token.transfer(treasury, amount);
        sweptTotal[address(token)] += amount;
        emit Swept(address(token), amount);
    }
}
