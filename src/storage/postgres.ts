import type {
  StorageBackend,
  BlockRecord,
  IndexedEvent,
  EventFilter,
} from "../types";
import { serializeBigInts, normalizeAddress } from "../utils";

/** Structural type for the slice of `pg.Pool` we use. */
interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

interface BlockRow {
  number: number;
  hash: string;
  parent_hash: string;
  timestamp: number;
  event_count: number;
}

interface EventRow {
  id: string;
  block_number: number;
  block_hash: string;
  transaction_hash: string;
  log_index: number;
  contract_address: string;
  event_name: string;
  args: Record<string, unknown>;
  timestamp: number;
  removed: boolean;
}

/**
 * PostgreSQL storage backend backed by `pg`.
 *
 * `pg` is an optional peer dependency; install it separately:
 * `npm install pg`.
 */
export class PostgresStorage implements StorageBackend {
  private pool: PgPool;

  /**
   * @param connection A connection string, or a pre-constructed `pg.Pool`.
   */
  constructor(connection: string | PgPool) {
    if (typeof connection === "string") {
      let Pool: new (config: { connectionString: string }) => PgPool;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ({ Pool } = require("pg"));
      } catch {
        throw new Error(
          "PostgresStorage requires the optional peer dependency 'pg'. " +
            "Install it with: npm install pg",
        );
      }
      this.pool = new Pool({ connectionString: connection });
    } else {
      this.pool = connection;
    }
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS indexed_blocks (
        number       BIGINT PRIMARY KEY,
        hash         VARCHAR(66) NOT NULL,
        parent_hash  VARCHAR(66) NOT NULL,
        timestamp    BIGINT NOT NULL,
        event_count  INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS indexed_events (
        id                VARCHAR(132) PRIMARY KEY,
        block_number      BIGINT NOT NULL,
        block_hash        VARCHAR(66) NOT NULL,
        transaction_hash  VARCHAR(66) NOT NULL,
        log_index         INTEGER NOT NULL,
        contract_address  VARCHAR(42) NOT NULL,
        event_name        VARCHAR(256) NOT NULL,
        args              JSONB NOT NULL,
        timestamp         BIGINT NOT NULL,
        removed           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
       ON CONFLICT (number) DO UPDATE SET
         hash = EXCLUDED.hash,
         parent_hash = EXCLUDED.parent_hash,
         timestamp = EXCLUDED.timestamp,
         event_count = EXCLUDED.event_count`,
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
    const row = result.rows[0] as BlockRow;
    return {
      number: Number(row.number),
      hash: row.hash,
      parentHash: row.parent_hash,
      timestamp: Number(row.timestamp),
      eventCount: row.event_count,
    };
  }

  async getLatestBlock(): Promise<number> {
    const result = await this.pool.query(
      "SELECT MAX(number) AS num FROM indexed_blocks",
    );
    const row = result.rows[0] as { num: string | number | null } | undefined;
    return row?.num != null ? Number(row.num) : 0;
  }

  async saveEvents(events: IndexedEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Single multi-row INSERT for efficiency and atomicity.
    const cols = 10;
    const values: string[] = [];
    const params: unknown[] = [];
    events.forEach((event, i) => {
      const base = i * cols;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
      );
      params.push(
        event.id,
        event.blockNumber,
        event.blockHash,
        event.transactionHash,
        event.logIndex,
        normalizeAddress(event.contractAddress),
        event.eventName,
        JSON.stringify(serializeBigInts(event.args)),
        event.timestamp,
        event.removed,
      );
    });
    await this.pool.query(
      `INSERT INTO indexed_events
         (id, block_number, block_hash, transaction_hash, log_index,
          contract_address, event_name, args, timestamp, removed)
       VALUES ${values.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      params,
    );
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

  async getEvents(filter: EventFilter = {}): Promise<IndexedEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (filter.eventName) {
      clauses.push(`event_name = $${p++}`);
      params.push(filter.eventName);
    }
    if (filter.contractAddress) {
      clauses.push(`contract_address = $${p++}`);
      params.push(normalizeAddress(filter.contractAddress));
    }
    if (filter.fromBlock !== undefined) {
      clauses.push(`block_number >= $${p++}`);
      params.push(filter.fromBlock);
    }
    if (filter.toBlock !== undefined) {
      clauses.push(`block_number <= $${p++}`);
      params.push(filter.toBlock);
    }

    let sql = "SELECT * FROM indexed_events";
    if (clauses.length > 0) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY block_number ASC, log_index ASC";
    if (filter.limit !== undefined) {
      sql += ` LIMIT $${p++}`;
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ` OFFSET $${p++}`;
        params.push(filter.offset);
      }
    }

    const result = await this.pool.query(sql, params);
    return (result.rows as EventRow[]).map((row) => ({
      id: row.id,
      blockNumber: Number(row.block_number),
      blockHash: row.block_hash,
      transactionHash: row.transaction_hash,
      logIndex: row.log_index,
      contractAddress: row.contract_address,
      eventName: row.event_name,
      args:
        typeof row.args === "string"
          ? (JSON.parse(row.args) as Record<string, unknown>)
          : row.args,
      timestamp: Number(row.timestamp),
      removed: row.removed,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
