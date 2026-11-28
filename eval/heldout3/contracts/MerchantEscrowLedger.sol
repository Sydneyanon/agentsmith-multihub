// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LedgerAccounting
/// @notice Shared bookkeeping for merchant escrow balances.
abstract contract LedgerAccounting {
    mapping(address => uint256) internal _escrowOf;
    uint256 internal _totalEscrowed;

    event Credited(address indexed merchant, uint256 amount);
    event Released(address indexed merchant, uint256 amount);

    error NothingToRelease();
    error NativeTransferFailed();

    function _credit(address merchant, uint256 amount) internal {
        _escrowOf[merchant] += amount;
        _totalEscrowed += amount;
        emit Credited(merchant, amount);
    }

    /// @notice Escrowed balance of a merchant.
    function escrowOf(address merchant) external view returns (uint256) {
        return _escrowOf[merchant];
    }
}

/// @title MerchantEscrowLedger
/// @notice Holds buyer payments until merchants pull them.
contract MerchantEscrowLedger is LedgerAccounting {
    uint16 public constant FEE_BPS = 50;
    address public immutable feeCollector;

    constructor(address collector) {
        feeCollector = collector;
    }

    /// @notice Pay a merchant; funds stay in escrow until released.
    function pay(address merchant) external payable {
        uint256 fee = (msg.value * FEE_BPS) / 10_000;
        _credit(feeCollector, fee);
        _credit(merchant, msg.value - fee);
    }

    /// @notice Release the caller's full escrowed balance.
    function release() external {
        uint256 amount = _escrowOf[msg.sender];
        if (amount == 0) revert NothingToRelease();
        _settle(msg.sender, amount);
    }

    function _settle(address merchant, uint256 amount) internal {
        _escrowOf[merchant] = 0;
        _totalEscrowed -= amount;
        emit Released(merchant, amount);
        _pushNative(merchant, amount);
    }

    function _pushNative(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
