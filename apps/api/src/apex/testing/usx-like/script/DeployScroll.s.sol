// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests (OUT OF SCOPE): a script-shaped contract outside the selected files.
pragma solidity ^0.8.20;

contract DeployScroll {
    address public deployed;

    function run(address a) external {
        deployed = a;
    }
}
