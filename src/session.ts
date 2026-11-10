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
 * Builds a session key client whose validator the hook is attached to.
 * The hook applies to the regular (session key) validator; the owner (root) stays unrestricted.
 * The account address is the same as the plain owner account's address.
 *
 * hookInitData is passed to the SDK as the hook's enable data. The current hook ignores it
 * (the limits are set with setConfig), but the SDK needs some value.
 */
export async function buildSession(opts: { hookInitData: Hex; sessionKey?: Hex }) {
  const { publicClient, account: ownerAccount } = await setup();
  const accountAddress = ownerAccount.address;

  const sessionKey = opts.sessionKey ?? generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionKey);

  // WARNING: toSudoPolicy({}) is only for testing. In production use call/gas/rate-limit
  // policies, and make sure the session key cannot call the hook's setConfig.
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
      `Account address mismatch (${sessionKernelAccount.address} vs ${accountAddress}).`
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
