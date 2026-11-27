// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "../src/Admin.sol";
import "../src/Misc.sol";

contract Stranger {
    function takeConfig(Config c) external { c.transferOwner(address(this)); }
    function takeMisc(Misc m) external { m.initOnce(address(this)); }
}

contract LabelCheck {
    function test_transferOwner_anyCallerBecomesOwner() public {
        Config c = new Config();                       // this test contract is the deployer and owner
        Stranger s = new Stranger();
        s.takeConfig(c);                               // a non-owner calls transferOwner with its own address
        require(c.owner() == address(s), "stranger did not become owner");
    }
    function test_transferOwner_toSomeoneElseReverts() public {
        Config c = new Config(); Stranger s = new Stranger();
        try c.transferOwner(address(s)) { revert("expected revert"); } catch {} // owner handing to another address reverts: the check is inverted, not absent
        require(c.owner() == address(this), "owner changed");
    }
    function test_initOnce_firstCallerReplacesConstructorOwner() public {
        Misc m = new Misc();
        Stranger s = new Stranger();
        s.takeMisc(m);
        require(m.owner() == address(s), "stranger did not take ownership");
    }
}
