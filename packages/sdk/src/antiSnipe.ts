import {
  BASIS_POINTS_DIVISOR,
  KEEPER_SHARE_BPS,
  MIN_JITO_TIP_LAMPORTS,
  TIP_DECAY_SLOTS,
  TTL_SLOTS,
} from "./constants.js";

/**
 * Direct TypeScript mirror of split_share() in util.rs. Uses BigInt
 * throughout to match Rust's u64/u128 semantics exactly -- lamport amounts
 * are within safe integer range in practice, but mixing BigInt and Number
 * here would risk silent precision bugs the moment that stops being true.
 */
export function splitShare(total: bigint, shareBps: bigint): bigint {
  return (total * shareBps) / BASIS_POINTS_DIVISOR;
}

/**
 * Direct mirror of anti_snipe_required_tip() in execute_swap.rs. Given the
 * keeper's estimated reward and how many slots into the rescue window we
 * are, returns the minimum tip (in lamports) required to pass the on-chain
 * check right now. slotsIntoRescue must be computed the same way the
 * contract does: elapsed - ttl_slots, saturating at 0.
 */
export function antiSnipeRequiredTip(
  keeperShare: bigint,
  slotsIntoRescue: bigint
): bigint {
  const decayProgress =
    slotsIntoRescue > 0n ? slotsIntoRescue - 1n : 0n;

  if (keeperShare <= MIN_JITO_TIP_LAMPORTS || decayProgress >= TIP_DECAY_SLOTS) {
    return MIN_JITO_TIP_LAMPORTS;
  }

  const remainingSlots = TIP_DECAY_SLOTS - decayProgress;
  const extraAboveFloor = keeperShare - MIN_JITO_TIP_LAMPORTS;
  return (
    MIN_JITO_TIP_LAMPORTS + (extraAboveFloor * remainingSlots) / TIP_DECAY_SLOTS
  );
}

/**
 * The full, practical version a keeper bot actually wants: given the
 * escrow's gas buffer, its creation slot, and the current slot, returns
 * whether a rescue is even eligible yet and, if so, exactly what tip to
 * attach right now to pass the on-chain check.
 */
export function computeRescueTip(params: {
  gasBufferLamports: bigint;
  creationSlot: bigint;
  currentSlot: bigint;
}): { isRescueEligible: boolean; requiredTipLamports: bigint } {
  const elapsed = params.currentSlot - params.creationSlot;
  const isRescueEligible = elapsed > TTL_SLOTS;

  if (!isRescueEligible) {
    return { isRescueEligible: false, requiredTipLamports: 0n };
  }

  const slotsIntoRescue = elapsed - TTL_SLOTS;
  const keeperShare = splitShare(params.gasBufferLamports, KEEPER_SHARE_BPS);
  const requiredTipLamports = antiSnipeRequiredTip(keeperShare, slotsIntoRescue);

  return { isRescueEligible, requiredTipLamports };
}
