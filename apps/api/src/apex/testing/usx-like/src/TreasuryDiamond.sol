// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

contract TreasuryDiamond {
    mapping(bytes4 => address) public facets;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function setFacet(bytes4 selector, address facet) external {
        require(msg.sender == owner, "owner");
        facets[selector] = facet;
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "owner");
        owner = next;
    }

    fallback() external payable {
        address facet = facets[msg.sig];
        require(facet != address(0), "no facet");
        (bool ok, ) = facet.delegatecall(msg.data);
        require(ok, "facet failed");
    }

    receive() external payable {}
}
