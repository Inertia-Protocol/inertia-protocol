import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
type AnchorProvider = InstanceType<typeof anchorPkg.AnchorProvider>;

import { AccountMeta, Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { InertiaClient, EscrowStateAccount, OrcaSwapBuilder } from "@inertia-protocol/sdk";

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
  private readonly connection: Connection;
  private readonly mockDexBuilder: MockDexSwapBuilder;
  private readonly orcaBuilder: OrcaSwapBuilder;

  constructor(private readonly config: KeeperConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.provider = new AnchorProvider(this.connection, new Wallet(config.keypair), {});
    this.client = new InertiaClient(this.provider);
    this.mockDexBuilder = new MockDexSwapBuilder(this.provider);
    this.orcaBuilder = new OrcaSwapBuilder(this.provider);
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
    const isMockDex = account.expectedProgramId.equals(this.mockDexBuilder.programId);
    const isOrca =
      this.config.orcaWhirlpoolAddress !== undefined &&
      account.expectedProgramId.equals(this.orcaBuilder.programId);
    if (!isMockDex && !isOrca) {
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
      let swapInstructionData: Buffer;
      let remainingAccounts: AccountMeta[];
      let swapProgram: PublicKey;

      if (isOrca) {
        // The escrow stores the token accounts involved but not their
        // mints -- looked up for real here, the same way MockDexSwapBuilder
        // already does for its own accounts, not assumed or cached.
        const inputAccountInfo = await getAccount(this.connection, account.userInputTokenAccount);
        const built = await this.orcaBuilder.buildSwap({
          whirlpoolAddress: this.config.orcaWhirlpoolAddress!,
          userInputTokenAccount: account.userInputTokenAccount,
          destinationTokenAccount: account.expectedDestinationTokenAccount,
          inputMint: inputAccountInfo.mint,
          inputAmount: account.inputAmount,
          escrowAuthority: escrow,
        });
        swapInstructionData = built.swapInstructionData;
        remainingAccounts = built.remainingAccounts;
        swapProgram = this.orcaBuilder.programId;
      } else {
        const built = await this.mockDexBuilder.buildSwap({
          userInputTokenAccount: account.userInputTokenAccount,
          destinationTokenAccount: account.expectedDestinationTokenAccount,
          inputAmount: account.inputAmount,
          outputAmount: account.expectedOutputAmount,
        });
        swapInstructionData = built.swapInstructionData;
        remainingAccounts = built.remainingAccounts;
        swapProgram = this.mockDexBuilder.programId;
      }

      const signature = await this.client.executeSwap(
        {
          caller: this.config.keypair.publicKey,
          escrow,
          swapInstructionData,
          remainingAccounts,
          swapProgram,
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
