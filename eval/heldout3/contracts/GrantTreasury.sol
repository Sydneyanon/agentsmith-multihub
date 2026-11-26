// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GrantSigners
/// @notice Static signer set with an approval threshold.
abstract contract GrantSigners {
    mapping(address => bool) public isSigner;
    uint256 public immutable threshold;

    error NotSigner();
    error BadThreshold();

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    constructor(address[] memory signers, uint256 threshold_) {
        if (threshold_ == 0 || threshold_ > signers.length) revert BadThreshold();
        for (uint256 i = 0; i < signers.length; ++i) {
            isSigner[signers[i]] = true;
        }
        threshold = threshold_;
    }
}

/// @title GrantTreasury
/// @notice M-of-N approval flow for paying grants out of the treasury.
contract GrantTreasury is GrantSigners {
    struct Proposal {
        address to;
        uint256 value;
        uint32 approvals;
        bool executed;
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    event Proposed(uint256 indexed id, address indexed to, uint256 value);
    event Approved(uint256 indexed id, address indexed signer);
    event Executed(uint256 indexed id);

    error AlreadyApproved();
    error AlreadyExecuted();
    error NotEnoughApprovals(uint256 have, uint256 need);
    error PayoutFailed();

    constructor(address[] memory signers, uint256 threshold_) GrantSigners(signers, threshold_) {}

    receive() external payable {}

    function propose(address to, uint256 value) external onlySigner returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal({to: to, value: value, approvals: 0, executed: false}));
        emit Proposed(id, to, value);
    }

    function approve(uint256 id) external onlySigner {
        if (approvedBy[id][msg.sender]) revert AlreadyApproved();
        approvedBy[id][msg.sender] = true;
        proposals[id].approvals += 1;
        emit Approved(id, msg.sender);
    }

    function execute(uint256 id) external onlySigner {
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.approvals < threshold) revert NotEnoughApprovals(p.approvals, threshold);
        p.executed = true;
        (bool ok, ) = p.to.call{value: p.value}("");
        if (!ok) revert PayoutFailed();
        emit Executed(id);
    }
}
