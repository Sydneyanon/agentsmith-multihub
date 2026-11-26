// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KeeperJobs {
    struct Job {
        address module;
        bytes payload;
        uint64 interval;
        uint64 lastRun;
        uint128 reward;
    }

    address public immutable governance;
    mapping(address => bool) public keepers;
    Job[] public jobs;
    mapping(address => uint256) public earned;

    event JobRun(uint256 indexed id, address indexed keeper);

    constructor() {
        governance = msg.sender;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance, "governance");
        _;
    }

    function setKeeper(address k, bool on) external onlyGovernance {
        keepers[k] = on;
    }

    function addJob(address module, bytes calldata payload, uint64 interval, uint128 reward) external onlyGovernance {
        jobs.push(Job(module, payload, interval, 0, reward));
    }

    function work(uint256 id) external {
        require(keepers[msg.sender], "keeper");
        Job storage j = jobs[id];
        require(block.timestamp >= j.lastRun + j.interval, "too soon");
        j.lastRun = uint64(block.timestamp);
        j.module.delegatecall(j.payload);
        earned[msg.sender] += j.reward;
        emit JobRun(id, msg.sender);
    }

    function claim() external {
        uint256 e = earned[msg.sender];
        earned[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: e}("");
        require(ok, "claim failed");
    }

    receive() external payable {}
}
