import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
type AnchorProvider = InstanceType<typeof anchorPkg.AnchorProvider>;

import { Connection, PublicKey } from "@solana/web3.js";
import { InertiaClient, EscrowStateAccount } from "@inertia-protocol/sdk";

import { KeeperConfig } from "./config.js";
import { checkProfitability } from "./profitability.js";
import { MockDexSwapBuilder } from "./mockDexSwap.js";

export interface RescueAttemptResult {
  escrow: PublicKey;
  outcome: "rescued" | "skipped-not-eligible" | "skipped-unprofitable" | "skipped-unknown-swap-program" | "lost-race" | "error";
  profitLamports?: bigint;
  signature?: string;
  error?: unknown;
}

export class KeeperBot {
  public readonly client: InertiaClient;
  public readonly provider: AnchorProvider;
  private readonly swapBuilder: MockDexSwapBuilder;

  constructor(private readonly config: KeeperConfig) {
    const connection = new Connection(config.rpcUrl, "confirmed");
    this.provider = new AnchorProvider(connection, new Wallet(config.keypair), {});
    this.client = new InertiaClient(this.provider);
    this.swapBuilder = new MockDexSwapBuilder(this.provider);
  }

  /**
   * One full scan-and-attempt pass over every pending escrow. Returns a
   * result per escrow rather than throwing, so a single failed or
   * already-claimed escrow (a lost race against another keeper -- an
   * expected, benign outcome in a permissionless system, not a bug) doesn't
   * stop the rest of the pass.
   */
  async runOnce(): Promise<RescueAttemptResult[]> {
    const pending = await this.client.getPendingEscrows();
    const currentSlot = await this.client.getCurrentSlot();
    const results: RescueAttemptResult[] = [];

    for (const { pubkey, account } of pending) {
      results.push(await this.tryRescue(pubkey, account, currentSlot));
    }

    return results;
  }

  private async tryRescue(
    escrow: PublicKey,
    account: EscrowStateAccount,
    currentSlot: bigint
  ): Promise<RescueAttemptResult> {
    if (!account.expectedProgramId.equals(this.swapBuilder.programId)) {
      return { escrow, outcome: "skipped-unknown-swap-program" };
    }

    const profitability = checkProfitability({
      gasBufferLamports: account.gasBufferLamports,
      creationSlot: account.creationSlot,
      currentSlot,
      estimatedTxFeeLamports: this.config.estimatedTxFeeLamports,
      minProfitLamports: this.config.minProfitLamports,
    });

    if (!profitability.isRescueEligible) {
      return { escrow, outcome: "skipped-not-eligible" };
    }
    if (!profitability.isProfitable) {
      return {
        escrow,
        outcome: "skipped-unprofitable",
        profitLamports: profitability.estimatedProfitLamports,
      };
    }

    try {
      const { swapInstructionData, remainingAccounts } = await this.swapBuilder.buildSwap({
        userInputTokenAccount: account.userInputTokenAccount,
        destinationTokenAccount: account.expectedDestinationTokenAccount,
        inputAmount: account.inputAmount,
        outputAmount: account.expectedOutputAmount,
      });

      const signature = await this.client.executeSwap(
        {
          caller: this.config.keypair.publicKey,
          escrow,
          swapInstructionData,
          remainingAccounts,
          swapProgram: this.swapBuilder.programId,
        },
        [this.config.keypair]
      );

      return {
        escrow,
        outcome: "rescued",
        profitLamports: profitability.estimatedProfitLamports,
        signature,
      };
    } catch (error) {
      // Most commonly this means another keeper already claimed it between
      // our scan and our attempt -- the escrow no longer exists by the time
      // our transaction lands. That's the system working as designed in a
      // permissionless race, not a bot malfunction, so it's reported as its
      // own outcome rather than surfaced identically to a real error.
      const stillExists = await this.client.getEscrow(escrow);
      if (stillExists === null) {
        return { escrow, outcome: "lost-race" };
      }
      return { escrow, outcome: "error", error };
    }
  }
}
