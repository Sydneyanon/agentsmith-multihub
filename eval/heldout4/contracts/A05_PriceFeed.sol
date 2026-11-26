// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KeeperControlled {
    address public keeper;
    address public governance;

    event KeeperChanged(address indexed keeper);

    constructor(address keeper_) {
        governance = msg.sender;
        keeper = keeper_;
    }

    modifier onlyKeeper() {
        if (msg.sender == keeper) {
            _;
        }
    }

    function setKeeper(address k) external {
        require(msg.sender == governance, "governance");
        keeper = k;
        emit KeeperChanged(k);
    }
}

contract PriceFeed is KeeperControlled {
    struct Round {
        uint128 price;
        uint64 updatedAt;
        uint64 roundId;
    }

    Round public latest;
    uint256 public maxDeviationBps = 2_000;

    event PriceUpdated(uint64 indexed roundId, uint128 price);

    constructor(address keeper_) KeeperControlled(keeper_) {}

    function submit(uint128 price) external onlyKeeper {
        Round memory r = latest;
        if (r.price != 0) {
            uint256 diff = price > r.price ? price - r.price : r.price - price;
            require(diff * 10_000 <= uint256(r.price) * maxDeviationBps, "deviation");
        }
        latest = Round({price: price, updatedAt: uint64(block.timestamp), roundId: r.roundId + 1});
        emit PriceUpdated(r.roundId + 1, price);
    }

    function read() external view returns (uint128 price, uint64 updatedAt) {
        require(latest.updatedAt + 1 hours >= block.timestamp, "stale");
        return (latest.price, latest.updatedAt);
    }
}
