import type { Provider } from "ethers";

/**
 * A minimal logger interface. Compatible with `console` and most logging
 * libraries (pino, winston, bunyan) out of the box.
 */
export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/**
 * Configuration for a single contract to be indexed.
 */
export interface ContractConfig {
  /** Human-readable name, used in logs. */
  name: string;
  /** Contract address. Case-insensitive; normalized internally. */
  address: string;
  /** Human-readable ABI fragments (e.g. `"event Transfer(address indexed from, ...)"`). */
  abi: string[];
  /**
   * Event names to index. If omitted or empty, all events found in the ABI
   * are indexed.
   */
  events?: string[];
}

/**
 * Retry/backoff policy applied to transient RPC failures.
 */
export interface RetryConfig {
  /** Maximum number of attempts per RPC operation (default: 5). */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 500). */
  baseDelayMs: number;
  /** Maximum delay in ms between retries (default: 30000). */
  maxDelayMs: number;
}

export interface IndexerConfig {
  /** RPC URL or an ethers `Provider` instance. */
  provider: string | Provider;
  /** Number of confirmations before a block is considered safe (default: 12). */
  confirmations?: number;
  /** Starting block number (default: 0). */
  startBlock?: number;
  /** Max block span per `getLogs` call (default: 1000). */
  batchSize?: number;
  /** Polling interval in ms (default: 15000). */
  pollInterval?: number;
  /**
   * How far back (in blocks) the reorg detector is allowed to walk when
   * searching for a fork point (default: 128).
   */
  reorgDepth?: number;
  /** Contracts and events to index. */
  contracts: ContractConfig[];
  /** Storage backend. */
  storage: StorageBackend;
  /** Optional logger (default: a no-op logger). Pass `console` for stdout. */
  logger?: Logger;
  /** Retry/backoff policy for transient RPC errors. */
  retry?: Partial<RetryConfig>;
}

/**
 * A fully-resolved configuration with all defaults applied.
 * @internal
 */
export interface ResolvedConfig {
  confirmations: number;
  startBlock: number;
  batchSize: number;
  pollInterval: number;
  reorgDepth: number;
  contracts: ContractConfig[];
  storage: StorageBackend;
  logger: Logger;
  retry: RetryConfig;
}

export interface IndexedEvent {
  /** Stable unique id: `${transactionHash}-${logIndex}`. */
  id: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  /** Decoded event arguments. BigInt values are preserved in memory. */
  args: Record<string, unknown>;
  /** Block timestamp (unix seconds). */
  timestamp: number;
  /** True if this log was reported as removed by the node (pending reorg). */
  removed: boolean;
}

export interface BlockRecord {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  eventCount: number;
}

export interface StorageBackend {
  /** Initialize storage (create tables, etc.). Must be idempotent. */
  init(): Promise<void>;
  /** Save (upsert) a processed block record. */
  saveBlock(block: BlockRecord): Promise<void>;
  /** Get a block record by number, or `null` if not stored. */
  getBlock(blockNumber: number): Promise<BlockRecord | null>;
  /**
   * Get the latest processed block number, or `0` if nothing is stored.
   * `0` is reserved as the "empty" sentinel; the genesis block is never
   * relied upon as a fork point.
   */
  getLatestBlock(): Promise<number>;
  /** Persist indexed events. Must be idempotent on `id` (upsert/ignore). */
  saveEvents(events: IndexedEvent[]): Promise<void>;
  /** Delete events belonging to a single block. */
  deleteEventsFromBlock(blockNumber: number): Promise<void>;
  /** Delete block records (and their events) from `blockNumber` onward. */
  deleteBlocksFrom(blockNumber: number): Promise<void>;
  /** Query stored events with optional filters. */
  getEvents(filter?: EventFilter): Promise<IndexedEvent[]>;
  /** Release any underlying resources (connections, file handles). */
  close(): Promise<void>;
}

/**
 * Filter for querying stored events.
 */
export interface EventFilter {
  eventName?: string;
  contractAddress?: string;
  fromBlock?: number;
  toBlock?: number;
  /** Max rows to return. */
  limit?: number;
  /** Row offset for pagination. */
  offset?: number;
}

export type EventHandler = (event: IndexedEvent) => void | Promise<void>;

/**
 * Lifecycle events emitted by the indexer.
 */
export interface IndexerEvents {
  /** A batch of blocks was processed. */
  batch: (info: { fromBlock: number; toBlock: number; events: number }) => void;
  /** A reorg was detected and rolled back. */
  reorg: (info: { rollbackFrom: number; blocksRolledBack: number }) => void;
  /** The indexer caught up to the safe head. */
  synced: (info: { latestBlock: number }) => void;
  /** A non-fatal error occurred during polling. */
  error: (error: Error) => void;
}
