// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TokenVesting {
    struct Grant {
        uint128 total;
        uint128 released;
        uint64 start;
        uint64 duration;
    }

    IERC20 public immutable token;
    address public immutable admin;
    mapping(address => Grant) public grants;

    event GrantCreated(address indexed beneficiary, uint256 total);
    event Released(address indexed beneficiary, address indexed to, uint256 amount);

    constructor(IERC20 token_) {
        token = token_;
        admin = msg.sender;
    }

    function createGrant(address beneficiary, uint128 total, uint64 duration) external {
        require(msg.sender == admin, "admin");
        require(grants[beneficiary].total == 0, "exists");
        grants[beneficiary] = Grant(total, 0, uint64(block.timestamp), duration);
        emit GrantCreated(beneficiary, total);
    }

    function vested(address beneficiary) public view returns (uint256) {
        Grant memory g = grants[beneficiary];
        if (block.timestamp >= g.start + g.duration) return g.total;
        return (uint256(g.total) * (block.timestamp - g.start)) / g.duration;
    }

    function release() external {
        uint256 amount = vested(msg.sender) - grants[msg.sender].released;
        _payout(msg.sender, msg.sender, amount);
    }

    function _payout(address beneficiary, address to, uint256 amount) public {
        require(amount > 0, "nothing");
        grants[beneficiary].released += uint128(amount);
        require(token.transfer(to, amount), "transfer failed");
        emit Released(beneficiary, to, amount);
    }
}
