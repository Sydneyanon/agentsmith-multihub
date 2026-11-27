// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";

/// @notice Pooled vault: depositors receive shares of the underlying token held by the vault.
contract ShareVault {
    IERC20 public immutable asset;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed who, uint256 assets, uint256 shares);
    event Withdraw(address indexed who, uint256 assets, uint256 shares);

    constructor(IERC20 asset_) { asset = asset_; }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? assets : assets * supply / totalAssets();
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer");
        totalSupply += shares;
        balanceOf[msg.sender] += shares;
        emit Deposit(msg.sender, assets, shares);
    }

    /// @notice Withdraw an exact amount of the underlying.
    function withdraw(uint256 assets) external returns (uint256 shares) {
        shares = assets * totalSupply / totalAssets();
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        require(asset.transfer(msg.sender, assets), "transfer");
        emit Withdraw(msg.sender, assets, shares);
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        assets = shares * totalAssets() / totalSupply;
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        require(asset.transfer(msg.sender, assets), "transfer");
        emit Withdraw(msg.sender, assets, shares);
    }
}
