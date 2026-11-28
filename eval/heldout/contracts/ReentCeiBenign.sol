// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReentCeiBenign {
    mapping(address => uint256) public credit;

    event Refunded(address indexed to, uint256 amount);

    function topUp() external payable {
        credit[msg.sender] += msg.value;
    }

    /// Zero the credit first, then pay; a failed payment reverts the whole call.
    function refund() external {
        uint256 amount = credit[msg.sender];
        require(amount != 0, "no credit");
        credit[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
        emit Refunded(msg.sender, amount);
    }
}
