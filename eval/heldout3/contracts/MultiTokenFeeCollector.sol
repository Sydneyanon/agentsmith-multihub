// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Basic {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title SafeTransferLib
/// @notice Transfer helper tolerant of tokens that return no value.
library SafeTransferLib {
    error TokenTransferFailed(address token);

    function safeTransfer(IERC20Basic token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(IERC20Basic.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            revert TokenTransferFailed(address(token));
        }
    }
}

/// @title FeeCollectorAuth
abstract contract FeeCollectorAuth {
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

/// @title MultiTokenFeeCollector
/// @notice Accumulates swap fees in many tokens and sweeps them to the
///         treasury. Sweeps are recorded for the accounting dashboard.
contract MultiTokenFeeCollector is FeeCollectorAuth {
    using SafeTransferLib for IERC20Basic;

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
    function sweep(IERC20Basic token) external onlyKeeper {
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(treasury, amount);
        sweptTotal[address(token)] += amount;
        emit Swept(address(token), amount);
    }
}
