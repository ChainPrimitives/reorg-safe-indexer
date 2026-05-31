import type { Provider } from "ethers";
import type { Logger, RetryConfig, StorageBackend } from "./types";
import { withRetry } from "./utils";

export interface ReorgDetectorOptions {
  /** How far back to walk when searching for the fork point (default: 128). */
  reorgDepth: number;
  retry: RetryConfig;
  logger: Logger;
}

/**
 * Detects chain reorganizations by comparing stored block hashes against the
 * current canonical chain, and rolls storage back to the fork point.
 */
export class ReorgDetector {
  private readonly reorgDepth: number;
  private readonly retry: RetryConfig;
  private readonly logger: Logger;

  constructor(
    private provider: Provider,
    private storage: StorageBackend,
    options: ReorgDetectorOptions,
  ) {
    this.reorgDepth = options.reorgDepth;
    this.retry = options.retry;
    this.logger = options.logger;
  }

  /**
   * Find the fork point — the deepest block at which our stored hash still
   * matches the canonical chain — and return the first block that must be
   * rolled back (fork point + 1).
   *
   * @param signal optional abort signal to cancel in-flight RPC.
   * @returns the block number to roll back from (inclusive), or `null` if no
   *   reorg is detected.
   */
  async detectReorg(signal?: AbortSignal): Promise<number | null> {
    const latestStored = await this.storage.getLatestBlock();
    // `0` is the "empty store" sentinel; nothing to compare yet.
    if (latestStored <= 0) return null;

    const floor = Math.max(0, latestStored - this.reorgDepth);
    let mismatchSeen = false;

    for (let i = latestStored; i >= floor; i--) {
      const storedBlock = await this.storage.getBlock(i);
      if (!storedBlock) continue;

      const chainBlock = await withRetry(
        () => this.provider.getBlock(i),
        this.retry,
        this.logger,
        `getBlock(${i})`,
        signal,
      );

      // If the node can't return the block yet, treat it as inconclusive
      // and stop — we'll retry on the next poll.
      if (!chainBlock || !chainBlock.hash) {
        return mismatchSeen ? i + 1 : null;
      }

      if (storedBlock.hash === chainBlock.hash) {
        // Hashes match: this is the fork point.
        return mismatchSeen ? i + 1 : null;
      }

      // Hash differs: keep walking back to find where the chains agree.
      mismatchSeen = true;
      this.logger.debug(
        `[reorg] hash mismatch at block ${i}: stored=${storedBlock.hash} chain=${chainBlock.hash}`,
      );
    }

    if (mismatchSeen) {
      // The reorg is deeper than `reorgDepth`. Roll back as far as we can and
      // surface a warning — the operator may need to increase `reorgDepth`.
      this.logger.warn(
        `[reorg] reorg deeper than ${this.reorgDepth} blocks; rolling back to ${floor}`,
      );
      return floor;
    }

    return null;
  }

  /**
   * Roll storage back so that everything from `rollbackFrom` onward is removed.
   *
   * @returns the number of stored blocks that were removed.
   */
  async rollback(rollbackFrom: number): Promise<number> {
    const latestStored = await this.storage.getLatestBlock();
    if (rollbackFrom > latestStored) return 0;

    let rolledBack = 0;
    for (let i = rollbackFrom; i <= latestStored; i++) {
      if (await this.storage.getBlock(i)) rolledBack++;
    }

    // `deleteBlocksFrom` is responsible for removing both blocks and their
    // events atomically where the backend supports it.
    await this.storage.deleteBlocksFrom(rollbackFrom);
    return rolledBack;
  }
}
