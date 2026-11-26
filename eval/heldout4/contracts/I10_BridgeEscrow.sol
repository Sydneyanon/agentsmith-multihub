// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BridgeEscrow {
    address public owner;
    address public relayer;
    uint256 public nonce;
    bool private _initialized;
    mapping(bytes32 => bool) public processed;

    event Locked(address indexed from, uint256 amount, uint256 indexed nonce);
    event Released(address indexed to, uint256 amount, bytes32 indexed id);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    function initialize(address owner_, address relayer_) external {
        require(!_initialized, "initialized");
        _initialized = true;
        owner = owner_;
        relayer = relayer_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setRelayer(address r) external onlyOwner {
        relayer = r;
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function lock() external payable {
        require(msg.value > 0, "zero");
        emit Locked(msg.sender, msg.value, nonce++);
    }

    function release(address payable to, uint256 amount, bytes32 id) external {
        require(msg.sender == relayer, "relayer");
        require(!processed[id], "processed");
        processed[id] = true;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "release failed");
        emit Released(to, amount, id);
    }
}
