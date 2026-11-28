// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {TreasuryStorage} from "../TreasuryStorage.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";

contract AssetManagerAllocatorFacet {
    function allocate(uint256 amount) external {
        TreasuryStorage.Layout storage s = TreasuryStorage.layout();
        require(msg.sender == s.governance, "governance");
        s.allocated += amount;
        IAssetManager(s.assetManager).deposit(amount);
    }

    function deallocate(uint256 amount) external {
        TreasuryStorage.Layout storage s = TreasuryStorage.layout();
        require(msg.sender == s.governance, "governance");
        require(s.allocated >= amount, "allocated");
        s.allocated -= amount;
        IAssetManager(s.assetManager).withdraw(amount);
    }
}
