// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal single-entry lock.
abstract contract PoolLock {
    bool private _locked;

    error Locked();

    modifier lock() {
        if (_locked) revert Locked();
        _locked = true;
        _;
        _locked = false;
    }
}

/// @title EthLiquidityPool
/// @notice Single-asset ETH pool whose LP tokens accrue fees; exposes a share
///         price consumed by integrators.
contract EthLiquidityPool is PoolLock {
    mapping(address => uint256) public lpBalance;
    mapping(address => mapping(address => uint256)) public lpAllowance;
    uint256 public lpSupply;
    uint256 public reserve;

    event Added(address indexed provider, uint256 amount, uint256 minted);
    event Removed(address indexed provider, uint256 lp, uint256 amount);

    error InsufficientLp();
    error SendFailed();

    function addLiquidity() external payable lock returns (uint256 minted) {
        minted = lpSupply == 0 ? msg.value : (msg.value * lpSupply) / reserve;
        lpBalance[msg.sender] += minted;
        lpSupply += minted;
        reserve += msg.value;
        emit Added(msg.sender, msg.value, minted);
    }

    function removeLiquidity(uint256 lp) external lock returns (uint256 out) {
        if (lpBalance[msg.sender] < lp) revert InsufficientLp();
        out = (lp * reserve) / lpSupply;
        lpBalance[msg.sender] -= lp;
        lpSupply -= lp;
        (bool ok, ) = msg.sender.call{value: out}("");
        if (!ok) revert SendFailed();
        reserve -= out;
        emit Removed(msg.sender, lp, out);
    }

    function approveLp(address spender, uint256 amount) external {
        lpAllowance[msg.sender][spender] = amount;
    }

    function transferLpFrom(address from, address to, uint256 amount) external lock {
        lpAllowance[from][msg.sender] -= amount;
        if (lpBalance[from] < amount) revert InsufficientLp();
        lpBalance[from] -= amount;
        lpBalance[to] += amount;
    }

    /// @notice Reserve backing one LP token, scaled by 1e18.
    function pricePerShare() external view returns (uint256) {
        return lpSupply == 0 ? 1e18 : (reserve * 1e18) / lpSupply;
    }
}

/// @title LpCollateralLender
/// @notice Lends ETH against pool LP tokens valued at the pool share price.
contract LpCollateralLender {
    EthLiquidityPool public immutable pool;
    uint256 public constant LTV_BPS = 8_000;

    mapping(address => uint256) public collateralLp;
    mapping(address => uint256) public debtOf;

    error Undercollateralized();
    error SendFailed();

    constructor(EthLiquidityPool pool_) payable {
        pool = pool_;
    }

    function depositCollateral(uint256 lp) external {
        pool.transferLpFrom(msg.sender, address(this), lp);
        collateralLp[msg.sender] += lp;
    }

    function borrow(uint256 amount) external {
        uint256 value = (collateralLp[msg.sender] * pool.pricePerShare()) / 1e18;
        uint256 newDebt = debtOf[msg.sender] + amount;
        if (newDebt * 10_000 > value * LTV_BPS) revert Undercollateralized();
        debtOf[msg.sender] = newDebt;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
