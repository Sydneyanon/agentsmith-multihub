// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ManagedClientVault
/// @notice Per-client ETH vault deployed and lifecycle-managed by its factory.
contract ManagedClientVault {
    address public immutable factory;
    address public immutable client;

    error NotFactory();
    error NotClient();
    error SendFailed();

    constructor(address client_) {
        factory = msg.sender;
        client = client_;
    }

    receive() external payable {}

    function withdraw(uint256 amount) external {
        if (msg.sender != client) revert NotClient();
        (bool ok, ) = payable(client).call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    /// @notice Close the vault; remaining funds go to the factory treasury.
    function retire(address payable treasury) external {
        if (msg.sender != factory) revert NotFactory();
        selfdestruct(treasury);
    }
}

/// @title ManagedVaultFactory
/// @notice Deploys client vaults and retires abandoned ones.
contract ManagedVaultFactory {
    address public owner;
    address payable public treasury;
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed client, address vault);
    event VaultRetired(address indexed vault);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address payable treasury_) {
        owner = msg.sender;
        treasury = treasury_;
    }

    function createVault() external returns (address vault) {
        vault = address(new ManagedClientVault(msg.sender));
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }

    function retireVault(ManagedClientVault vault) external onlyOwner {
        vault.retire(treasury);
        emit VaultRetired(address(vault));
    }

    function setTreasury(address payable treasury_) external onlyOwner {
        treasury = treasury_;
    }
}
