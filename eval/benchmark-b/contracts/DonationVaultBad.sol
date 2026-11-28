// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// An ETH share vault. deposit() prices new shares against the vault's raw ETH balance, which anyone can inflate by
/// sending ETH directly (receive() accepts donations). Economic attack: the first depositor mints 1 share for 1 wei,
/// donates a large amount, and every later deposit smaller than the donation rounds down to 0 shares — the attacker
/// then withdraws the victims' ETH. No reentrancy (state is written before the transfer), no missing modifier: the
/// defect is the manipulable asset measure in the share price.
contract DonationVaultBad {
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    receive() external payable {}

    function deposit() external payable {
        // BUG (economic-attack): assets measured from the donatable raw balance, so the share price can be inflated.
        uint256 assetsBefore = address(this).balance - msg.value;
        uint256 minted = totalShares == 0 ? msg.value : (msg.value * totalShares) / assetsBefore;
        shares[msg.sender] += minted;
        totalShares += minted;
    }

    function withdraw(uint256 s) external {
        require(shares[msg.sender] >= s, "shares");
        uint256 amount = (s * address(this).balance) / totalShares;
        shares[msg.sender] -= s;
        totalShares -= s;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send");
    }
}
