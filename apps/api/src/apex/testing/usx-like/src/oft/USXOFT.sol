// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

interface IEndpointLike {
    function send(uint32 dstEid, bytes32 to, uint256 amount, bytes calldata options) external payable returns (bytes32 guid);
}

contract USXOFT {
    struct SendParam {
        uint32 dstEid;
        bytes32 to;
        uint256 amountLD;
    }

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    IEndpointLike public endpoint;
    address public delegate;

    constructor(IEndpointLike e) {
        endpoint = e;
        delegate = msg.sender;
    }

    function send(SendParam calldata p) external payable returns (bytes32 guid) {
        require(balanceOf[msg.sender] >= p.amountLD, "balance");
        balanceOf[msg.sender] -= p.amountLD;
        totalSupply -= p.amountLD;
        guid = endpoint.send{value: msg.value}(p.dstEid, p.to, p.amountLD, "");
    }

    function lzReceive(uint32 srcEid, address to, uint256 amount) external {
        require(msg.sender == address(endpoint), "endpoint");
        require(srcEid != 0, "eid");
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}
