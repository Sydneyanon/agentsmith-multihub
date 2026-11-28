// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITokenRecipient {
    function tokensReceived(address from, uint256 amount) external;
}

contract HookedRewardToken {
    string public constant name = "Reward";
    string public constant symbol = "RWD";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public minter;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {
        minter = msg.sender;
    }

    function setMinter(address m) external {
        require(msg.sender == minter, "minter");
        minter = m;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (to.code.length > 0) {
            ITokenRecipient(to).tokensReceived(msg.sender, amount);
        }
        return true;
    }
}

contract StakingRewards {
    uint256 private constant PRECISION = 1e18;

    HookedRewardToken public immutable rewardToken;
    address public operator;

    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public rewardDebt;
    uint256 public totalStaked;
    uint256 public accRewardPerShare;

    event Staked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event RewardNotified(uint256 amount);

    constructor(HookedRewardToken token) {
        rewardToken = token;
        operator = msg.sender;
    }

    function stake() external payable {
        require(msg.value > 0, "zero");
        require(stakeOf[msg.sender] == 0, "already staked");
        stakeOf[msg.sender] = msg.value;
        rewardDebt[msg.sender] = (msg.value * accRewardPerShare) / PRECISION;
        totalStaked += msg.value;
        emit Staked(msg.sender, msg.value);
    }

    function notifyReward(uint256 amount) external {
        require(msg.sender == operator, "operator");
        require(totalStaked > 0, "no stake");
        accRewardPerShare += (amount * PRECISION) / totalStaked;
        emit RewardNotified(amount);
    }

    function pending(address user) public view returns (uint256) {
        return (stakeOf[user] * accRewardPerShare) / PRECISION - rewardDebt[user];
    }

    function claim() external {
        uint256 owed = pending(msg.sender);
        require(owed > 0, "nothing owed");
        rewardToken.transfer(msg.sender, owed);
        rewardDebt[msg.sender] = (stakeOf[msg.sender] * accRewardPerShare) / PRECISION;
        emit Claimed(msg.sender, owed);
    }
}
