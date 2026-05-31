import { type Provider, type Block } from "ethers";
import type { BlockRecord, Logger, RetryConfig, StorageBackend } from "./types";
import { withRetry } from "./utils";

/**
 * Tracks processed blocks by persisting their hashes, which the
 * {@link ReorgDetector} later compares against the canonical chain.
 */
export class BlockTracker {
  constructor(
    private provider: Provider,
    private storage: StorageBackend,
    private retry: RetryConfig,
    private logger: Logger,
  ) {}

  /**
   * Record block headers for `[fromBlock, toBlock]`, reusing any headers
   * already present in `blockCache`. Block records carry the number of events
   * indexed in that block.
   */
  async recordBlocks(
    fromBlock: number,
    toBlock: number,
    eventCounts: Map<number, number>,
    blockCache: Map<number, Block | null>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let i = fromBlock; i <= toBlock; i++) {
      let block = blockCache.get(i) ?? null;
      if (!block) {
        block = await withRetry(
          () => this.provider.getBlock(i),
          this.retry,
          this.logger,
          `getBlock(${i})`,
          signal,
        );
        blockCache.set(i, block);
      }
      if (!block || !block.hash) {
        this.logger.warn(`[tracker] could not fetch block ${i}; skipping`);
        continue;
      }
      const record: BlockRecord = {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        eventCount: eventCounts.get(i) ?? 0,
      };
      await this.storage.saveBlock(record);
    }
  }
}
