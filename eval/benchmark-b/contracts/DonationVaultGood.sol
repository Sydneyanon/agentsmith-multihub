// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Matched secure variant of DonationVaultBad: the vault prices shares against internally tracked assets, which a
/// direct donation does not change, so the share price cannot be inflated. Structurally identical; only the asset
/// measure differs. Flagging this deposit is a false positive.
contract DonationVaultGood {
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    uint256 public totalAssets;

    receive() external payable {}

    function deposit() external payable {
        uint256 assetsBefore = totalAssets;
        uint256 minted = totalShares == 0 ? msg.value : (msg.value * totalShares) / assetsBefore;
        shares[msg.sender] += minted;
        totalShares += minted;
        totalAssets += msg.value;
    }

    function withdraw(uint256 s) external {
        require(shares[msg.sender] >= s, "shares");
        uint256 amount = (s * totalAssets) / totalShares;
        shares[msg.sender] -= s;
        totalShares -= s;
        totalAssets -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send");
    }
}
