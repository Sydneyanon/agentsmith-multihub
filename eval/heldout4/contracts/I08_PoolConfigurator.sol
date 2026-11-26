// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPool {
    function setReserveActive(address asset, bool active) external;
}

contract PoolConfiguratorStorage {
    bool internal initialized;
    address public governor;
    address public pool;
    uint256 public flashFeeBps;
}

contract PoolConfigurator is PoolConfiguratorStorage {
    event GovernorSet(address indexed governor);
    event ReserveToggled(address indexed asset, bool active);

    modifier onlyGovernor() {
        require(msg.sender == governor, "governor");
        _;
    }

    function initialize(address governor_, address pool_, uint256 flashFeeBps_) external {
        require(!initialized, "already initialized");
        governor = governor_;
        pool = pool_;
        flashFeeBps = flashFeeBps_;
        emit GovernorSet(governor_);
    }

    function setReserveActive(address asset, bool active) external onlyGovernor {
        IPool(pool).setReserveActive(asset, active);
        emit ReserveToggled(asset, active);
    }

    function setFlashFee(uint256 bps) external onlyGovernor {
        require(bps <= 100, "fee");
        flashFeeBps = bps;
    }
}
