module.exports = {
  apps: [
    {
      name: "keeper-1",
      script: "./dist/index.js",
      cwd: __dirname,
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
      cwd: __dirname,
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
