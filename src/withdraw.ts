import { parseEther } from "viem";
import { setup, owner } from "./common.js";

// Moves ETH from the Kernel account back to the owner EOA (change the amount as needed).
const { kernelClient, account } = await setup();
const hash = await kernelClient.sendUserOperation({
  callData: await account.encodeCalls([
    { to: owner.address, value: parseEther("0.006"), data: "0x" },
  ]),
});
const r = await kernelClient.waitForUserOperationReceipt({ hash });
console.log("OK", r.receipt.transactionHash);
