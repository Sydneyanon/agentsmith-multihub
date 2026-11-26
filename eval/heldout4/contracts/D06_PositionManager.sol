// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Multicall {
    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
        }
    }
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract PositionManager is Multicall {
    struct Position {
        address owner;
        uint128 liquidity;
        int24 lower;
        int24 upper;
    }

    IERC20 public immutable token;
    uint256 public nextId = 1;
    mapping(uint256 => Position) public positions;

    constructor(IERC20 token_) {
        token = token_;
    }

    function open(uint128 liquidity, int24 lower, int24 upper) external returns (uint256 id) {
        require(lower < upper, "range");
        require(token.transferFrom(msg.sender, address(this), liquidity), "pull");
        id = nextId++;
        positions[id] = Position(msg.sender, liquidity, lower, upper);
    }

    function close(uint256 id) external {
        Position memory p = positions[id];
        require(p.owner == msg.sender, "not owner");
        delete positions[id];
        require(token.transfer(msg.sender, p.liquidity), "push");
    }

    function adjust(uint256 id, int24 lower, int24 upper) external {
        require(positions[id].owner == msg.sender, "not owner");
        require(lower < upper, "range");
        positions[id].lower = lower;
        positions[id].upper = upper;
    }
}
