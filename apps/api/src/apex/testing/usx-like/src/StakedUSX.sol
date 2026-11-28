// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {IUSX} from "./interfaces/IUSX.sol";

contract StakedUSX {
    IUSX public immutable asset;
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    uint256 public totalAssets;
    uint64 public lastRewardAt;
    address public treasury;

    constructor(IUSX usx) {
        asset = usx;
        treasury = msg.sender;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 minted) {
        minted = totalShares == 0 ? assets : (assets * totalShares) / totalAssets;
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer");
        shares[receiver] += minted;
        totalShares += minted;
        totalAssets += assets;
    }

    function redeem(uint256 amount, address receiver) external returns (uint256 assets) {
        require(shares[msg.sender] >= amount, "shares");
        assets = (amount * totalAssets) / totalShares;
        shares[msg.sender] -= amount;
        totalShares -= amount;
        totalAssets -= assets;
        require(asset.transfer(receiver, assets), "transfer");
    }

    function notifyReward(uint256 amount) external {
        require(msg.sender == treasury, "treasury");
        totalAssets += amount;
        lastRewardAt = uint64(block.timestamp);
    }
}
