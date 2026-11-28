// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRegistry {
    function note(address who, uint256 amt) external;
}

interface IHooked {
    function send(address to, uint256 amt) external;
}

contract Notifier {
    mapping(address => uint256) public bal;
    IRegistry public immutable registry;

    constructor(IRegistry r) {
        registry = r;
    }

    function put() external payable {
        bal[msg.sender] += msg.value;
    }

    function leave(uint256 a) external {
        require(bal[msg.sender] >= a, "low");
        registry.note(msg.sender, a);
        bal[msg.sender] -= a;
        (bool ok, ) = payable(msg.sender).call{value: a}("");
        require(ok, "xfer");
    }
}

contract CoinBox {
    mapping(address => uint256) public held;
    IHooked public immutable coin;

    constructor(IHooked c) {
        coin = c;
    }

    function take(uint256 a) external {
        require(held[msg.sender] >= a, "low");
        coin.send(msg.sender, a);
        held[msg.sender] -= a;
    }
}
