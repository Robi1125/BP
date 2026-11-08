import {
  parseEther,
  encodeAbiParameters,
  parseAbiParameters,
  formatEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import type { KernelValidatorHook } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import { http } from "viem";
import { sepolia } from "viem/chains";
import {
  setup,
  owner,
  entryPoint,
  kernelVersion,
  ZERODEV_RPC,
  HOOK_ADDRESS,
  TARGET_ADDRESS,
} from "./common.js";

// Limitek: 0.01 ETH / tranzakció, 0.2 ETH / csúszó 24 óra
const PER_TX_LIMIT = parseEther("0.01");
const PERIOD_LIMIT = parseEther("0.2");

const hookAbi = [
  {
    type: "function",
    name: "usedIn24h",
    inputs: [{ name: "acc", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main() {
  const { publicClient, account: ownerAccount } = await setup();
  const accountAddress = ownerAccount.address;
  console.log("Kernel account address:", accountAddress);
  console.log(
    "Account balance:",
    formatEther(await publicClient.getBalance({ address: accountAddress })),
    "ETH"
  );

  // --- Session key (teszt kulcs; a botnál ez lesz az agent kulcsa) ---
  let sessionKey = process.env.SESSION_PRIVATE_KEY as `0x${string}` | undefined;
  if (!sessionKey) {
    sessionKey = generatePrivateKey();
    console.log("\nSESSION_PRIVATE_KEY nincs megadva, generáltam egy tesztkulcsot.");
    console.log("Ha ugyanezt akarod használni legközelebb, tedd a .env-be:");
    console.log(`SESSION_PRIVATE_KEY=${sessionKey}\n`);
  }
  const sessionAccount = privateKeyToAccount(sessionKey);
  console.log("Session key address:", sessionAccount.address);

  // --- Permission validator a session keyhez ---
  // FIGYELEM: a toSudoPolicy({}) csak teszteléshez jó, élesben Call/Gas/Rate Limit policy kell.
  const sessionSigner = await toECDSASigner({ signer: sessionAccount });
  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies: [toSudoPolicy({})],
  });

  // --- A hook a REGULAR (session key) validátorhoz kötődik ---
  const hookInitData = encodeAbiParameters(
    parseAbiParameters("uint256 perTxLimit, uint256 periodLimit"),
    [PER_TX_LIMIT, PERIOD_LIMIT]
  );
  const hook: KernelValidatorHook = {
    getIdentifier: () => HOOK_ADDRESS,
    getEnableData: async () => hookInitData,
  };

  const ownerValidator = await signerToEcdsaValidator(publicClient, {
    signer: owner,
    entryPoint,
    kernelVersion,
  });

  // sudo + regular + hook: a hook a regular validátorra vonatkozik,
  // a root (owner) validátorra nem. Az account címe nem változik.
  const sessionKernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ownerValidator, regular: permissionValidator, hook },
    entryPoint,
    kernelVersion,
  });
  if (sessionKernelAccount.address.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error(
      `Az account címe eltér (${sessionKernelAccount.address} vs ${accountAddress}), ` +
        "ellenőrizd az index/plugin beállításokat."
    );
  }
  const sessionClient = createKernelAccountClient({
    account: sessionKernelAccount,
    chain: sepolia,
    bundlerTransport: http(ZERODEV_RPC),
  });

  const used = async () =>
    publicClient.readContract({
      address: HOOK_ADDRESS,
      abi: hookAbi,
      functionName: "usedIn24h",
      args: [accountAddress],
    });
  console.log("\nUsed in last 24h (wei):", await used());

  const send = async (label: string, calls: { value: string }[], expectOk: boolean) => {
    console.log(`\n[session key] ${label}`);
    try {
      const hash = await sessionClient.sendUserOperation({
        callData: await sessionKernelAccount.encodeCalls(
          calls.map((c) => ({ to: TARGET_ADDRESS, value: parseEther(c.value), data: "0x" as const }))
        ),
      });
      const receipt = await sessionClient.waitForUserOperationReceipt({ hash });
      console.log(
        expectOk ? "OK, mint várt. Tx:" : "VÁRATLAN SIKER, a hook nem védett! Tx:",
        receipt.receipt.transactionHash
      );
    } catch (error) {
      const msg = (error as Error).message.split("\n").slice(0, 6).join("\n");
      console.log(expectOk ? "VÁRATLAN ELUTASÍTÁS:" : "Elutasítva, mint várt:");
      console.log(msg);
    }
    console.log("Used in last 24h (wei):", await used());
  };

  // 1) limit alatt: az első küldés egyben telepíti (enable mode) a permissiont a hookkal
  await send("0.005 ETH (limit alatt)", [{ value: "0.005" }], true);
  // 2) tranzakciónkénti limit felett
  await send("0.02 ETH (per-tx limit felett)", [{ value: "0.02" }], false);
  // 3) batch: 2 x 0.006, az összeg átlépi a per-tx limitet
  await send("batch 2 x 0.006 ETH", [{ value: "0.006" }, { value: "0.006" }], false);

  // 4) az owner továbbra is szabad (root validator, nincs hook)
  console.log("\n[owner] 0.02 ETH, a hook nem vonatkozik rá");
  try {
    const { kernelClient, account } = await setup();
    const hash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([
        { to: TARGET_ADDRESS, value: parseEther("0.02"), data: "0x" },
      ]),
    });
    const receipt = await kernelClient.waitForUserOperationReceipt({ hash });
    console.log("OK, az owner nincs korlátozva. Tx:", receipt.receipt.transactionHash);
  } catch (error) {
    console.log("Owner küldés hibás:", (error as Error).message.split("\n").slice(0, 4).join("\n"));
  }
}

main();