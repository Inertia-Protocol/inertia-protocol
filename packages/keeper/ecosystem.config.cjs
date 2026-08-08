// Runs from a native WSL filesystem copy, not this repo's own /mnt/c
// location. Module resolution over WSL's DrvFs bridge (reading node_modules
// off the Windows-mounted drive) took 3-4+ seconds just for the two heaviest
// deps in testing -- long enough that the keeper never reached its own
// first log line within a normal poll interval, made every RPC call look
// slow, and left log files empty for hours even while the keeper was
// eventually completing real rescues. Same code, same behavior, just
// running off ext4 instead of 9p/DrvFs. After any keeper or SDK change,
// re-sync to NATIVE_DIR before restarting pm2, or the fix silently reverts.
const NATIVE_DIR = "/home/oddev/inertia-native/packages/keeper";

module.exports = {
  apps: [
    {
      name: "keeper-1",
      script: "./dist/index.js",
      cwd: NATIVE_DIR,
      env: {
        INERTIA_KEEPER_RPC_URL: "https://api.devnet.solana.com",
        INERTIA_KEEPER_KEYPAIR: "/home/oddev/.config/solana/keeper-id.json",
        INERTIA_KEEPER_ORCA_WHIRLPOOL: "122n8Kvj9htD1AkY8JWJBMngzA8rWkWDPa26vPpuiU7z",
        INERTIA_KEEPER_POLL_INTERVAL_MS: "10000",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: "keeper-2",
      script: "./dist/index.js",
      cwd: NATIVE_DIR,
      env: {
        INERTIA_KEEPER_RPC_URL: "https://api.devnet.solana.com",
        INERTIA_KEEPER_KEYPAIR: "/home/oddev/.config/solana/keeper2-id.json",
        INERTIA_KEEPER_ORCA_WHIRLPOOL: "122n8Kvj9htD1AkY8JWJBMngzA8rWkWDPa26vPpuiU7z",
        INERTIA_KEEPER_POLL_INTERVAL_MS: "10000",
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
