// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFeeToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title RoleRegistry
/// @notice Lightweight role registry with a role-parameterised modifier.
abstract contract RoleRegistry {
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    mapping(bytes32 => mapping(address => bool)) private _members;

    event RoleUpdated(bytes32 indexed role, address indexed account, bool granted);

    error MissingRole(bytes32 role, address account);

    modifier onlyRole(bytes32 role) {
        if (!_members[role][msg.sender]) revert MissingRole(role, msg.sender);
        _;
    }

    constructor(address admin) {
        _members[DEFAULT_ADMIN_ROLE][admin] = true;
        emit RoleUpdated(DEFAULT_ADMIN_ROLE, admin, true);
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _members[role][account];
    }

    function setRole(bytes32 role, address account, bool granted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _members[role][account] = granted;
        emit RoleUpdated(role, account, granted);
    }
}

/// @title ProtocolFeeRouterV2
/// @notice Splits protocol fees between the treasury and the staking sink.
contract ProtocolFeeRouterV2 is RoleRegistry {
    bytes32 public constant FEE_ADMIN_ROLE = keccak256("FEE_ADMIN_ROLE");
    uint16 public constant MAX_BPS = 10_000;

    address public treasury;
    address public stakingSink;
    uint16 public treasuryBps;

    event TreasuryUpdated(address treasury, uint16 bps);
    event StakingSinkUpdated(address sink);
    event FeesRouted(address indexed token, uint256 toTreasury, uint256 toStaking);

    error BpsTooHigh();
    error TokenTransferFailed();

    constructor(address admin, address treasury_, address sink_) RoleRegistry(admin) {
        treasury = treasury_;
        stakingSink = sink_;
        treasuryBps = 5_000;
    }

    function setTreasury(address treasury_, uint16 bps) external onlyRole(FEE_ADMIN_ROLE) {
        if (bps > MAX_BPS) revert BpsTooHigh();
        treasury = treasury_;
        treasuryBps = bps;
        emit TreasuryUpdated(treasury_, bps);
    }

    function setStakingSink(address sink) external onlyRole(FEE_ADMIN_ROLE) {
        stakingSink = sink;
        emit StakingSinkUpdated(sink);
    }

    /// @notice Pull `amount` of fees from the caller and split them.
    function route(IFeeToken token, uint256 amount) external {
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TokenTransferFailed();
        uint256 toTreasury = (amount * treasuryBps) / MAX_BPS;
        uint256 toStaking = amount - toTreasury;
        if (!token.transfer(treasury, toTreasury)) revert TokenTransferFailed();
        if (!token.transfer(stakingSink, toStaking)) revert TokenTransferFailed();
        emit FeesRouted(address(token), toTreasury, toStaking);
    }
}
