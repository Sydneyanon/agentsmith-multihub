// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RefundEscrow {
    enum State { Active, Refunding, Closed }

    address public immutable seller;
    address public immutable arbiter;
    State public state;
    mapping(address => uint256) public deposits;

    event Deposited(address indexed buyer, uint256 amount);
    event Refunded(address indexed buyer, uint256 amount);

    constructor(address seller_, address arbiter_) {
        seller = seller_;
        arbiter = arbiter_;
    }

    function deposit() external payable {
        require(state == State.Active, "inactive");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function enableRefunds() external {
        require(msg.sender == arbiter, "arbiter");
        state = State.Refunding;
    }

    function close() external {
        require(msg.sender == arbiter, "arbiter");
        state = State.Closed;
        (bool ok, ) = seller.call{value: address(this).balance}("");
        require(ok, "close failed");
    }

    function claimRefund(address payable buyer) external {
        require(state == State.Refunding, "not refunding");
        uint256 amount = deposits[buyer];
        deposits[buyer] = 0;
        (bool ok, ) = buyer.call{value: amount}("");
        require(ok, "refund failed");
        emit Refunded(buyer, amount);
    }
}
