import { parseEther, encodeAbiParameters, parseAbiParameters, formatEther } from "viem";
import { TARGET_ADDRESS } from "./common.js";
import { buildSession } from "./session.js";

// 5 perces ablak: 0.002 ETH / tranzakció, 0.004 ETH / ablak
// bucket = 60 s, span = 5  ->  egy kiadás 5-6 percig számít bele az ablakba
const PER_TX = parseEther("0.002");
const PERIOD = parseEther("0.004");
const hookInitData = encodeAbiParameters(
  parseAbiParameters("uint256 perTxLimit, uint256 periodLimit, uint256 bucketSeconds, uint256 spanBuckets"),
  [PER_TX, PERIOD, 60n, 5n]
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 9 * 60 * 1000;

async function main() {
  // Mindig új session kulcs: így az enable mode az ÚJ hookkal telepíti a permissiont.
  const s = await buildSession({ hookInitData });
  console.log("Kernel account:", s.accountAddress);
  console.log("Balance:", formatEther(await s.publicClient.getBalance({ address: s.accountAddress })), "ETH");
  console.log("Session key address:", s.sessionAccount.address);

  const start = Date.now();
  const stamp = () => {
    const sec = Math.round((Date.now() - start) / 1000);
    return `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}]`;
  };
  const fmt = (w: bigint) => `${formatEther(w)} ETH`;

  const trySend = async (label: string) => {
    try {
      const hash = await s.sessionClient.sendUserOperation({
        callData: await s.sessionKernelAccount.encodeCalls([
          { to: TARGET_ADDRESS, value: PER_TX, data: "0x" },
        ]),
      });
      await s.sessionClient.waitForUserOperationReceipt({ hash });
      console.log(`${stamp()} ${label}: ELFOGADVA   used=${fmt(await s.usedInWindow())}`);
      return true;
    } catch (error) {
      const first = (error as Error).message.split("\n")[0];
      console.log(`${stamp()} ${label}: ELUTASÍTVA  (${first.slice(0, 90)})`);
      return false;
    }
  };

  console.log(`\nKonfiguráció: per-tx ${fmt(PER_TX)}, ablak-limit ${fmt(PERIOD)}, ablak ~5 perc`);
  console.log(`${stamp()} used=${fmt(await s.usedInWindow())}\n`);

  const r1 = await trySend("1. küldés (0.002)");
  const r2 = await trySend("2. küldés (0.002)");
  const r3 = await trySend("3. küldés (0.002), elutasítást várunk");
  console.log(`\nElső három lépés: ${r1 && r2 && !r3 ? "RENDBEN" : "HIBÁS, nézd meg a fenti sorokat"}`);
  if (!(r1 && r2 && !r3)) return;

  console.log("\nVárunk, amíg a régi kiadások kicsúsznak az ablakból (kb. 5-6 perc)...");
  while (Date.now() - start < MAX_WAIT_MS) {
    const used = await s.usedInWindow();
    console.log(`${stamp()} used=${fmt(used)}`);
    if (used + PER_TX <= PERIOD) {
      if (await trySend("4. küldés a várakozás után")) {
        console.log("\nKész: az ablak elcsúszott, a limit újra felszabadult.");
        return;
      }
    }
    await sleep(15_000);
  }
  console.log("\nIdőtúllépés: az ablak nem szabadult fel a várt időn belül.");
}

main();