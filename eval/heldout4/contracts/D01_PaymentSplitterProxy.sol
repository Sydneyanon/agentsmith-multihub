// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PaymentSplitterLogic {
    address[] internal _payees;
    mapping(address => uint256) public shares;
    uint256 public totalShares;
    mapping(address => uint256) public released;
    uint256 public totalReleased;
    bool internal _setup;

    event PaymentReceived(address from, uint256 amount);

    function setup(address[] calldata payees, uint256[] calldata shares_) external {
        require(!_setup, "setup done");
        _setup = true;
        for (uint256 i = 0; i < payees.length; i++) {
            _payees.push(payees[i]);
            shares[payees[i]] = shares_[i];
            totalShares += shares_[i];
        }
    }

    function onPayment() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    function release(address payable account) external {
        uint256 totalReceived = address(this).balance + totalReleased;
        uint256 due = (totalReceived * shares[account]) / totalShares - released[account];
        require(due > 0, "nothing due");
        released[account] += due;
        totalReleased += due;
        (bool ok, ) = account.call{value: due}("");
        require(ok, "release failed");
    }
}

contract PaymentSplitterProxy {
    address public immutable logic;

    constructor(address logic_, bytes memory setupData) {
        logic = logic_;
        (bool ok, ) = logic_.delegatecall(setupData);
        require(ok, "setup failed");
    }

    receive() external payable {
        (bool ok, ) = logic.delegatecall(abi.encodeWithSelector(PaymentSplitterLogic.onPayment.selector));
        require(ok, "payment hook failed");
    }

    fallback() external payable {
        address impl = logic;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
