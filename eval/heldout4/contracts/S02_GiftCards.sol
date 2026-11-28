// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract GiftCardIssuer {
    address public issuer;

    constructor() {
        issuer = msg.sender;
    }

    modifier onlyIssuer() {
        require(msg.sender == issuer, "issuer");
        _;
    }
}

contract GiftCards is GiftCardIssuer {
    mapping(bytes32 => uint256) public cardValue;

    event Issued(bytes32 indexed codeHash, uint256 value);
    event Redeemed(bytes32 indexed codeHash, address indexed to, uint256 value);

    function issue(bytes32 codeHash) external payable onlyIssuer {
        require(cardValue[codeHash] == 0, "exists");
        cardValue[codeHash] = msg.value;
        emit Issued(codeHash, msg.value);
    }

    function redeem(string calldata code, address payable to) external {
        bytes32 h = keccak256(bytes(code));
        uint256 v = cardValue[h];
        require(v > 0, "unknown card");
        cardValue[h] = 0;
        (bool ok, ) = to.call{value: v}("");
        require(ok, "redeem failed");
        emit Redeemed(h, to, v);
    }

    function shutdown(address payable to) external onlyIssuer {
        selfdestruct(to);
    }
}
