import { EventEmitter } from "node:events";
import { JsonRpcProvider, type Provider, type Block } from "ethers";
import type {
  IndexerConfig,
  ResolvedConfig,
  IndexedEvent,
  EventHandler,
  IndexerEvents,
  RetryConfig,
  Logger,
} from "./types";
import { ReorgDetector } from "./reorg-detector";
import { EventProcessor } from "./event-processor";
import { BlockTracker } from "./block-tracker";
import { noopLogger, sleep, withRetry } from "./utils";

const DEFAULTS = {
  confirmations: 12,
  startBlock: 0,
  batchSize: 1000,
  pollInterval: 15000,
  reorgDepth: 128,
} as const;

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30000,
};

/**
 * Reorg-safe blockchain event indexer.
 *
 * Polls an EVM chain for logs from configured contracts, processes them only
 * once they are buried under `confirmations` blocks, persists them to a
 * pluggable storage backend, and automatically rolls back on reorganizations.
 *
 * @example
 * ```ts
 * const indexer = new ReorgSafeIndexer({
 *   provider: "https://rpc.example",
 *   storage: new MemoryStorage(),
 *   contracts: [{ name: "USDC", address: "0x...", abi: [...], events: ["Transfer"] }],
 * });
 * indexer.on("Transfer", async (e) => console.log(e.args));
 * await indexer.start();
 * ```
 */
export class ReorgSafeIndexer {
  private readonly provider: Provider;
  private readonly config: ResolvedConfig;
  private readonly reorgDetector: ReorgDetector;
  private readonly processor: EventProcessor;
  private readonly tracker: BlockTracker;
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly emitter = new EventEmitter();

  private running = false;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(config: IndexerConfig) {
    const logger = config.logger ?? noopLogger;
    const retry: RetryConfig = { ...DEFAULT_RETRY, ...config.retry };

    this.provider =
      typeof config.provider === "string"
        ? new JsonRpcProvider(config.provider)
        : config.provider;

    this.config = {
      confirmations: config.confirmations ?? DEFAULTS.confirmations,
      startBlock: config.startBlock ?? DEFAULTS.startBlock,
      batchSize: config.batchSize ?? DEFAULTS.batchSize,
      pollInterval: config.pollInterval ?? DEFAULTS.pollInterval,
      reorgDepth: config.reorgDepth ?? DEFAULTS.reorgDepth,
      contracts: config.contracts,
      storage: config.storage,
      logger,
      retry,
    };

    if (this.config.contracts.length === 0) {
      throw new Error("ReorgSafeIndexer: at least one contract is required");
    }
    if (this.config.confirmations < 0) {
      throw new Error("ReorgSafeIndexer: confirmations must be >= 0");
    }
    if (this.config.batchSize < 1) {
      throw new Error("ReorgSafeIndexer: batchSize must be >= 1");
    }

    this.reorgDetector = new ReorgDetector(this.provider, this.config.storage, {
      reorgDepth: this.config.reorgDepth,
      retry,
      logger,
    });
    this.processor = new EventProcessor(
      this.provider,
      this.config.contracts,
      retry,
      logger,
    );
    this.tracker = new BlockTracker(
      this.provider,
      this.config.storage,
      retry,
      logger,
    );
  }

  /** Register a handler for a named event. Returns `this` for chaining. */
  on(eventName: string, handler: EventHandler): this {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
    return this;
  }

  /** Subscribe to a lifecycle event (`batch`, `reorg`, `synced`, `error`). */
  onLifecycle<K extends keyof IndexerEvents>(
    event: K,
    listener: IndexerEvents[K],
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Initialize storage and begin polling. Resolves once polling has begun. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.config.storage.init();
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.poll();
    this.config.logger.info("[indexer] started");
  }

  /**
   * Stop polling and wait for the current iteration to finish.
   * Does not close the storage backend; call `storage.close()` yourself if
   * you own its lifecycle.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    try {
      await this.loopPromise;
    } finally {
      this.loopPromise = null;
      this.abortController = null;
      this.config.logger.info("[indexer] stopped");
    }
  }

  /** Whether the indexer is currently polling. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single end-to-end iteration: reorg check + catch-up to the safe head.
   * Useful for tests and for cron-driven (non-polling) deployments.
   *
   * @returns the safe block reached, or `null` if nothing to do.
   */
  async tick(signal?: AbortSignal): Promise<number | null> {
    const currentBlock = await withRetry(
      () => this.provider.getBlockNumber(),
      this.config.retry,
      this.config.logger,
      "getBlockNumber",
      signal,
    );

    // 1. Reorg detection + rollback.
    const rollbackFrom = await this.reorgDetector.detectReorg(signal);
    if (rollbackFrom !== null) {
      const rolledBack = await this.reorgDetector.rollback(rollbackFrom);
      this.config.logger.info(
        `[reorg] rolled back ${rolledBack} block(s) from ${rollbackFrom}`,
      );
      this.emitter.emit("reorg", {
        rollbackFrom,
        blocksRolledBack: rolledBack,
      });
    }

    // 2. Compute the safe range.
    const safeBlock = currentBlock - this.config.confirmations;
    if (safeBlock < this.config.startBlock) return null;

    const lastProcessed = await this.config.storage.getLatestBlock();
    const fromBlock = Math.max(lastProcessed + 1, this.config.startBlock);
    if (fromBlock > safeBlock) {
      this.emitter.emit("synced", { latestBlock: safeBlock });
      return safeBlock;
    }

    // 3. Process in batches.
    for (
      let start = fromBlock;
      start <= safeBlock;
      start += this.config.batchSize
    ) {
      if (signal?.aborted) break;
      const end = Math.min(start + this.config.batchSize - 1, safeBlock);
      await this.processBlockRange(start, end, signal);
    }

    this.emitter.emit("synced", { latestBlock: safeBlock });
    return safeBlock;
  }

  private async poll(): Promise<void> {
    const signal = this.abortController!.signal;
    while (this.running) {
      try {
        await this.tick(signal);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.config.logger.error("[indexer] poll error", err);
        // Surface to listeners; if none are attached, EventEmitter would throw
        // on "error", so only emit when someone is listening.
        if (this.emitter.listenerCount("error") > 0) {
          this.emitter.emit("error", err);
        }
      }
      if (!this.running) break;
      await sleep(this.config.pollInterval, signal);
    }
  }

  /**
   * Process a single block range: fetch logs, decode, persist events and block
   * records, then dispatch to user handlers.
   *
   * Ordering matters: events and block records are persisted *before* handlers
   * run. If a handler throws, the indexer state stays consistent and the
   * handler can be retried out-of-band — persistence is the source of truth.
   */
  private async processBlockRange(
    fromBlock: number,
    toBlock: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const blockCache = new Map<number, Block | null>();
    const allEvents: IndexedEvent[] = [];

    for (const contract of this.config.contracts) {
      const topics = this.processor.topicsFor(contract.address);
      const logs = await withRetry(
        () =>
          this.provider.getLogs({
            address: contract.address,
            fromBlock,
            toBlock,
            topics: topics ? [topics] : [],
          }),
        this.config.retry,
        this.config.logger,
        `getLogs(${contract.name}, ${fromBlock}-${toBlock})`,
        signal,
      );

      const decoded = await this.processor.decodeLogs(logs, blockCache, signal);
      allEvents.push(...decoded);
    }

    // Sort for deterministic handler dispatch order.
    allEvents.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber - b.blockNumber,
    );

    // Per-block event counts for block records.
    const eventCounts = new Map<number, number>();
    for (const event of allEvents) {
      eventCounts.set(
        event.blockNumber,
        (eventCounts.get(event.blockNumber) ?? 0) + 1,
      );
    }

    // 1. Persist events (idempotent) ...
    if (allEvents.length > 0) {
      await this.config.storage.saveEvents(allEvents);
    }
    // 2. ... then block records, marking the range as processed.
    await this.tracker.recordBlocks(
      fromBlock,
      toBlock,
      eventCounts,
      blockCache,
      signal,
    );

    // 3. Dispatch to handlers. Persistence already succeeded, so a handler
    // failure does not roll back indexed data.
    for (const event of allEvents) {
      await this.dispatch(event);
    }

    this.config.logger.debug(
      `[indexer] processed blocks ${fromBlock}-${toBlock} (${allEvents.length} events)`,
    );
    this.emitter.emit("batch", {
      fromBlock,
      toBlock,
      events: allEvents.length,
    });
  }

  private async dispatch(event: IndexedEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventName);
    if (!handlers || handlers.length === 0) return;
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.config.logger.error(
          `[indexer] handler for "${event.eventName}" threw (event ${event.id})`,
          err,
        );
        if (this.emitter.listenerCount("error") > 0) {
          this.emitter.emit("error", err);
        }
      }
    }
  }
}

export type { Logger };
