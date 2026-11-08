// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SlidingWindowSpendingHook} from "../src/SlidingWindowSpendingHook.sol";

contract SlidingWindowSpendingHookTest is Test {
    SlidingWindowSpendingHook hook;
    address acc = address(0xA11CE);
    address shortAcc = address(0xC0FFEE);
    uint256 t0;

    function setUp() public {
        hook = new SlidingWindowSpendingHook();
        t0 = 1_000_000 * 1 hours; // bucket-határra igazítva
        vm.warp(t0);

        // 24 órás konfiguráció: per-tx 0.01, ablak 0.2, bucket 1h, span 24
        vm.deal(acc, 100 ether);
        vm.prank(acc);
        hook.onInstall(abi.encode(0.01 ether, 0.2 ether, uint256(3600), uint256(24)));

        // 5 perces konfiguráció: per-tx 0.002, ablak 0.004, bucket 60s, span 5
        vm.deal(shortAcc, 100 ether);
        vm.prank(shortAcc);
        hook.onInstall(abi.encode(0.002 ether, 0.004 ether, uint256(60), uint256(5)));
    }

    // Egy hívás szimulálása: preCheck -> egyenleg csökken -> postCheck
    function _spend(address a, uint256 v) internal {
        vm.prank(a);
        bytes memory d = hook.preCheck(address(0), 0, "");
        vm.deal(a, a.balance - v);
        vm.prank(a);
        hook.postCheck(d);
    }

    function _spendN(address a, uint256 n, uint256 v) internal {
        for (uint256 i; i < n; ++i) _spend(a, v);
    }

    function _expectSpendReverts(address a, uint256 v, bytes memory reason) internal {
        vm.prank(a);
        bytes memory d = hook.preCheck(address(0), 0, "");
        vm.deal(a, a.balance - v);
        vm.expectRevert(reason);
        vm.prank(a);
        hook.postCheck(d);
    }

    // ---------- 24 órás ablak ----------

    function test_allowsUpToLimit() public {
        _spendN(acc, 20, 0.01 ether);
        assertEq(hook.usedInWindow(acc), 0.2 ether);
    }

    function test_rejectsOverPeriodLimit() public {
        _spendN(acc, 20, 0.01 ether);
        _expectSpendReverts(acc, 0.01 ether, bytes("window limit (post)"));
    }

    function test_rejectsOverPerTxLimit() public {
        _expectSpendReverts(acc, 0.011 ether, bytes("per-tx limit (post)"));
    }

    function test_windowSlides24h() public {
        _spendN(acc, 20, 0.01 ether);

        vm.warp(t0 + 25 hours - 1); // az első bucket még számít
        _expectSpendReverts(acc, 0.01 ether, bytes("window limit (post)"));

        vm.warp(t0 + 25 hours); // lejárt
        assertEq(hook.usedInWindow(acc), 0);
        _spend(acc, 0.01 ether);
    }

    function test_partialExpiry() public {
        _spendN(acc, 10, 0.01 ether); // t0: 0.1
        vm.warp(t0 + 12 hours);
        _spendN(acc, 10, 0.01 ether); // +12h: 0.1
        assertEq(hook.usedInWindow(acc), 0.2 ether);

        vm.warp(t0 + 25 hours); // az első 0.1 lejár, a második marad
        assertEq(hook.usedInWindow(acc), 0.1 ether);
    }

    // ---------- 5 perces ablak ----------

    function test_shortWindow_5min() public {
        _spend(shortAcc, 0.002 ether); // t0
        vm.warp(t0 + 30);
        _spend(shortAcc, 0.002 ether); // ugyanabban a bucketben
        vm.warp(t0 + 60);
        _expectSpendReverts(shortAcc, 0.002 ether, bytes("window limit (post)"));

        vm.warp(t0 + 6 minutes - 1); // még számít
        _expectSpendReverts(shortAcc, 0.002 ether, bytes("window limit (post)"));

        vm.warp(t0 + 6 minutes); // lejárt
        assertEq(hook.usedInWindow(shortAcc), 0);
        _spend(shortAcc, 0.002 ether);
    }

    // ---------- egyéb ----------

    // Batch / közvetett kiadás: a calldata value 0, de az egyenleg csökken
    function test_balanceDeltaCatchesIndirectSpend() public {
        _expectSpendReverts(acc, 0.012 ether, bytes("per-tx limit (post)"));
    }

    function test_uninstallDoesNotRevert() public {
        _spendN(acc, 5, 0.01 ether);
        vm.prank(acc);
        hook.onUninstall("");
        assertFalse(hook.isInitialized(acc));
        assertEq(hook.usedInWindow(acc), 0);
    }

    function test_rejectsBadInstallParams() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(bytes("bad span"));
        hook.onInstall(abi.encode(1, 1, uint256(60), uint256(0)));
        vm.expectRevert(bytes("bad span"));
        hook.onInstall(abi.encode(1, 1, uint256(60), uint256(25)));
        vm.expectRevert(bytes("bad bucket"));
        hook.onInstall(abi.encode(1, 1, uint256(0), uint256(5)));
        vm.expectRevert(bytes("bad limit"));
        hook.onInstall(abi.encode(1, 0, uint256(60), uint256(5)));
        vm.stopPrank();
    }
}
