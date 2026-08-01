# Developing Inertia Protocol

This covers what's actually needed to build, test, and fuzz this project —
written from the real gotchas hit getting it working, not a generic template.
If you're on Windows, read the WSL note first; several of the steps below
assume it.

## Prerequisites

- **Rust** (stable) + the Solana BPF/SBF target, installed via the Solana CLI installer.
- **Solana CLI**.
- **Anchor CLI** — this project uses **1.1.2 from the otter-sec/anchor fork**,
  not the mainline `0.31.x` releases. The API differs in places (e.g.
  `CpiContext::new()` takes a `Pubkey`, not an `AccountInfo`). `avm install`
  will get you the right version if pointed at that fork.
- **[surfpool](https://docs.surfpool.run/)** — used instead of
  `solana-test-validator`. Run it with `--offline` for isolated local testing;
  without that flag it clones mainnet accounts by default.
- **[Trident](https://github.com/Ackee-Blockchain/trident)** CLI, for the fuzz
  campaign in `trident-tests/`.
- **Node.js** + npm, for the TS test suite and the SDK package.

### Windows: use WSL2

Building the Solana BPF target needs an MSVC linker that isn't present by
default on Windows. Rather than install Visual Studio Build Tools, this
project is developed inside **WSL2**. All commands below assume a WSL2 shell
unless stated otherwise. `libssl-dev` and `pkg-config` are also required
inside WSL for some of the Rust tooling to build (`sudo apt-get install -y
libssl-dev pkg-config`).

## Building the programs

```bash
anchor build
```

This builds both `inertia_protocol` and `mock_dex` (a test-only swap program
used by the integration tests), and generates the IDL + TypeScript types into
the gitignored `target/` directory.

## Running the test suite — the surfpool gotcha

**`anchor test` alone will fail** with "Unsupported program id" or "Program is
not deployed." This is a known race condition between Anchor's automatic
deploy step and surfpool starting up (see
[solana-foundation/anchor#4100](https://github.com/solana-foundation/anchor/issues/4100)).
The workaround is to deploy manually first, then skip Anchor's own deploy
step:

```bash
# 1. Start surfpool detached, so it survives the shell session ending.
#    (Plain `surfpool start &` gets killed when a one-shot command session
#    exits — use setsid + disown to actually detach it.)
setsid nohup surfpool start --offline > /tmp/surfpool.log 2>&1 < /dev/null &
disown

# 2. Wait a few seconds, then confirm it's actually up:
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
  http://127.0.0.1:8899
# expect: {"jsonrpc":"2.0","result":"ok","id":1}

# 3. Build, then deploy both programs manually:
anchor build
solana program deploy target/deploy/inertia_protocol.so \
  --program-id target/deploy/inertia_protocol-keypair.json \
  --url http://127.0.0.1:8899
solana program deploy target/deploy/mock_dex.so \
  --program-id target/deploy/mock_dex-keypair.json \
  --url http://127.0.0.1:8899

# 4. Run the tests, skipping Anchor's own (broken) deploy/validator steps:
anchor test --skip-local-validator --skip-deploy --skip-build

# 5. When done, stop the validator:
pkill -9 -f 'surfpool start'
```

This is the standard pattern used throughout this project's history — reuse
it verbatim for any manual testing against a local validator, including the
SDK's integration test (below).

## Fuzz testing

```bash
cd trident-tests
FUZZING_METRICS=true ./target/release/fuzz_0
```

Two gotchas here:
- **`FUZZING_METRICS=true` is required to see the results table.** The
  `trident fuzz run` CLI sets this automatically; running the built binary
  directly does not, and the campaign will run silently to completion with no
  visible output otherwise.
- Trident's timing helpers can be misleading: `forward_in_time()` only
  advances the clock's `unix_timestamp`, **not** the slot counter. Since this
  contract's TTL logic is entirely slot-based, use `warp_to_slot()` instead
  when a fuzz flow needs to simulate time passing.

## The SDK package

```bash
cd packages/sdk
npm install
npm run build
npm test                 # pure math check, no external dependencies
npm run test:integration # real end-to-end check -- needs surfpool running
                          # with both programs deployed, per the steps above
```

The SDK's IDL (`packages/sdk/src/idl/inertia_protocol.json`) is a checked-in
copy of the Anchor-generated one, since `target/` is gitignored. If you
change an instruction's accounts or args in the Rust program, rebuild
(`anchor build` from the repo root) and copy the fresh IDL over:

```bash
cp target/idl/inertia_protocol.json packages/sdk/src/idl/inertia_protocol.json
```
