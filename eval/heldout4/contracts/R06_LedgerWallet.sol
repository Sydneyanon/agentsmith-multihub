// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract ReentrancyGuard {
    uint256 private _status = 1;

    modifier nonReentrant() {
        require(_status == 1, "reentrant call");
        _status = 2;
        _;
        _status = 1;
    }
}

contract LedgerWallet is ReentrancyGuard {
    mapping(address => uint256) public credit;

    event Credited(address indexed account, uint256 amount);
    event Moved(address indexed from, address indexed to, uint256 amount);
    event Paid(address indexed account, uint256 amount);

    function deposit() external payable {
        credit[msg.sender] += msg.value;
        emit Credited(msg.sender, msg.value);
    }

    function move(address to, uint256 amount) external {
        require(to != address(0), "zero address");
        require(credit[msg.sender] >= amount, "insufficient");
        credit[msg.sender] -= amount;
        credit[to] += amount;
        emit Moved(msg.sender, to, amount);
    }

    function withdrawAll() external nonReentrant {
        uint256 amount = credit[msg.sender];
        require(amount > 0, "empty");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "payout failed");
        credit[msg.sender] = 0;
        emit Paid(msg.sender, amount);
    }
}
