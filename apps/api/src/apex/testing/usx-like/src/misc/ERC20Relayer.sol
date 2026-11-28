// SPDX-License-Identifier: MIT
// SELF-AUTHORED FIXTURE for the APEX shadow tests: it imitates only the SHAPE of the USX scope; it is not USX source.
pragma solidity ^0.8.20;

import {IUSX} from "../interfaces/IUSX.sol";
import {IScrollERC20Bridge} from "../interfaces/IScrollERC20Bridge.sol";

contract ERC20Relayer {
    IScrollERC20Bridge public bridge;
    mapping(bytes32 => bool) public relayed;
    address public owner;

    constructor(IScrollERC20Bridge b) {
        bridge = b;
        owner = msg.sender;
    }

    function relay(address token, address to, uint256 amount, uint256 nonce) external payable {
        bytes32 id = keccak256(abi.encode(token, to, amount, nonce));
        require(!relayed[id], "relayed");
        relayed[id] = true;
        require(IUSX(token).transferFrom(msg.sender, address(this), amount), "pull");
        bridge.depositERC20{value: msg.value}(token, to, amount, 200000);
    }

    function rescue(address token, uint256 amount) external {
        require(msg.sender == owner, "owner");
        try IUSX(token).transfer(owner, amount) returns (bool) {
        } catch {
            revert("rescue failed");
        }
    }
}
