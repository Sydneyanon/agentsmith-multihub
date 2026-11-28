// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {IUSX} from "../interfaces/IUSX.sol";

interface IAdapterEndpoint {
    function send(uint32 dstEid, bytes32 to, uint256 amount) external payable;
}

contract USXOFTAdaptor {
    IUSX public innerToken;
    IAdapterEndpoint public endpoint;
    uint256 public locked;

    constructor(IUSX t, IAdapterEndpoint e) {
        innerToken = t;
        endpoint = e;
    }

    function send(uint32 dstEid, bytes32 to, uint256 amount) external payable {
        require(innerToken.transferFrom(msg.sender, address(this), amount), "lock");
        locked += amount;
        endpoint.send{value: msg.value}(dstEid, to, amount);
    }

    function lzReceive(address to, uint256 amount) external {
        require(msg.sender == address(endpoint), "endpoint");
        locked -= amount;
        require(innerToken.transfer(to, amount), "unlock");
    }
}
