import "dotenv/config";
import { http, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env variable: ${name}`);
  return v.trim();
}

export const ZERODEV_RPC = requireEnv("ZERODEV_RPC");
export const HOOK_ADDRESS = requireEnv("HOOK_ADDRESS") as `0x${string}`;
export const TARGET_ADDRESS = requireEnv("TARGET_ADDRESS") as `0x${string}`;

export const owner = privateKeyToAccount(requireEnv("OWNER_PRIVATE_KEY") as `0x${string}`);
export const entryPoint = getEntryPoint("0.7");
export const kernelVersion = KERNEL_V3_1;

export async function setup() {
  const publicClient = createPublicClient({
    transport: http(ZERODEV_RPC),
    chain: sepolia,
  });

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: owner,
    entryPoint,
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion,
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: sepolia,
    bundlerTransport: http(ZERODEV_RPC),
  });

  return { publicClient, account, kernelClient };
}