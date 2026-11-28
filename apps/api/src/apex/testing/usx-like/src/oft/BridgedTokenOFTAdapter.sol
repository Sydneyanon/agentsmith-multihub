// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

interface IBridgedTokenLike {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

contract BridgedTokenOFTAdapter {
    IBridgedTokenLike public token;
    address public endpoint;
    address public owner;
    mapping(uint32 => bytes32) public peers;

    constructor(IBridgedTokenLike t, address e) {
        token = t;
        endpoint = e;
        owner = msg.sender;
    }

    function setPeer(uint32 eid, bytes32 peer) external {
        require(msg.sender == owner, "owner");
        peers[eid] = peer;
    }

    function send(uint32 dstEid, uint256 amount) external payable {
        require(peers[dstEid] != bytes32(0), "peer");
        token.burnFrom(msg.sender, amount);
        (bool ok, ) = endpoint.call{value: msg.value}(abi.encode(dstEid, peers[dstEid], amount));
        require(ok, "send");
    }

    function lzReceive(uint32 srcEid, address to, uint256 amount) external {
        require(msg.sender == endpoint, "endpoint");
        require(peers[srcEid] != bytes32(0), "peer");
        token.mint(to, amount);
    }
}
