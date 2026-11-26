// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library AmountLib {
    function nonZero(uint256 v) internal pure returns (uint256) {
        require(v != 0, "zero amount");
        return v;
    }
}

contract SavingsBank {
    using AmountLib for uint256;

    mapping(address => uint256) private _balances;
    uint256 public withdrawalCount;
    address public immutable founder;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    constructor() {
        founder = msg.sender;
    }

    function deposit() external payable {
        _balances[msg.sender] += msg.value.nonZero();
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        amount.nonZero();
        require(_balances[msg.sender] >= amount, "insufficient");
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "send failed");
        _balances[msg.sender] -= amount;
        withdrawalCount++;
        emit Withdrawn(msg.sender, amount);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
}
