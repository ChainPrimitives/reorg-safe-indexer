# reorg-safe-indexer — Production Guide

## Overview

A lightweight, configurable blockchain event indexer with built-in chain reorganization handling. Processes events idempotently, rolls back on reorgs, and supports pluggable storage backends.

**Why this package?** Everyone either uses The Graph (heavy, hosted, GraphQL-only) or builds indexers from scratch. There's no lightweight middleware for "give me confirmed events with reorg safety." This fills that gap.

---

## Package Metadata

```
Name: reorg-safe-indexer
License: MIT
Node: >=18
Peer Dependencies: ethers ^6.0.0
Optional Dependencies: pg (PostgreSQL), better-sqlite3 (SQLite)
```

---

## Directory Structure

```
reorg-safe-indexer/
├── src/
│   ├── index.ts              # Public API
│   ├── indexer.ts            # Core indexer engine
│   ├── reorg-detector.ts     # Block hash comparison & reorg detection
│   ├── block-tracker.ts      # Track processed blocks with hashes
│   ├── event-processor.ts    # Event decoding & dispatch
│   ├── storage/
│   │   ├── interface.ts      # Storage backend interface
│   │   ├── memory.ts         # In-memory backend (for testing)
│   │   ├── sqlite.ts         # SQLite backend
│   │   └── postgres.ts       # PostgreSQL backend
│   ├── types.ts
│   └── utils.ts
├── tests/
│   ├── indexer.test.ts
│   ├── reorg-detector.test.ts
│   ├── storage/
│   │   ├── memory.test.ts
│   │   └── sqlite.test.ts
│   └── integration/
│       └── hardhat-reorg.test.ts
├── tsconfig.json
├── tsup.config.ts
├── package.json
└── README.md
```

---

## Core Architecture

```
┌─────────────────────────────────────────────────┐
│                  ReorgSafeIndexer                │
│                                                   │
│  ┌──────────┐  ┌───────────────┐  ┌───────────┐ │
│  │  Block    │→│  Reorg        │→│  Event     │ │
│  │  Tracker  │  │  Detector     │  │  Processor │ │
│  └──────────┘  └───────────────┘  └───────────┘ │
│        │              │                  │        │
│        └──────────────┴──────────────────┘        │
│                       │                           │
│              ┌────────┴────────┐                  │
│              │ Storage Backend │                  │
│              │ (Memory/SQLite/ │                  │
│              │  PostgreSQL)    │                  │
│              └─────────────────┘                  │
└─────────────────────────────────────────────────┘
```

---

## Implementation

### src/types.ts

```ts
export interface IndexerConfig {
  /** RPC URL or ethers Provider */
  provider: string | any;
  /** Number of confirmations before processing (default: 12) */
  confirmations: number;
  /** Starting block number */
  startBlock: number;
  /** Batch size for getLogs calls (default: 1000) */
  batchSize: number;
  /** Polling interval in ms (default: 15000) */
  pollInterval: number;
  /** Contract addresses and events to index */
  contracts: ContractConfig[];
  /** Storage backend */
  storage: StorageBackend;
}

export interface ContractConfig {
  name: string;
  address: string;
  abi: string[];
  events: string[]; // Event names to listen for
}

export interface IndexedEvent {
  id: string; // `${txHash}-${logIndex}`
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  args: Record<string, any>;
  timestamp: number;
  removed: boolean; // true if reorged out
}

export interface BlockRecord {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  eventCount: number;
}

export interface StorageBackend {
  /** Save a processed block record */
  saveBlock(block: BlockRecord): Promise<void>;
  /** Get block record by number */
  getBlock(blockNumber: number): Promise<BlockRecord | null>;
  /** Get the latest processed block number */
  getLatestBlock(): Promise<number>;
  /** Save indexed events */
  saveEvents(events: IndexedEvent[]): Promise<void>;
  /** Delete events from reorged blocks */
  deleteEventsFromBlock(blockNumber: number): Promise<void>;
  /** Delete block records from a given block number onward */
  deleteBlocksFrom(blockNumber: number): Promise<void>;
  /** Initialize storage (create tables, etc.) */
  init(): Promise<void>;
}

export type EventHandler = (event: IndexedEvent) => Promise<void>;
```

### src/reorg-detector.ts

```ts
import { Provider } from "ethers";
import { BlockRecord, StorageBackend } from "./types";

/**
 * Detect chain reorganizations by comparing stored block hashes
 * with current chain state.
 */
export class ReorgDetector {
  constructor(
    private provider: Provider,
    private storage: StorageBackend,
  ) {}

  /**
   * Find the fork point — the last block where our stored hash
   * matches the current chain.
   *
   * Returns the block number to roll back to (inclusive).
   * Returns null if no reorg detected.
   */
  async detectReorg(currentBlockNumber: number): Promise<number | null> {
    const latestStored = await this.storage.getLatestBlock();
    if (latestStored === 0) return null;

    // Walk backwards from latest stored block
    for (let i = latestStored; i >= Math.max(0, latestStored - 128); i--) {
      const storedBlock = await this.storage.getBlock(i);
      if (!storedBlock) continue;

      const chainBlock = await this.provider.getBlock(i);
      if (!chainBlock) continue;

      if (storedBlock.hash !== chainBlock.hash) {
        // Reorg detected — continue walking back to find fork point
        continue;
      }

      // Found matching block — this is the fork point
      if (i < latestStored) {
        return i + 1; // Roll back from i+1 onward
      }
      return null; // No reorg
    }

    // Deep reorg (>128 blocks) — shouldn't happen, but handle it
    return Math.max(0, latestStored - 128);
  }

  /**
   * Roll back storage to a given block number.
   * Deletes all blocks and events from rollbackFrom onward.
   */
  async rollback(rollbackFrom: number): Promise<number> {
    const latestStored = await this.storage.getLatestBlock();
    let rolledBack = 0;

    for (let i = rollbackFrom; i <= latestStored; i++) {
      await this.storage.deleteEventsFromBlock(i);
      rolledBack++;
    }

    await this.storage.deleteBlocksFrom(rollbackFrom);
    return rolledBack;
  }
}
```

### src/indexer.ts

```ts
import { JsonRpcProvider, Provider, Contract, Interface, Log } from "ethers";
import {
  IndexerConfig,
  IndexedEvent,
  BlockRecord,
  EventHandler,
  ContractConfig,
} from "./types";
import { ReorgDetector } from "./reorg-detector";

export class ReorgSafeIndexer {
  private provider: Provider;
  private reorgDetector: ReorgDetector;
  private handlers: Map<string, EventHandler[]> = new Map();
  private running = false;
  private interfaces: Map<string, Interface> = new Map();

  constructor(private config: IndexerConfig) {
    this.provider =
      typeof config.provider === "string"
        ? new JsonRpcProvider(config.provider)
        : config.provider;
    this.reorgDetector = new ReorgDetector(this.provider, config.storage);

    // Pre-build interfaces for each contract
    for (const contract of config.contracts) {
      this.interfaces.set(
        contract.address.toLowerCase(),
        new Interface(contract.abi),
      );
    }
  }

  /** Register an event handler */
  on(eventName: string, handler: EventHandler): this {
    const existing = this.handlers.get(eventName) || [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
    return this;
  }

  /** Initialize storage and start indexing */
  async start(): Promise<void> {
    await this.config.storage.init();
    this.running = true;
    await this.poll();
  }

  /** Stop the indexer */
  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        // 1. Check for reorgs
        const currentBlock = await this.provider.getBlockNumber();
        const rollbackFrom = await this.reorgDetector.detectReorg(currentBlock);
        if (rollbackFrom !== null) {
          console.log(`[reorg] Rolling back from block ${rollbackFrom}`);
          await this.reorgDetector.rollback(rollbackFrom);
        }

        // 2. Get safe block (current - confirmations)
        const safeBlock = currentBlock - this.config.confirmations;
        const lastProcessed = await this.config.storage.getLatestBlock();
        const fromBlock = Math.max(lastProcessed + 1, this.config.startBlock);

        if (fromBlock > safeBlock) {
          await this.sleep(this.config.pollInterval);
          continue;
        }

        // 3. Process blocks in batches
        for (
          let start = fromBlock;
          start <= safeBlock;
          start += this.config.batchSize
        ) {
          const end = Math.min(start + this.config.batchSize - 1, safeBlock);
          await this.processBlockRange(start, end);
        }
      } catch (error) {
        console.error("[indexer] Error:", error);
      }

      await this.sleep(this.config.pollInterval);
    }
  }

  private async processBlockRange(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    for (const contract of this.config.contracts) {
      const iface = this.interfaces.get(contract.address.toLowerCase())!;

      // Build topic filters for requested events
      const topics = contract.events
        .map((name) => {
          const event = iface.getEvent(name);
          return event ? iface.getEvent(name)!.topicHash : null;
        })
        .filter(Boolean);

      const logs = await this.provider.getLogs({
        address: contract.address,
        fromBlock,
        toBlock,
        topics: [topics],
      });

      const events: IndexedEvent[] = [];
      for (const log of logs) {
        try {
          const parsed = iface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (!parsed) continue;

          const block = await this.provider.getBlock(log.blockNumber);

          const event: IndexedEvent = {
            id: `${log.transactionHash}-${log.index}`,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: log.index,
            contractAddress: log.address,
            eventName: parsed.name,
            args: Object.fromEntries(
              parsed.fragment.inputs.map((input, i) => [
                input.name,
                parsed.args[i],
              ]),
            ),
            timestamp: block?.timestamp || 0,
            removed: log.removed || false,
          };

          events.push(event);

          // Dispatch to handlers
          const handlers = this.handlers.get(parsed.name) || [];
          for (const handler of handlers) {
            await handler(event);
          }
        } catch (e) {
          // Skip unparseable logs
        }
      }

      if (events.length > 0) {
        await this.config.storage.saveEvents(events);
      }
    }

    // Record processed blocks
    for (let i = fromBlock; i <= toBlock; i++) {
      const block = await this.provider.getBlock(i);
      if (block) {
        await this.config.storage.saveBlock({
          number: block.number,
          hash: block.hash!,
          parentHash: block.parentHash,
          timestamp: block.timestamp,
          eventCount: 0,
        });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### src/storage/memory.ts

```ts
import { StorageBackend, BlockRecord, IndexedEvent } from "../types";

/** In-memory storage backend — useful for testing and development */
export class MemoryStorage implements StorageBackend {
  private blocks: Map<number, BlockRecord> = new Map();
  private events: Map<number, IndexedEvent[]> = new Map();

  async init(): Promise<void> {}

  async saveBlock(block: BlockRecord): Promise<void> {
    this.blocks.set(block.number, block);
  }

  async getBlock(blockNumber: number): Promise<BlockRecord | null> {
    return this.blocks.get(blockNumber) || null;
  }

  async getLatestBlock(): Promise<number> {
    if (this.blocks.size === 0) return 0;
    return Math.max(...this.blocks.keys());
  }

  async saveEvents(events: IndexedEvent[]): Promise<void> {
    for (const event of events) {
      const existing = this.events.get(event.blockNumber) || [];
      existing.push(event);
      this.events.set(event.blockNumber, existing);
    }
  }

  async deleteEventsFromBlock(blockNumber: number): Promise<void> {
    this.events.delete(blockNumber);
  }

  async deleteBlocksFrom(blockNumber: number): Promise<void> {
    for (const key of this.blocks.keys()) {
      if (key >= blockNumber) this.blocks.delete(key);
    }
  }
}
```

### src/storage/postgres.ts

```ts
import { StorageBackend, BlockRecord, IndexedEvent } from "../types";

/**
 * PostgreSQL storage backend.
 * Requires `pg` as a peer dependency.
 */
export class PostgresStorage implements StorageBackend {
  private pool: any;

  constructor(connectionString: string) {
    // Dynamic import to keep pg optional
    const { Pool } = require("pg");
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS indexed_blocks (
        number INTEGER PRIMARY KEY,
        hash VARCHAR(66) NOT NULL,
        parent_hash VARCHAR(66) NOT NULL,
        timestamp INTEGER NOT NULL,
        event_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS indexed_events (
        id VARCHAR(132) PRIMARY KEY,
        block_number INTEGER NOT NULL REFERENCES indexed_blocks(number),
        block_hash VARCHAR(66) NOT NULL,
        transaction_hash VARCHAR(66) NOT NULL,
        log_index INTEGER NOT NULL,
        contract_address VARCHAR(42) NOT NULL,
        event_name VARCHAR(256) NOT NULL,
        args JSONB NOT NULL,
        timestamp INTEGER NOT NULL,
        removed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_events_block ON indexed_events(block_number);
      CREATE INDEX IF NOT EXISTS idx_events_contract ON indexed_events(contract_address);
      CREATE INDEX IF NOT EXISTS idx_events_name ON indexed_events(event_name);
    `);
  }

  async saveBlock(block: BlockRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexed_blocks (number, hash, parent_hash, timestamp, event_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (number) DO UPDATE SET hash = $2, parent_hash = $3`,
      [
        block.number,
        block.hash,
        block.parentHash,
        block.timestamp,
        block.eventCount,
      ],
    );
  }

  async getBlock(blockNumber: number): Promise<BlockRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM indexed_blocks WHERE number = $1",
      [blockNumber],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      number: row.number,
      hash: row.hash,
      parentHash: row.parent_hash,
      timestamp: row.timestamp,
      eventCount: row.event_count,
    };
  }

  async getLatestBlock(): Promise<number> {
    const result = await this.pool.query(
      "SELECT MAX(number) as num FROM indexed_blocks",
    );
    return result.rows[0]?.num || 0;
  }

  async saveEvents(events: IndexedEvent[]): Promise<void> {
    for (const event of events) {
      await this.pool.query(
        `INSERT INTO indexed_events (id, block_number, block_hash, transaction_hash, log_index, contract_address, event_name, args, timestamp, removed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.blockNumber,
          event.blockHash,
          event.transactionHash,
          event.logIndex,
          event.contractAddress,
          event.eventName,
          JSON.stringify(event.args),
          event.timestamp,
          event.removed,
        ],
      );
    }
  }

  async deleteEventsFromBlock(blockNumber: number): Promise<void> {
    await this.pool.query(
      "DELETE FROM indexed_events WHERE block_number = $1",
      [blockNumber],
    );
  }

  async deleteBlocksFrom(blockNumber: number): Promise<void> {
    await this.pool.query(
      "DELETE FROM indexed_events WHERE block_number >= $1",
      [blockNumber],
    );
    await this.pool.query("DELETE FROM indexed_blocks WHERE number >= $1", [
      blockNumber,
    ]);
  }
}
```

### src/index.ts

```ts
export { ReorgSafeIndexer } from "./indexer";
export { ReorgDetector } from "./reorg-detector";
export { MemoryStorage } from "./storage/memory";
export { PostgresStorage } from "./storage/postgres";
export type {
  IndexerConfig,
  ContractConfig,
  IndexedEvent,
  BlockRecord,
  StorageBackend,
  EventHandler,
} from "./types";
```

---

## Usage Example

```ts
import { ReorgSafeIndexer, MemoryStorage } from "reorg-safe-indexer";

const indexer = new ReorgSafeIndexer({
  provider: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
  confirmations: 12,
  startBlock: 18000000,
  batchSize: 1000,
  pollInterval: 15000,
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
  console.log(
    `Transfer: ${event.args.from} → ${event.args.to}: ${event.args.value}`,
  );
});

await indexer.start();
```

---

## Testing

- **Unit**: Reorg detection with mocked provider returning different block hashes
- **Integration**: Hardhat network with `hardhat_mine` + `hardhat_reorg` to simulate reorgs
- **Storage**: Test each backend (Memory, SQLite, PostgreSQL) independently

---

## Publishing — same pattern as other packages.
