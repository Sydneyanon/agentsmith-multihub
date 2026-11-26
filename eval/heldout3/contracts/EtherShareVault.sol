// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ShareLedger
/// @notice Non-transferable share accounting used by pooled vaults.
abstract contract ShareLedger {
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function _mint(address to, uint256 shares) internal {
        sharesOf[to] += shares;
        totalShares += shares;
        emit Transfer(address(0), to, shares);
    }

    function _burn(address from, uint256 shares) internal {
        sharesOf[from] -= shares;
        totalShares -= shares;
        emit Transfer(from, address(0), shares);
    }
}

/// @title EtherShareVault
/// @notice ERC4626-flavoured pooled ETH vault; yield is pushed in as plain ETH
///         by the strategy keeper, raising the value of every share.
contract EtherShareVault is ShareLedger {
    event Deposit(address indexed caller, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, uint256 assets, uint256 shares);

    error ZeroShares();
    error PayoutFailed();

    receive() external payable {}

    /// @notice Assets under management.
    function totalAssets() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Deposit ETH and receive shares at the current exchange rate.
    function deposit() external payable returns (uint256 shares) {
        uint256 assetsBefore = totalAssets() - msg.value;
        if (totalShares == 0 || assetsBefore == 0) {
            shares = msg.value;
        } else {
            shares = (msg.value * totalShares) / assetsBefore;
        }
        if (shares == 0) revert ZeroShares();
        _mint(msg.sender, shares);
        emit Deposit(msg.sender, msg.value, shares);
    }

    /// @notice Burn shares for their underlying ETH.
    function redeem(uint256 shares) external returns (uint256 assets) {
        assets = previewRedeem(shares);
        (bool ok, ) = msg.sender.call{value: assets}("");
        if (!ok) revert PayoutFailed();
        _burn(msg.sender, shares);
        emit Withdraw(msg.sender, assets, shares);
    }

    /// @notice ETH returned for `shares` at the current rate.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return (shares * totalAssets()) / totalShares;
    }
}
