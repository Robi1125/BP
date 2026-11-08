import { http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import type { KernelValidatorHook } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { toSudoPolicy } from "@zerodev/permissions/policies";
import {
  setup,
  owner,
  entryPoint,
  kernelVersion,
  ZERODEV_RPC,
  HOOK_ADDRESS,
} from "./common.js";

export const hookAbi = [
  {
    type: "function",
    name: "usedInWindow",
    inputs: [{ name: "acc", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Session key kliens, amelynek a validátorához kötődik a hook.
 * A hook a regular (session key) validátorra vonatkozik, az owner (root) szabad marad.
 * Az account címe megegyezik a sima owner account címével.
 */
export async function buildSession(opts: { hookInitData: Hex; sessionKey?: Hex }) {
  const { publicClient, account: ownerAccount } = await setup();
  const accountAddress = ownerAccount.address;

  const sessionKey = opts.sessionKey ?? generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionKey);

  // FIGYELEM: a toSudoPolicy({}) csak teszteléshez jó, élesben Call/Gas/Rate Limit policy kell.
  const sessionSigner = await toECDSASigner({ signer: sessionAccount });
  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies: [toSudoPolicy({})],
  });

  const hook: KernelValidatorHook = {
    getIdentifier: () => HOOK_ADDRESS,
    getEnableData: async () => opts.hookInitData,
  };

  const ownerValidator = await signerToEcdsaValidator(publicClient, {
    signer: owner,
    entryPoint,
    kernelVersion,
  });

  const sessionKernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ownerValidator, regular: permissionValidator, hook },
    entryPoint,
    kernelVersion,
  });
  if (sessionKernelAccount.address.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error(
      `Az account címe eltér (${sessionKernelAccount.address} vs ${accountAddress}).`
    );
  }

  const sessionClient = createKernelAccountClient({
    account: sessionKernelAccount,
    chain: sepolia,
    bundlerTransport: http(ZERODEV_RPC),
  });

  const usedInWindow = async () =>
    publicClient.readContract({
      address: HOOK_ADDRESS,
      abi: hookAbi,
      functionName: "usedInWindow",
      args: [accountAddress],
    });

  return {
    publicClient,
    accountAddress,
    sessionKey,
    sessionAccount,
    sessionKernelAccount,
    sessionClient,
    usedInWindow,
  };
}