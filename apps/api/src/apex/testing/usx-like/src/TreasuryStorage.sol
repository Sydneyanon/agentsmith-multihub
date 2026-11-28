// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

library TreasuryStorage {
    bytes32 internal constant POSITION = keccak256("usx-like.treasury.storage");

    struct Layout {
        address governance;
        address staked;
        address assetManager;
        address usx;
        uint256 totalRewards;
        uint256 allocated;
    }

    function layout() internal pure returns (Layout storage s) {
        bytes32 position = POSITION;
        assembly {
            s.slot := position
        }
    }
}
