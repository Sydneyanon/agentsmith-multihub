// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

contract StakedUSXOFT {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public endpoint;
    uint256[] public inboundNonces;

    constructor(address e) {
        endpoint = e;
    }

    function lzReceive(address to, uint256 amount, uint256 nonce) external {
        require(msg.sender == endpoint, "endpoint");
        inboundNonces.push(nonce);
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burnToBridge(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok, ) = endpoint.call(abi.encodeWithSignature("send(address,uint256)", msg.sender, amount));
        require(ok, "send");
    }
}
