// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

interface ITreasury {
    function distribute(uint256 amount) external;
    function allocate(uint256 amount) external;
    function facets(bytes4 selector) external view returns (address);
}
