// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SunsetSchedule
/// @notice Owner-announced shutdown that only takes effect after a notice period.
abstract contract SunsetSchedule {
    uint256 public constant NOTICE_PERIOD = 30 days;

    address public owner;
    uint256 public sunsetAt;

    event SunsetAnnounced(uint256 at);

    error NotOwner();
    error NoticeNotElapsed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier afterSunset() {
        if (sunsetAt == 0 || block.timestamp < sunsetAt) revert NoticeNotElapsed();
        _;
    }

    function announceSunset() external onlyOwner {
        sunsetAt = block.timestamp + NOTICE_PERIOD;
        emit SunsetAnnounced(sunsetAt);
    }
}

/// @title GovernedSunsetPool
/// @notice Incentive pool that is wound down after users had a month to exit.
contract GovernedSunsetPool is SunsetSchedule {
    mapping(address => uint256) public stakeOf;

    error SendFailed();

    constructor() {
        owner = msg.sender;
    }

    function stake() external payable {
        stakeOf[msg.sender] += msg.value;
    }

    function exit() external {
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    /// @notice Final shutdown; leftover dust goes to the owner.
    function finalize() external onlyOwner afterSunset {
        selfdestruct(payable(owner));
    }
}
