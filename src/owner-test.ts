import { parseEther } from "viem";
import { setup, TARGET_ADDRESS } from "./common.js";

// Control test: the owner sends without any hook (checks account, bundler and gas).
const { kernelClient, account } = await setup();
const hash = await kernelClient.sendUserOperation({
  callData: await account.encodeCalls([
    { to: TARGET_ADDRESS, value: parseEther("0.001"), data: "0x" },
  ]),
});
const r = await kernelClient.waitForUserOperationReceipt({ hash });
console.log("OK", r.receipt.transactionHash);
