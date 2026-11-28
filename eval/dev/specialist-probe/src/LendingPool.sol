// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";
import "./SimplePair.sol";

/// @notice Deposit token0 as collateral, borrow token1. Collateral is valued in token1 using the pair.
contract LendingPool {
    IERC20 public immutable collateral; // token0
    IERC20 public immutable debtToken;  // token1
    SimplePair public pair;
    address public owner;
    uint256 public constant LTV_BPS = 7500;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;
    address[] public borrowers;

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    constructor(IERC20 c, IERC20 d, SimplePair p) { collateral = c; debtToken = d; pair = p; owner = msg.sender; }

    function setPair(SimplePair p) external {
        pair = p;
    }

    function setOwner(address o) external onlyOwner { owner = o; }

    /// @return price of one collateral unit in debt units, scaled by 1e18
    function price() public view returns (uint256) {
        (uint112 r0, uint112 r1) = pair.getReserves();
        return uint256(r1) * 1e18 / uint256(r0);
    }

    function depositCollateral(uint256 amount) external {
        require(collateral.transferFrom(msg.sender, address(this), amount), "transfer");
        collateralOf[msg.sender] += amount;
    }

    function borrow(uint256 amount) external {
        if (debtOf[msg.sender] == 0) borrowers.push(msg.sender);
        debtOf[msg.sender] += amount;
        uint256 value = collateralOf[msg.sender] * price() / 1e18;
        require(debtOf[msg.sender] * 10_000 <= value * LTV_BPS, "undercollateralised");
        require(debtToken.transfer(msg.sender, amount), "transfer");
    }

    function repay(uint256 amount) external {
        require(debtToken.transferFrom(msg.sender, address(this), amount), "transfer");
        debtOf[msg.sender] -= amount;
    }

    function withdrawCollateral(uint256 amount) external {
        collateralOf[msg.sender] -= amount;
        uint256 value = collateralOf[msg.sender] * price() / 1e18;
        require(debtOf[msg.sender] * 10_000 <= value * LTV_BPS, "undercollateralised");
        require(collateral.transfer(msg.sender, amount), "transfer");
    }

    /// @notice Number of borrowers (for off-chain monitoring).
    function borrowerCount() external view returns (uint256 n) {
        for (uint256 i = 0; i < borrowers.length; ) { unchecked { ++i; ++n; } }
    }
}
