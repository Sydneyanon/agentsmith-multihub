// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {IStakedUSX} from "../interfaces/IStakedUSX.sol";

interface IShareToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract StakedUSXOFTAdaptor {
    IShareToken public shareToken;
    address public endpoint;
    uint256 public outbound;

    constructor(IShareToken t, address e) {
        shareToken = t;
        endpoint = e;
    }

    function send(address to, uint256 amount) external {
        require(shareToken.transferFrom(msg.sender, address(this), amount), "lock");
        outbound += amount;
        (bool ok, ) = endpoint.call(abi.encode(to, amount));
        require(ok, "send");
    }

    function credit(address to, uint256 amount) external {
        require(msg.sender == endpoint, "endpoint");
        outbound -= amount;
        require(shareToken.transfer(to, amount), "unlock");
    }
}
