import {
  parseEther,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { setup, HOOK_ADDRESS, TARGET_ADDRESS } from "./common.js";

const MODULE_TYPE_HOOK = 4n;

// Limitek: 0.01 ETH / tranzakció, 0.2 ETH / csúszó 24 óra
const PER_TX_LIMIT = parseEther("0.01");
const PERIOD_LIMIT = parseEther("0.2");

const installModuleAbi = [
  {
    type: "function",
    name: "installModule",
    inputs: [
      { name: "moduleTypeId", type: "uint256" },
      { name: "module", type: "address" },
      { name: "initData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const hookAbi = [
  {
    type: "function",
    name: "isInitialized",
    inputs: [{ name: "smartAccount", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "usedIn24h",
    inputs: [{ name: "acc", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main() {
  const { publicClient, account, kernelClient } = await setup();
  console.log("Kernel account address:", account.address);

  const alreadyInstalled = await publicClient.readContract({
    address: HOOK_ADDRESS,
    abi: hookAbi,
    functionName: "isInitialized",
    args: [account.address],
  });

  if (alreadyInstalled) {
    console.log("Hook already installed, skipping.");
  } else {
    console.log("Installing hook...");

    // FIGYELEM: az új hook két értéket vár: (perTxLimit, periodLimit)
    const initData = encodeAbiParameters(
      parseAbiParameters("uint256 perTxLimit, uint256 periodLimit"),
      [PER_TX_LIMIT, PERIOD_LIMIT]
    );

    const installCallData = encodeFunctionData({
      abi: installModuleAbi,
      functionName: "installModule",
      args: [MODULE_TYPE_HOOK, HOOK_ADDRESS, initData],
    });

    const installHash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([
        { to: account.address, value: 0n, data: installCallData },
      ]),
    });
    const installReceipt = await kernelClient.waitForUserOperationReceipt({ hash: installHash });
    console.log("Hook installed! Tx:", installReceipt.receipt.transactionHash);
  }

  const used = async () =>
    publicClient.readContract({
      address: HOOK_ADDRESS,
      abi: hookAbi,
      functionName: "usedIn24h",
      args: [account.address],
    });

  console.log("\nUsed in last 24h before tests (wei):", await used());

  // --- Limit alatt: sikeres ---
  console.log("\nSending UNDER the limit (0.005 ETH)...");
  try {
    const hash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([
        { to: TARGET_ADDRESS, value: parseEther("0.005"), data: "0x" },
      ]),
    });
    const receipt = await kernelClient.waitForUserOperationReceipt({ hash });
    console.log("Success! Tx:", receipt.receipt.transactionHash);
    console.log("Used in last 24h (wei):", await used());
  } catch (error) {
    console.log("Unexpected rejection:", error);
  }

  // --- Tranzakciónkénti limit felett: elutasítva ---
  console.log("\nSending OVER the per-tx limit (0.02 ETH)...");
  try {
    const hash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([
        { to: TARGET_ADDRESS, value: parseEther("0.02"), data: "0x" },
      ]),
    });
    console.log("UNEXPECTED SUCCESS, the hook is not working! UserOp hash:", hash);
  } catch (error) {
    console.log("Correctly rejected by the hook:");
    console.log(error);
  }

  // --- Batch: 2 x 0.006 ETH, az összeg átlépi a per-tx limitet ---
  console.log("\nSending batch (2 x 0.006 ETH = 0.012 ETH, above per-tx limit)...");
  try {
    const hash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([
        { to: TARGET_ADDRESS, value: parseEther("0.006"), data: "0x" },
        { to: TARGET_ADDRESS, value: parseEther("0.006"), data: "0x" },
      ]),
    });
    console.log("UNEXPECTED SUCCESS, batch bypasses the hook! UserOp hash:", hash);
  } catch (error) {
    console.log("Correctly rejected, batch is covered too:");
    console.log(error);
  }
}

main();
