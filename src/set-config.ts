import { parseEther, encodeFunctionData } from "viem";
import { setup, HOOK_ADDRESS } from "./common.js";

const setConfigAbi = [
  {
    type: "function",
    name: "setConfig",
    inputs: [
      { name: "perTx", type: "uint256" },
      { name: "period", type: "uint256" },
      { name: "bucket", type: "uint256" },
      { name: "span", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** The owner (sudo validator) calls the hook's setConfig from the account itself. */
export async function applyConfig(perTx: bigint, period: bigint, bucket: bigint, span: bigint) {
  const { kernelClient, account } = await setup();
  const hash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([
      {
        to: HOOK_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: setConfigAbi,
          functionName: "setConfig",
          args: [perTx, period, bucket, span],
        }),
      },
    ]),
  });
  const r = await kernelClient.waitForUserOperationReceipt({ hash });
  console.log("Config set. Tx:", r.receipt.transactionHash);
}

// Standalone run: npx tsx src/set-config.ts
if (process.argv[1]?.endsWith("set-config.ts")) {
  await applyConfig(parseEther("0.003"), parseEther("0.005"), 60n, 5n);
}
