import { parseEther, encodeAbiParameters, parseAbiParameters, formatEther, parseAbi, parseEventLogs } from "viem";
import { TARGET_ADDRESS } from "./common.js";
import { buildSession } from "./session.js";
import { applyConfig } from "./set-config.js";

// ~5 minute window: bucket = 60 s, span = 5 -> a spend counts for 5-6 minutes.
// Each send is 0.002 ETH and the window allows 0.006, so exactly 3 sends fit.
//
// Plan:
//   Sends 1-3: quick, in a row, all must be accepted.
//   Send 4:    right after, must be rejected by the hook (window limit).
//   Send 5:    only after ALL earlier spends left the window (used = 0), must be accepted.
const PER_TX = parseEther("0.003");
const SEND = parseEther("0.002");
const PERIOD = parseEther("0.006");

// The hook ignores the enable data (limits are set via setConfig), but the SDK needs a value.
const hookInitData = encodeAbiParameters(
  parseAbiParameters("uint256 perTxLimit, uint256 periodLimit, uint256 bucketSeconds, uint256 spanBuckets"),
  [PER_TX, PERIOD, 60n, 5n]
);

const epAbi = parseAbi([
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
]);

// "window limit" and "per-tx limit" as hex, to recognize the hook's own revert strings
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const HOOK_WINDOW_MSG = toHex("window limit");
const HOOK_PERTX_MSG = toHex("per-tx limit");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_LIMIT_MS = 12 * 60 * 1000; // max wait for the window to clear

type SendResult =
  | { status: "accepted" }
  | { status: "reverted-onchain" }
  | { status: "rejected"; byHook: boolean };

async function main() {
  // Always a new session key, so the permission is enabled together with the hook again.
  const s = await buildSession({ hookInitData });

  // The owner sets the limits (execution phase, outside the validation rules).
  await applyConfig(PER_TX, PERIOD, 60n, 5n);

  console.log("Kernel account:", s.accountAddress);
  console.log("Balance:", formatEther(await s.publicClient.getBalance({ address: s.accountAddress })), "ETH");
  console.log("Session key address:", s.sessionAccount.address);

  const start = Date.now();
  const stamp = () => {
    const sec = Math.round((Date.now() - start) / 1000);
    return `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}]`;
  };
  const fmt = (w: bigint) => `${formatEther(w)} ETH`;

  const trySend = async (label: string): Promise<SendResult> => {
    const bal = formatEther(await s.publicClient.getBalance({ address: s.accountAddress }));
    console.log(`${stamp()} ${label}: balance=${bal}`);
    try {
      const hash = await s.sessionClient.sendUserOperation({  
        callData: await s.sessionKernelAccount.encodeCalls([
          { to: TARGET_ADDRESS, value: SEND, data: "0x" },
        ]),
      });
      const receipt = await s.sessionClient.waitForUserOperationReceipt({ hash });
      if (!receipt.success) {
        // Included in a block, but the execution reverted (not a simulation rejection).
        console.log(`${stamp()} ${label}: INCLUDED BUT REVERTED`);
        console.log("tx:", receipt.receipt.transactionHash, " gasUsed:", receipt.actualGasUsed);
        for (const e of parseEventLogs({ abi: epAbi, logs: receipt.receipt.logs })) {
          console.log("revertReason:", e.args.revertReason);
        }
        return { status: "reverted-onchain" };
      }
      console.log(`${stamp()} ${label}: ACCEPTED   used=${fmt(await s.usedInWindow())}`);
      return { status: "accepted" };
    } catch (error: any) {
      const details = String(error.details ?? "");
      const byHook = details.includes(HOOK_WINDOW_MSG) || details.includes(HOOK_PERTX_MSG);
      console.log(`${stamp()} ${label}: REJECTED${byHook ? " by the hook (window/per-tx limit)" : ""}`);
      console.log("shortMessage:", error.shortMessage);
      if (!byHook) console.log("details:", details.slice(0, 300));
      return { status: "rejected", byHook };
    }
  };

  console.log(`\nConfig: per-tx ${fmt(PER_TX)}, window limit ${fmt(PERIOD)}, window ~5 min, send ${fmt(SEND)}`);

  // Start clean: wait until spends of a previous run have left the window.
  while ((await s.usedInWindow()) > 0n) {
    console.log(`${stamp()} waiting for the previous run to leave the window, used=${fmt(await s.usedInWindow())}`);
    await sleep(15_000);
  }
  console.log(`${stamp()} used=${fmt(await s.usedInWindow())}\n`);

  // --- Sends 1-3: quick, in a row, all must be accepted ---
  const r1 = await trySend("Send 1 (0.002)");
  const r2 = await trySend("Send 2 (0.002)");
  const r3 = await trySend("Send 3 (0.002)");
  const firstThreeOk = r1.status === "accepted" && r2.status === "accepted" && r3.status === "accepted";
  console.log(`\nSends 1-3: ${firstThreeOk ? "OK (all accepted)" : "FAILED, check the lines above"}`);
  if (!firstThreeOk) return;
  const lastSpendAt = Date.now();

  // --- Send 4: right after, must be rejected by the hook ---
  console.log("");
  const r4 = await trySend("Send 4 (0.002), rejection expected");
  if (r4.status === "accepted") {
    console.log("\nSend 4: UNEXPECTED SUCCESS, the limit did not stop it!");
    return;
  }
  if (r4.status === "rejected" && r4.byHook) {
    console.log("\nSend 4: OK, rejected by the hook (limit enforced).");
  } else {
    console.log("\nSend 4: rejected/reverted, but NOT clearly by the hook's window limit message.");
  }

  // --- Send 5: only after ALL earlier spends left the window (used = 0) ---
  console.log("\nWaiting until all spends leave the window (about 5-6 minutes)...");
  while (Date.now() - lastSpendAt < WAIT_LIMIT_MS) {
    const used = await s.usedInWindow();
    console.log(`${stamp()} used=${fmt(used)}`);
    if (used === 0n) {
      const r5 = await trySend("Send 5 (0.002), outside the window");
      if (r5.status === "accepted") {
        console.log("\nDone: the window slid, send 5 went through outside the old window.");
      } else {
        console.log("\nSend 5 failed even though the window is empty, check the lines above.");
      }
      return;
    }
    await sleep(15_000);
  }
  console.log("\nTimeout: the window did not clear within the expected time.");
}

main();
