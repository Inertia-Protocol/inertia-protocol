import { antiSnipeRequiredTip, splitShare } from "../dist/antiSnipe.js";
import { KEEPER_SHARE_BPS } from "../dist/constants.js";

const buffer = 40_000_000n;
const keeperShare = splitShare(buffer, KEEPER_SHARE_BPS);

const cases = [
  // [slotsIntoRescue, expected]
  [1n, 36_000_000n], // first eligible slot: tip must equal the full reward
  [16n, 10_000n], // fully decayed: normal floor
  [100n, 10_000n], // well past decay: still floor
  [8n, 19_204_666n], // midpoint: hand-computed against the Rust formula
];

let allPassed = true;
for (const [slots, expected] of cases) {
  const actual = antiSnipeRequiredTip(keeperShare, slots);
  const pass = actual === expected;
  allPassed &&= pass;
  console.log(
    `${pass ? "PASS" : "FAIL"} slotsIntoRescue=${slots} expected=${expected} actual=${actual}`
  );
}

console.log(allPassed ? "\nALL PASSED" : "\nSOME FAILED");
process.exit(allPassed ? 0 : 1);
