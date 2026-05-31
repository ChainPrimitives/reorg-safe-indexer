# reorg-safe-indexer

[![npm version](https://img.shields.io/npm/v/reorg-safe-indexer.svg)](https://www.npmjs.com/package/reorg-safe-indexer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Build](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/ChainPrimitives/reorg-safe-indexer)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/ChainPrimitives/reorg-safe-indexer/pulls)

A lightweight, configurable blockchain event indexer with built-in chain
reorganization handling. It processes events idempotently, rolls back
automatically on reorgs, and supports pluggable storage backends.

**Why this package?** Most teams either reach for The Graph (heavy, hosted,
GraphQL-only) or hand-roll an indexer from scratch. There's little middleware
for the common case: "give me confirmed events, with reorg safety, into a
storage backend I control." This fills that gap.

- Confirmation-depth gating — only process blocks buried under N confirmations
- Automatic reorg detection and rollback via stored block hashes
- Idempotent persistence — safe to crash and restart
- Pluggable storage: in-memory, SQLite, PostgreSQL, or your own
- Retry with exponential backoff for flaky RPC endpoints
- Works as a long-running poller or a cron-driven `tick()`

## Install

```bash
npm install reorg-safe-indexer ethers
```

`ethers` v6 is a peer dependency. Storage backends pull in their drivers only
when used:

```bash
# only if you use SqliteStorage
npm install better-sqlite3
# only if you use PostgresStorage
npm install pg
```

## Quick start

```ts
import { ReorgSafeIndexer, MemoryStorage } from "reorg-safe-indexer";

const indexer = new ReorgSafeIndexer({
  provider: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
  confirmations: 12,
  startBlock: 19_000_000,
  batchSize: 2000,
  pollInterval: 15_000,
  storage: new MemoryStorage(),
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
  console.log(`${event.args.from} -> ${event.args.to}: ${event.args.value}`);
});

await indexer.start();
```

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                      ReorgSafeIndexer                       │
│                                                             │
│   poll/tick loop                                            │
│      │                                                      │
│      ▼                                                      │
│   ┌───────────────┐   reorg?   ┌──────────────┐            │
│   │ ReorgDetector │ ─────────▶ │   rollback   │            │
│   └───────────────┘            └──────────────┘            │
│      │ no reorg                                             │
│      ▼                                                      │
│   getLogs(safe range) ─▶ EventProcessor (decode + cache)   │
│      │                                                      │
│      ▼                                                      │
│   saveEvents() ─▶ BlockTracker.recordBlocks() ─▶ handlers  │
│                          │                                  │
│                          ▼                                  │
│                   StorageBackend                            │
│              (Memory / SQLite / PostgreSQL)                 │
└──────────────────────────────────────────────────────────┘
```

Each poll iteration:

1. **Detect reorgs.** Walk stored block hashes backwards (up to `reorgDepth`)
   and compare against the canonical chain. On mismatch, roll storage back to
   the fork point.
2. **Compute the safe head** as `currentBlock - confirmations`. Only blocks at
   or below the safe head are processed, so unconfirmed blocks never reach
   handlers.
3. **Fetch and decode logs** in `batchSize`-block windows. Block headers are
   cached per range, so many logs in one block cost a single `getBlock` call.
4. **Persist, then dispatch.** Events and block records are written to storage
   _before_ handlers run. Persistence is the source of truth, so a throwing
   handler never corrupts indexed state.

### Why persist before dispatching?

Handlers are for side effects (notifications, derived tables, webhooks). If a
handler throws, the indexed data is already durable and the block is marked
processed. You can replay handlers from storage with `storage.getEvents(...)`
rather than risk re-indexing or data loss. Handler errors are logged and
emitted on the `error` lifecycle event.

## Configuration

| Option          | Type                   | Default   | Description                                            |
| --------------- | ---------------------- | --------- | ------------------------------------------------------ |
| `provider`      | `string \| Provider`   | —         | RPC URL or an ethers `Provider`.                       |
| `contracts`     | `ContractConfig[]`     | —         | Contracts and events to index (at least one required). |
| `storage`       | `StorageBackend`       | —         | Where to persist blocks and events.                    |
| `confirmations` | `number`               | `12`      | Blocks of depth before a block is "safe".              |
| `startBlock`    | `number`               | `0`       | First block to index.                                  |
| `batchSize`     | `number`               | `1000`    | Max block span per `getLogs` call.                     |
| `pollInterval`  | `number`               | `15000`   | Delay between poll iterations (ms).                    |
| `reorgDepth`    | `number`               | `128`     | How far back to search for a fork point.               |
| `logger`        | `Logger`               | no-op     | Pass `console` or a pino/winston logger.               |
| `retry`         | `Partial<RetryConfig>` | see below | RPC retry/backoff policy.                              |

Retry defaults: `maxRetries: 5`, `baseDelayMs: 500`, `maxDelayMs: 30000`.

If a contract's `events` array is omitted or empty, **all** events in its ABI
are indexed.

## Storage backends

```ts
import {
  MemoryStorage,
  SqliteStorage,
  PostgresStorage,
} from "reorg-safe-indexer";

new MemoryStorage(); // tests / development (not durable)
new SqliteStorage("./data.sqlite"); // single-process, durable
new SqliteStorage(":memory:"); // ephemeral
new PostgresStorage(process.env.DATABASE_URL!); // production, concurrent reads
```

All backends implement the `StorageBackend` interface, so you can write your
own (Redis, MongoDB, ClickHouse, ...):

```ts
import type { StorageBackend } from "reorg-safe-indexer";

class MyStorage implements StorageBackend {
  async init() {
    /* create tables */
  }
  async saveBlock(block) {
    /* upsert */
  }
  async getBlock(n) {
    /* ... */
  }
  async getLatestBlock() {
    /* MAX(number) or 0 */
  }
  async saveEvents(events) {
    /* idempotent upsert on id */
  }
  async deleteEventsFromBlock(n) {
    /* ... */
  }
  async deleteBlocksFrom(n) {
    /* delete blocks + events >= n */
  }
  async getEvents(filter) {
    /* ... */
  }
  async close() {
    /* release resources */
  }
}
```

Contract for correctness:

- `getLatestBlock()` returns `0` when empty (reserved sentinel).
- `saveEvents()` must be idempotent on `event.id` (`txHash-logIndex`).
- `deleteBlocksFrom(n)` must remove both block records and their events.

BigInt event args (e.g. `uint256`) are preserved in memory and serialized to
decimal strings by the SQLite/Postgres backends.

## Querying indexed events

```ts
const transfers = await storage.getEvents({
  eventName: "Transfer",
  contractAddress: "0xA0b8...",
  fromBlock: 19_000_000,
  toBlock: 19_100_000,
  limit: 100,
  offset: 0,
});
```

## Lifecycle events

```ts
indexer
  .onLifecycle("batch", ({ fromBlock, toBlock, events }) => {})
  .onLifecycle("reorg", ({ rollbackFrom, blocksRolledBack }) => {})
  .onLifecycle("synced", ({ latestBlock }) => {})
  .onLifecycle("error", (err) => {});
```

## Cron / serverless usage

Instead of the built-in poll loop, drive a single catch-up pass yourself:

```ts
const safeHead = await indexer.tick(); // one reorg-check + catch-up pass
```

`tick()` does exactly what one poll iteration does and then returns. Use it
from a cron job, a queue worker, or a serverless function.

## Graceful shutdown

```ts
process.on("SIGINT", async () => {
  await indexer.stop(); // waits for the current iteration to finish
  await storage.close(); // you own the storage lifecycle
  process.exit(0);
});
```

`stop()` aborts in-flight RPC retries and resolves once the current iteration
settles. It does not close storage — call `storage.close()` yourself.

## Operational notes

- **Confirmations vs. reorgDepth.** `confirmations` controls how deep a block
  must be before processing; `reorgDepth` controls how far back the detector
  will search. Keep `reorgDepth >= confirmations`. Reorgs deeper than
  `reorgDepth` are rolled back to the depth limit and logged as a warning.
- **RPC rate limits.** Tune `batchSize` and `pollInterval` to your provider's
  limits. The retry layer backs off on `429`/timeout/5xx responses.
- **Crash safety.** On restart the indexer resumes from
  `getLatestBlock() + 1`, re-running the reorg check first.

## Development

```bash
npm install
npm run build        # bundle (esm + cjs) and types via tsup
npm test             # vitest
npm run test:coverage
npm run lint
npm run typecheck
```

## License

MIT
