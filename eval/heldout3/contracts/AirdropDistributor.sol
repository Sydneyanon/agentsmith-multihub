// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Implemented by contracts that want to react to incoming points.
interface IPointsReceiver {
    function onPointsReceived(address from, uint256 amount, bytes calldata data) external returns (bytes4);
}

/// @title HookedPoints
/// @notice Loyalty points with a receive hook for contract recipients.
contract HookedPoints {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    error NotMinter();
    error InsufficientBalance();

    constructor() {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        _notify(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        _notify(msg.sender, to, amount);
        return true;
    }

    function _notify(address from, address to, uint256 amount) private {
        if (to.code.length > 0) {
            IPointsReceiver(to).onPointsReceived(from, amount, "");
        }
    }
}

/// @title AirdropDistributor
/// @notice Deploys the points token and lets allow-listed users claim their
///         one-time allocation.
contract AirdropDistributor {
    HookedPoints public immutable points;
    address public immutable operator;

    mapping(address => uint256) public allocationOf;
    mapping(address => bool) public hasClaimed;

    event AllocationSet(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    error NotOperator();
    error AlreadyClaimed();
    error NothingAllocated();
    error LengthMismatch();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
        points = new HookedPoints();
    }

    function setAllocations(address[] calldata accounts, uint256[] calldata amounts) external onlyOperator {
        if (accounts.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < accounts.length; ++i) {
            allocationOf[accounts[i]] = amounts[i];
            emit AllocationSet(accounts[i], amounts[i]);
        }
    }

    /// @notice Claim the caller's allocation.
    function claim() external {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();
        uint256 amount = allocationOf[msg.sender];
        if (amount == 0) revert NothingAllocated();
        points.mint(msg.sender, amount);
        hasClaimed[msg.sender] = true;
        emit Claimed(msg.sender, amount);
    }
}
