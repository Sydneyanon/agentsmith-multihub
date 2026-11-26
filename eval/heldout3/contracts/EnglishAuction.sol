// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Optional observer notified about auction activity (indexers, UIs).
interface IAuctionListener {
    function onBid(address bidder, uint256 amount) external;
}

/// @title AuctionTimer
abstract contract AuctionTimer {
    address public immutable seller;
    uint64 public immutable endsAt;

    error Ended();

    constructor(uint64 duration) {
        seller = msg.sender;
        endsAt = uint64(block.timestamp) + duration;
    }

    modifier beforeEnd() {
        if (block.timestamp >= endsAt) revert Ended();
        _;
    }
}

/// @title EnglishAuction
/// @notice Push-refund English auction with an optional activity listener.
contract EnglishAuction is AuctionTimer {
    address public highestBidder;
    uint256 public highestBid;
    address public listener;

    event NewHighBid(address indexed bidder, uint256 amount);

    error BidTooLow();
    error NotSeller();

    constructor(uint64 duration, address listener_) AuctionTimer(duration) {
        listener = listener_;
    }

    function setListener(address listener_) external {
        if (msg.sender != seller) revert NotSeller();
        listener = listener_;
    }

    function bid() external payable beforeEnd {
        if (msg.value <= highestBid) revert BidTooLow();
        address previousBidder = highestBidder;
        uint256 previousBid = highestBid;
        highestBidder = msg.sender;
        highestBid = msg.value;
        if (previousBidder != address(0)) {
            payable(previousBidder).send(previousBid);
        }
        emit NewHighBid(msg.sender, msg.value);
        _notifyListener(msg.sender, msg.value);
    }

    function _notifyListener(address bidder, uint256 amount) private {
        if (listener != address(0)) {
            listener.call{gas: 50_000}(abi.encodeCall(IAuctionListener.onBid, (bidder, amount)));
        }
    }
}
