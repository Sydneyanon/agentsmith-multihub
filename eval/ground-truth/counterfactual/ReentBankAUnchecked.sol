// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRedeemHook {
    function onRedeem(uint256 amount) external;
}

contract ReentBankAUnchecked {
    mapping(address => uint256) public shares;

    event Minted(address indexed to, uint256 amount);

    function mint() external payable {
        shares[msg.sender] += msg.value;
        emit Minted(msg.sender, msg.value);
    }

    function redeem(uint256 amount) external {
        require(shares[msg.sender] >= amount, "insufficient shares");
        IRedeemHook(msg.sender).onRedeem(amount);
        unchecked { shares[msg.sender] -= amount; }
        payable(msg.sender).transfer(amount);
    }
}
