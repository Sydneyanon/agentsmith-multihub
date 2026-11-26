// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AuctionConfig
/// @notice Immutable configuration shared by auction flavours.
abstract contract AuctionConfig {
    address public immutable seller;
    uint64 public immutable endsAt;
    uint256 public immutable reservePrice;

    error AuctionEnded();
    error AuctionLive();
    error BidTooLow(uint256 minimum);

    constructor(address seller_, uint64 duration, uint256 reserve_) {
        seller = seller_;
        endsAt = uint64(block.timestamp) + duration;
        reservePrice = reserve_;
    }

    modifier whileLive() {
        if (block.timestamp >= endsAt) revert AuctionEnded();
        _;
    }

    modifier afterEnd() {
        if (block.timestamp < endsAt) revert AuctionLive();
        _;
    }
}

/// @title ReserveAuction
/// @notice English auction with a reserve; outbid bidders pull their refunds.
contract ReserveAuction is AuctionConfig {
    address public highestBidder;
    uint256 public highestBid;
    bool public settled;

    mapping(address => uint256) public pendingReturns;

    event BidPlaced(address indexed bidder, uint256 amount);
    event RefundWithdrawn(address indexed bidder, uint256 amount);
    event Settled(address indexed winner, uint256 amount);

    error NoRefund();
    error AlreadySettled();
    error SendFailed();

    constructor(uint64 duration, uint256 reserve_) AuctionConfig(msg.sender, duration, reserve_) {}

    function bid() external payable whileLive {
        uint256 minimum = highestBid == 0 ? reservePrice : highestBid + 1;
        if (msg.value < minimum) revert BidTooLow(minimum);
        if (highestBidder != address(0)) {
            pendingReturns[highestBidder] += highestBid;
        }
        highestBidder = msg.sender;
        highestBid = msg.value;
        emit BidPlaced(msg.sender, msg.value);
    }

    /// @notice Withdraw funds from bids that were outbid.
    function withdrawRefund() external {
        uint256 amount = pendingReturns[msg.sender];
        if (amount == 0) revert NoRefund();
        _sendValue(msg.sender, amount);
        pendingReturns[msg.sender] = 0;
        emit RefundWithdrawn(msg.sender, amount);
    }

    /// @notice Pay the seller once the auction is over.
    function settle() external afterEnd {
        if (settled) revert AlreadySettled();
        settled = true;
        emit Settled(highestBidder, highestBid);
        _sendValue(seller, highestBid);
    }

    function _sendValue(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
