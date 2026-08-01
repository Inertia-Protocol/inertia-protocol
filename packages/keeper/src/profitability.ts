import { computeRescueTip, splitShare } from "@inertia-protocol/sdk";

// Mirrors KEEPER_SHARE_BPS in constants.rs -- duplicated here rather than
// re-exported from the SDK's internal constants module to keep this
// package's dependency surface to the SDK's public API only.
const KEEPER_SHARE_BPS = 9_000n;

export interface ProfitabilityResult {
  isRescueEligible: boolean;
  isProfitable: boolean;
  requiredTipLamports: bigint;
  estimatedRewardLamports: bigint;
  estimatedProfitLamports: bigint;
}

/**
 * Decides whether attempting a rescue right now is actually worth it, not
 * just whether it's technically allowed. isRescueEligible=true alone isn't
 * enough -- the anti-snipe curve can mean the required tip is still close
 * to (or above) the reward early in the decay window, in which case a
 * rational keeper should wait rather than act at a loss.
 */
export function checkProfitability(params: {
  gasBufferLamports: bigint;
  creationSlot: bigint;
  currentSlot: bigint;
  estimatedTxFeeLamports: bigint;
  minProfitLamports: bigint;
}): ProfitabilityResult {
  const { isRescueEligible, requiredTipLamports } = computeRescueTip({
    gasBufferLamports: params.gasBufferLamports,
    creationSlot: params.creationSlot,
    currentSlot: params.currentSlot,
  });

  if (!isRescueEligible) {
    return {
      isRescueEligible: false,
      isProfitable: false,
      requiredTipLamports: 0n,
      estimatedRewardLamports: 0n,
      estimatedProfitLamports: 0n,
    };
  }

  const estimatedRewardLamports = splitShare(
    params.gasBufferLamports,
    KEEPER_SHARE_BPS
  );
  const estimatedProfitLamports =
    estimatedRewardLamports - requiredTipLamports - params.estimatedTxFeeLamports;

  return {
    isRescueEligible: true,
    isProfitable: estimatedProfitLamports >= params.minProfitLamports,
    requiredTipLamports,
    estimatedRewardLamports,
    estimatedProfitLamports,
  };
}
