// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal ERC-7579 interfaces (compatible with IERC7579Modules.sol of the Kernel repo)
interface IModule {
    function onInstall(bytes calldata data) external payable;
    function onUninstall(bytes calldata data) external payable;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
}

interface IHook is IModule {
    function preCheck(address msgSender, uint256 value, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData);

    function postCheck(bytes calldata hookData) external payable;
}

/// @notice Sliding-window ETH spending limit plus a per-transaction limit.
/// The window consists of `span` buckets of `bucket` seconds each (ring buffer, span+1 slots).
/// Conservative approximation: a spend counts towards the window for at least span*bucket and
/// at most (span+1)*bucket, so in no span*bucket long period can more than the limit be spent.
///   - production: bucket = 3600, span = 24  (about 24 hours)
///   - test:       bucket = 60,   span = 5   (about 5 minutes)
///
/// Configuration is NOT done in onInstall (it may run during the validation phase, where
/// ERC-7562 storage/opcode rules apply). Instead, the account calls setConfig on itself
/// during the execution phase. Until then periodLimit is 0 and every spend is rejected.
contract SlidingWindowSpendingHook is IHook {
    uint256 internal constant MODULE_TYPE_HOOK = 4;
    uint256 internal constant MAX_SPAN = 24;
    uint256 internal constant SLOTS = MAX_SPAN + 1;

    struct Config {
        uint128 perTxLimit;
        uint128 periodLimit; // 0 = not configured -> all spending is blocked
        uint32 bucket; // seconds
        uint8 span; // number of buckets in the window (1..24)
    }

    struct Slot {
        uint64 id; // bucket index (timestamp / bucket)
        uint192 amount; // wei spent in this bucket
    }

    mapping(address => Config) public config;
    mapping(address => bool) public installed;
    mapping(address => Slot[SLOTS]) private _slots;

    event Spent(address indexed account, uint256 amount, uint256 usedInWindow, uint256 limit);
    event ConfigSet(address indexed account, uint256 perTx, uint256 period, uint256 bucket, uint256 span);

    // ---------------- IModule ----------------

    /// Minimal on purpose: may run in the validation phase (enable mode). The data is ignored.
    function onInstall(bytes calldata) external payable {
        installed[msg.sender] = true;
    }

    /// Must not revert, otherwise the owner could not remove the hook.
    function onUninstall(bytes calldata) external payable {
        delete installed[msg.sender];
        delete config[msg.sender];
        delete _slots[msg.sender];
    }

    function isModuleType(uint256 id) external pure returns (bool) {
        return id == MODULE_TYPE_HOOK;
    }

    function isInitialized(address acc) external view returns (bool) {
        return installed[acc];
    }

    // ---------------- configuration (the account calls this on itself) ----------------

    /// If only the limits change, the history is kept.
    /// If bucket or span change, the ring buffer loses its meaning, so it is cleared.
    function setConfig(uint256 perTx, uint256 period, uint256 bucket, uint256 span) external {
        require(period > 0 && period <= type(uint128).max, "bad limit");
        require(perTx <= type(uint128).max, "bad perTx");
        require(bucket > 0 && bucket <= type(uint32).max, "bad bucket");
        require(span > 0 && span <= MAX_SPAN, "bad span");

        Config memory old = config[msg.sender];
        if (old.bucket != bucket || old.span != span) {
            delete _slots[msg.sender];
        }
        config[msg.sender] = Config(uint128(perTx), uint128(period), uint32(bucket), uint8(span));
        emit ConfigSet(msg.sender, perTx, period, bucket, span);
    }

    // ---------------- IHook (execution phase) ----------------

    function preCheck(address, uint256 value, bytes calldata) external payable returns (bytes memory) {
        Config memory c = config[msg.sender];
        require(value <= c.perTxLimit, "per-tx limit");
        uint256 used = _used(msg.sender, c);
        require(used + value <= c.periodLimit, "window limit (pre)");
        return abi.encode(msg.sender.balance, used);
    }

    function postCheck(bytes calldata hookData) external payable {
        (uint256 balBefore, uint256 used) = abi.decode(hookData, (uint256, uint256));
        uint256 balAfter = msg.sender.balance;
        // The real spend is measured as the balance decrease, so batches and indirect
        // transfers (where the calldata value is 0) are covered as well.
        uint256 spent = balBefore > balAfter ? balBefore - balAfter : 0;

        Config memory c = config[msg.sender];
        require(spent <= c.perTxLimit, "per-tx limit (post)");
        require(used + spent <= c.periodLimit, "window limit (post)");

        if (spent > 0) {
            _record(msg.sender, c, spent);
            emit Spent(msg.sender, spent, used + spent, c.periodLimit);
        }
    }

    // ---------------- views ----------------

    function usedInWindow(address acc) external view returns (uint256) {
        return _used(acc, config[acc]);
    }

    // ---------------- internal logic ----------------

    function _used(address acc, Config memory c) internal view returns (uint256 sum) {
        if (c.bucket == 0) return 0;
        uint256 cur = block.timestamp / c.bucket;
        uint256 n = uint256(c.span) + 1;
        for (uint256 i; i < n; ++i) {
            Slot storage s = _slots[acc][i];
            if (s.amount != 0 && s.id + c.span >= cur) sum += s.amount;
        }
    }

    function _record(address acc, Config memory c, uint256 spent) internal {
        uint256 cur = block.timestamp / c.bucket;
        Slot storage s = _slots[acc][cur % (uint256(c.span) + 1)];
        if (s.id != cur) {
            s.id = uint64(cur);
            s.amount = 0;
        }
        s.amount += uint192(spent);
    }
}
