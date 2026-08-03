// One-off cleanup for stale Pending escrows left over from earlier one-off
// demo runs, whose account setups don't match the current continuous Orca
// keeper's fixed pool and so fail execute_swap on every single poll cycle
// forever. Closed via the permissionless cleanup_expired_escrow (all are
// long past the 300-slot expiry window) rather than left to keep wasting
// keeper poll cycles and RPC calls.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { InertiaClient } from "@inertia-protocol/sdk";

const STALE_ESCROWS = [
  "ZuJvpWhxccQdp4i9rnNMmvzbstqXxfvxTfEtWUr61rb",
  "6Foe5Rbw5iFX4HUp3yxCpTgkGNQHQ5cU14539ihFtVwo",
  "FkwBCqgwBWeddpcbni95pUwHXieWRfftc1u6zwHvWQ2S",
  "J7DBoCaXskh8ymPjXJHd5uiDVpRsfRRBg5n2o64vbSou",
];

async function main() {
  const keypairPath = process.env.DEVNET_PAYER;
  if (!keypairPath) throw new Error("Set DEVNET_PAYER to a keypair JSON path");
  const caller = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(caller), {});
  const inertia = new InertiaClient(provider);

  for (const addr of STALE_ESCROWS) {
    const escrow = new PublicKey(addr);
    const state = await inertia.getEscrow(escrow);
    if (state === null) {
      console.log(`${addr}: already gone, skipping`);
      continue;
    }
    try {
      const sig = await inertia.cleanupExpiredEscrow({
        caller: caller.publicKey,
        escrow,
        userWallet: state.userWallet,
      });
      console.log(`${addr}: cleaned up, tx ${sig}`);
    } catch (err) {
      console.error(`${addr}: cleanup failed -- ${err?.message ?? err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
