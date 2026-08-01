import { checkProfitability } from "../dist/profitability.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const buffer = 200_000_000n;
const creationSlot = 1000n;

// Not yet rescue-eligible (still inside TTL_SLOTS).
{
  const result = checkProfitability({
    gasBufferLamports: buffer,
    creationSlot,
    currentSlot: creationSlot + 1n,
    estimatedTxFeeLamports: 10_000n,
    minProfitLamports: 1_000n,
  });
  check(
    "not rescue-eligible before TTL",
    result.isRescueEligible === false && result.isProfitable === false
  );
}

// Rescue-eligible but right at the anti-snipe wall (tip ~= reward) -- should not be profitable.
{
  const result = checkProfitability({
    gasBufferLamports: buffer,
    creationSlot,
    currentSlot: creationSlot + 3n, // first eligible slot
    estimatedTxFeeLamports: 10_000n,
    minProfitLamports: 1_000n,
  });
  check(
    "unprofitable at the very first eligible slot (anti-snipe wall)",
    result.isRescueEligible === true && result.isProfitable === false
  );
}

// Fully decayed -- should be clearly profitable.
{
  const result = checkProfitability({
    gasBufferLamports: buffer,
    creationSlot,
    currentSlot: creationSlot + 2n + 15n + 1n + 5n, // well past TTL + TIP_DECAY_SLOTS
    estimatedTxFeeLamports: 10_000n,
    minProfitLamports: 1_000n,
  });
  const expectedReward = (buffer * 9_000n) / 10_000n; // KEEPER_SHARE_BPS
  const expectedProfit = expectedReward - 10_000n - 10_000n; // reward - floor tip - fee
  check(
    "profitable once fully decayed",
    result.isRescueEligible === true &&
      result.isProfitable === true &&
      result.estimatedProfitLamports === expectedProfit
  );
}

// A tiny buffer should never clear minProfitLamports even fully decayed.
{
  const tinyBuffer = 15_000n;
  const result = checkProfitability({
    gasBufferLamports: tinyBuffer,
    creationSlot,
    currentSlot: creationSlot + 2n + 15n + 1n + 5n,
    estimatedTxFeeLamports: 10_000n,
    minProfitLamports: 1_000n,
  });
  check(
    "tiny buffer stays unprofitable even fully decayed",
    result.isRescueEligible === true && result.isProfitable === false
  );
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
