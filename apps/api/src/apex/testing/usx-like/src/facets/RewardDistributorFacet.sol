// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {TreasuryStorage} from "../TreasuryStorage.sol";
import {IStakedUSX} from "../interfaces/IStakedUSX.sol";
import {IUSX} from "../interfaces/IUSX.sol";

contract RewardDistributorFacet {
    event RewardsDistributed(uint256 amount);

    function distribute(uint256 amount) external {
        TreasuryStorage.Layout storage s = TreasuryStorage.layout();
        require(msg.sender == s.governance, "governance");
        s.totalRewards += amount;
        IUSX(s.usx).mint(s.staked, amount);
        IStakedUSX(s.staked).notifyReward(amount);
        emit RewardsDistributed(amount);
    }
}
