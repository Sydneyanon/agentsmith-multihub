// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DirectCallerOnly
/// @notice Restricts entry points to externally owned accounts to blunt
///         bot-driven batch minting.
abstract contract DirectCallerOnly {
    error ContractCaller();

    modifier onlyDirectCaller() {
        if (tx.origin != msg.sender) revert ContractCaller();
        _;
    }
}

/// @title GenesisMintPass
/// @notice Flat-price mint pass, one per wallet.
contract GenesisMintPass is DirectCallerOnly {
    uint256 public constant PRICE = 0.05 ether;
    uint256 public constant MAX_SUPPLY = 5_000;

    address public immutable treasury;
    uint256 public minted;
    mapping(address => uint256) public passOf;

    event PassMinted(address indexed to, uint256 id);
    event SponsoredMint(address indexed to, address indexed sponsorOrigin, uint256 id);

    error SoldOut();
    error WrongPrice();
    error AlreadyMinted();
    error SendFailed();

    constructor(address treasury_) {
        treasury = treasury_;
    }

    function mint() external payable onlyDirectCaller {
        uint256 id = _mintTo(msg.sender);
        emit PassMinted(msg.sender, id);
    }

    /// @notice Mint on behalf of `to`; the originating account is logged for
    ///         sponsor analytics.
    function mintFor(address to) external payable {
        uint256 id = _mintTo(to);
        emit SponsoredMint(to, tx.origin, id);
    }

    function _mintTo(address to) private returns (uint256 id) {
        if (msg.value != PRICE) revert WrongPrice();
        if (minted >= MAX_SUPPLY) revert SoldOut();
        if (passOf[to] != 0) revert AlreadyMinted();
        id = ++minted;
        passOf[to] = id;
        (bool ok, ) = payable(treasury).call{value: msg.value}("");
        if (!ok) revert SendFailed();
    }
}
