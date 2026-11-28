// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRedeemHook {
    function onRedeem(uint256 amount) external;
}

contract ReentBankB {
    mapping(address => uint256) public shares;

    event Minted(address indexed to, uint256 amount);

    function mint() external payable {
        shares[msg.sender] += msg.value;
        emit Minted(msg.sender, msg.value);
    }

    function redeem(uint256 amount) external {
        require(shares[msg.sender] >= amount, "insufficient shares");
        shares[msg.sender] -= amount;
        IRedeemHook(msg.sender).onRedeem(amount);
        payable(msg.sender).transfer(amount);
    }
}
