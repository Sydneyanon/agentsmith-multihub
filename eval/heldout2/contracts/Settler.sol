// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPayee {
    function receivePay(uint256 a) external;
}

contract Settler {
    mapping(address => uint256) public failed;

    function settle(IPayee p, uint256 a) external {
        try p.receivePay(a) {
        } catch {
            failed[address(p)] += a;
        }
    }

    function settleQuiet(IPayee p, uint256 a) external {
        try p.receivePay(a) {
        } catch {
        }
    }
}
