// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

interface IAssetManager {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function totalManaged() external view returns (uint256);
}
