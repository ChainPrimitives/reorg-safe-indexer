import { Interface, type Provider, type Log, type Block } from "ethers";
import type {
  ContractConfig,
  IndexedEvent,
  Logger,
  RetryConfig,
} from "./types";
import { normalizeAddress, withRetry } from "./utils";

/**
 * Decodes raw logs into {@link IndexedEvent}s for a set of contracts.
 *
 * Holds a per-run cache of block headers so that many logs in the same block
 * resolve their timestamp with a single RPC call.
 */
export class EventProcessor {
  private interfaces = new Map<string, Interface>();
  /** Topic filter per contract address (null = all events). */
  private topicFilters = new Map<string, string[] | null>();

  constructor(
    private provider: Provider,
    private contracts: ContractConfig[],
    private retry: RetryConfig,
    private logger: Logger,
  ) {
    for (const contract of contracts) {
      const key = normalizeAddress(contract.address);
      const iface = new Interface(contract.abi);
      this.interfaces.set(key, iface);
      this.topicFilters.set(key, this.buildTopicFilter(iface, contract));
    }
  }

  /** Addresses to pass to `getLogs`. */
  get addresses(): string[] {
    return this.contracts.map((c) => c.address);
  }

  /**
   * Decode a batch of logs into events. A shared `blockCache` should be passed
   * across calls within the same block range to minimize `getBlock` calls.
   */
  async decodeLogs(
    logs: readonly Log[],
    blockCache: Map<number, Block | null>,
    signal?: AbortSignal,
  ): Promise<IndexedEvent[]> {
    const events: IndexedEvent[] = [];

    for (const log of logs) {
      const key = normalizeAddress(log.address);
      const iface = this.interfaces.get(key);
      if (!iface) continue;

      let parsed;
      try {
        parsed = iface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
      } catch (error) {
        this.logger.debug(
          `[processor] failed to parse log ${log.transactionHash}-${log.index}`,
          error,
        );
        continue;
      }
      if (!parsed) continue;

      const block = await this.getBlock(log.blockNumber, blockCache, signal);

      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        // Fall back to positional key for unnamed params.
        args[input.name || `arg${i}`] = parsed!.args[i];
      });

      events.push({
        id: `${log.transactionHash}-${log.index}`,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.index,
        contractAddress: log.address,
        eventName: parsed.name,
        args,
        timestamp: block?.timestamp ?? 0,
        removed: log.removed ?? false,
      });
    }

    return events;
  }

  /** The combined topic filter (`topics[0]`) across all contracts. */
  topicsFor(address: string): string[] | null {
    return this.topicFilters.get(normalizeAddress(address)) ?? null;
  }

  private buildTopicFilter(
    iface: Interface,
    contract: ContractConfig,
  ): string[] | null {
    if (!contract.events || contract.events.length === 0) {
      return null; // index all events
    }
    const topics: string[] = [];
    for (const name of contract.events) {
      const fragment = iface.getEvent(name);
      if (!fragment) {
        this.logger.warn(
          `[processor] event "${name}" not found in ABI for ${contract.name} (${contract.address})`,
        );
        continue;
      }
      topics.push(fragment.topicHash);
    }
    return topics.length > 0 ? topics : null;
  }

  private async getBlock(
    blockNumber: number,
    cache: Map<number, Block | null>,
    signal?: AbortSignal,
  ): Promise<Block | null> {
    if (cache.has(blockNumber)) {
      return cache.get(blockNumber) ?? null;
    }
    const block = await withRetry(
      () => this.provider.getBlock(blockNumber),
      this.retry,
      this.logger,
      `getBlock(${blockNumber})`,
      signal,
    );
    cache.set(blockNumber, block);
    return block;
  }
}
