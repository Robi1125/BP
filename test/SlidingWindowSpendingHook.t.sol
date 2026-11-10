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
        t0 = 1_000_000 * 1 hours; // aligned to a bucket boundary
        vm.warp(t0);

        // 24-hour config: per-tx 0.01, window 0.2, bucket 1h, span 24
        vm.deal(acc, 100 ether);
        vm.startPrank(acc);
        hook.onInstall(""); // enable mode calls this; the config is set via setConfig
        hook.setConfig(0.01 ether, 0.2 ether, 3600, 24);
        vm.stopPrank();

        // 5-minute config: per-tx 0.002, window 0.004, bucket 60s, span 5
        vm.deal(shortAcc, 100 ether);
        vm.startPrank(shortAcc);
        hook.onInstall("");
        hook.setConfig(0.002 ether, 0.004 ether, 60, 5);
        vm.stopPrank();
    }

    // Simulates one call: preCheck -> balance decreases -> postCheck
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

    // ---------- 24-hour window ----------

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

        vm.warp(t0 + 25 hours - 1); // the first bucket still counts
        _expectSpendReverts(acc, 0.01 ether, bytes("window limit (post)"));

        vm.warp(t0 + 25 hours); // expired
        assertEq(hook.usedInWindow(acc), 0);
        _spend(acc, 0.01 ether);
    }

    function test_partialExpiry() public {
        _spendN(acc, 10, 0.01 ether); // t0: 0.1
        vm.warp(t0 + 12 hours);
        _spendN(acc, 10, 0.01 ether); // +12h: 0.1
        assertEq(hook.usedInWindow(acc), 0.2 ether);

        vm.warp(t0 + 25 hours); // the first 0.1 expires, the second stays
        assertEq(hook.usedInWindow(acc), 0.1 ether);
    }

    // ---------- 5-minute window ----------

    function test_shortWindow_5min() public {
        _spend(shortAcc, 0.002 ether); // t0
        vm.warp(t0 + 30);
        _spend(shortAcc, 0.002 ether); // same bucket
        vm.warp(t0 + 60);
        _expectSpendReverts(shortAcc, 0.002 ether, bytes("window limit (post)"));

        vm.warp(t0 + 6 minutes - 1); // still counts
        _expectSpendReverts(shortAcc, 0.002 ether, bytes("window limit (post)"));

        vm.warp(t0 + 6 minutes); // expired
        assertEq(hook.usedInWindow(shortAcc), 0);
        _spend(shortAcc, 0.002 ether);
    }

    // ---------- other ----------

    // Batch / indirect spend: the calldata value is 0, but the balance decreases
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

    function test_rejectsBadConfig() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(bytes("bad span"));
        hook.setConfig(1, 1, 60, 0);
        vm.expectRevert(bytes("bad span"));
        hook.setConfig(1, 1, 60, 25);
        vm.expectRevert(bytes("bad bucket"));
        hook.setConfig(1, 1, 0, 5);
        vm.expectRevert(bytes("bad limit"));
        hook.setConfig(1, 0, 60, 5);
        vm.stopPrank();
    }

    // An account without a config blocks all spending (fail-closed)
    function test_unconfiguredBlocksEverything() public {
        address fresh = address(0xFEED);
        vm.deal(fresh, 1 ether);
        vm.prank(fresh);
        bytes memory d = hook.preCheck(address(0), 0, "");
        vm.deal(fresh, fresh.balance - 1);
        vm.expectRevert(bytes("per-tx limit (post)"));
        vm.prank(fresh);
        hook.postCheck(d);
    }

    // Changing only the limits keeps the spending history
    function test_limitChangeKeepsHistory() public {
        _spendN(acc, 10, 0.01 ether);
        vm.prank(acc);
        hook.setConfig(0.01 ether, 0.5 ether, 3600, 24);
        assertEq(hook.usedInWindow(acc), 0.1 ether);
    }

    // Changing bucket or span clears the history
    function test_windowChangeClearsHistory() public {
        _spendN(acc, 10, 0.01 ether);
        vm.prank(acc);
        hook.setConfig(0.01 ether, 0.2 ether, 1800, 24);
        assertEq(hook.usedInWindow(acc), 0);
    }
}
