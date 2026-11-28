// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IYieldStrategy {
    function invest() external payable;
    function totalValue() external view returns (uint256);
}

/// @title ControlledVault
/// @notice ETH vault whose idle funds are pushed into a strategy chosen by the
///         controller.
contract ControlledVault {
    address public immutable controller;
    IYieldStrategy public strategy;

    event StrategyChanged(address indexed strategy);
    event Invested(uint256 amount);

    error NotController();

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    constructor(address controller_) {
        controller = controller_;
    }

    receive() external payable {}

    function setStrategy(IYieldStrategy newStrategy) external onlyController {
        strategy = newStrategy;
        emit StrategyChanged(address(newStrategy));
    }

    /// @notice Push idle ETH into the active strategy.
    function earn() external onlyController {
        uint256 idle = address(this).balance;
        strategy.invest{value: idle}();
        emit Invested(idle);
    }
}

/// @title StrategyController
/// @notice Governance-facing controller that manages a set of vaults.
contract StrategyController {
    address public governance;
    mapping(address => bool) public approvedStrategy;

    event StrategyApproved(address indexed strategy, bool approved);
    event GovernanceTransferred(address indexed governance);

    error NotGovernance();
    error StrategyNotApproved();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor() {
        governance = msg.sender;
    }

    function setGovernance(address newGovernance) external onlyGovernance {
        governance = newGovernance;
        emit GovernanceTransferred(newGovernance);
    }

    function approveStrategy(address strategy, bool approved) external onlyGovernance {
        approvedStrategy[strategy] = approved;
        emit StrategyApproved(strategy, approved);
    }

    /// @notice Point a vault at a new, governance-approved strategy.
    function setVaultStrategy(ControlledVault vault, IYieldStrategy strategy) external onlyGovernance {
        if (!approvedStrategy[address(strategy)]) revert StrategyNotApproved();
        vault.setStrategy(strategy);
    }

    /// @notice Anyone may trigger investment of idle funds.
    function harvestAndEarn(ControlledVault vault) external {
        vault.earn();
    }
}
