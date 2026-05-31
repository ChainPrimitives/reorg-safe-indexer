/**
 * Index USDC Transfer events on Ethereum mainnet with SQLite persistence.
 *
 * Run with: `RPC_URL=... npx tsx examples/usdc-transfers.ts`
 */
import { ReorgSafeIndexer, SqliteStorage } from "../src/index";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error("Set RPC_URL in your environment");
}

const storage = new SqliteStorage("./usdc.sqlite");

const indexer = new ReorgSafeIndexer({
  provider: RPC_URL,
  confirmations: 12,
  startBlock: 19_000_000,
  batchSize: 2000,
  pollInterval: 15_000,
  storage,
  logger: console,
  contracts: [
    {
      name: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      abi: [
        "event Transfer(address indexed from, address indexed to, uint256 value)",
      ],
      events: ["Transfer"],
    },
  ],
});

indexer.on("Transfer", async (event) => {
  console.log(
    `Transfer @${event.blockNumber}: ${event.args.from} -> ${event.args.to} : ${event.args.value}`,
  );
});

indexer
  .onLifecycle("reorg", ({ rollbackFrom, blocksRolledBack }) =>
    console.warn(
      `Reorg: rolled back ${blocksRolledBack} block(s) from ${rollbackFrom}`,
    ),
  )
  .onLifecycle("synced", ({ latestBlock }) =>
    console.log(`Synced up to block ${latestBlock}`),
  )
  .onLifecycle("error", (err) => console.error("Indexer error:", err));

// Graceful shutdown.
async function shutdown() {
  console.log("Shutting down...");
  await indexer.stop();
  await storage.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await indexer.start();
