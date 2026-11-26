// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReentHelperB {
    mapping(address => uint256) private funds;
    uint256 private status = 1;

    event Paid(address indexed to, uint256 amount);

    function fund() external payable {
        funds[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(status == 1, "reentered");
        status = 2;
        require(funds[msg.sender] >= amount, "insufficient");
        _payout(msg.sender, amount);
        funds[msg.sender] -= amount;
        status = 1;
    }

    function _payout(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "payout failed");
        emit Paid(to, amount);
    }

    function available(address who) external view returns (uint256) {
        return funds[who];
    }
}
