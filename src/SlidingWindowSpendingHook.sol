// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimális ERC-7579 interfészek (a Kernel repó IERC7579Modules.sol-jával kompatibilis)
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

/// @notice Csúszóablakos ETH költési limit + tranzakciónkénti limit.
/// Az ablak `span` darab `bucket` másodperces bucketből áll (ring buffer, span+1 slot).
/// Konzervatív közelítés: egy kiadás legalább span*bucket, legfeljebb (span+1)*bucket
/// ideig számít bele az ablakba, így egyetlen span*bucket hosszú szakaszban sem megy ki
/// a limitnél több.
///   - éles használat: bucket = 3600, span = 24  (kb. 24 óra)
///   - teszt:          bucket = 60,   span = 5   (kb. 5 perc)
contract SlidingWindowSpendingHook is IHook {
    uint256 internal constant MODULE_TYPE_HOOK = 4;
    uint256 internal constant MAX_SPAN = 24;
    uint256 internal constant SLOTS = MAX_SPAN + 1;

    struct Config {
        uint128 perTxLimit;
        uint128 periodLimit; // 0 = nincs telepítve
        uint32 bucket; // másodperc
        uint8 span; // bucketek száma az ablakban (1..24)
    }

    struct Slot {
        uint64 id; // bucket sorszáma (timestamp / bucket)
        uint192 amount; // ebben a bucketben kiadott wei
    }

    mapping(address => Config) public config;
    mapping(address => Slot[SLOTS]) private _slots;

    event Spent(address indexed account, uint256 amount, uint256 usedInWindow, uint256 limit);

    // ---------------- IModule ----------------

    /// @param data abi.encode(uint256 perTxLimit, uint256 periodLimit, uint256 bucketSeconds, uint256 spanBuckets)
    function onInstall(bytes calldata data) external payable {
        (uint256 perTx, uint256 period, uint256 bucket, uint256 span) =
            abi.decode(data, (uint256, uint256, uint256, uint256));
        require(period > 0 && period <= type(uint128).max, "bad limit");
        require(perTx <= type(uint128).max, "bad perTx");
        require(bucket > 0 && bucket <= type(uint32).max, "bad bucket");
        require(span > 0 && span <= MAX_SPAN, "bad span");

        // újratelepítésnél a régi előzmények törlődnek
        delete _slots[msg.sender];
        config[msg.sender] = Config(uint128(perTx), uint128(period), uint32(bucket), uint8(span));
    }

    /// Nem revertálhat, különben az owner nem tudja eltávolítani a hookot.
    function onUninstall(bytes calldata) external payable {
        delete config[msg.sender];
        delete _slots[msg.sender];
    }

    function isModuleType(uint256 id) external pure returns (bool) {
        return id == MODULE_TYPE_HOOK;
    }

    function isInitialized(address acc) external view returns (bool) {
        return config[acc].periodLimit != 0;
    }

    // ---------------- IHook ----------------

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
        uint256 spent = balBefore > balAfter ? balBefore - balAfter : 0;

        Config memory c = config[msg.sender];
        require(spent <= c.perTxLimit, "per-tx limit (post)");
        require(used + spent <= c.periodLimit, "window limit (post)");

        if (spent > 0) {
            _record(msg.sender, c, spent);
            emit Spent(msg.sender, spent, used + spent, c.periodLimit);
        }
    }

    // ---------------- view ----------------

    function usedInWindow(address acc) external view returns (uint256) {
        return _used(acc, config[acc]);
    }

    // ---------------- belső logika ----------------

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
