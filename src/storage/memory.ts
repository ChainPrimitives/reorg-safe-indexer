import type {
  StorageBackend,
  BlockRecord,
  IndexedEvent,
  EventFilter,
} from "../types";
import { normalizeAddress } from "../utils";

/**
 * In-memory storage backend — useful for testing and development.
 *
 * Not durable: all data is lost when the process exits.
 */
export class MemoryStorage implements StorageBackend {
  private blocks = new Map<number, BlockRecord>();
  private events = new Map<number, IndexedEvent[]>();
  /** Tracks event ids per block so saves remain idempotent. */
  private eventIds = new Set<string>();

  async init(): Promise<void> {
    // Nothing to initialize.
  }

  async saveBlock(block: BlockRecord): Promise<void> {
    this.blocks.set(block.number, { ...block });
  }

  async getBlock(blockNumber: number): Promise<BlockRecord | null> {
    const block = this.blocks.get(blockNumber);
    return block ? { ...block } : null;
  }

  async getLatestBlock(): Promise<number> {
    if (this.blocks.size === 0) return 0;
    let max = 0;
    for (const key of this.blocks.keys()) {
      if (key > max) max = key;
    }
    return max;
  }

  async saveEvents(events: IndexedEvent[]): Promise<void> {
    for (const event of events) {
      if (this.eventIds.has(event.id)) continue; // idempotent
      this.eventIds.add(event.id);
      const bucket = this.events.get(event.blockNumber) ?? [];
      bucket.push({ ...event });
      this.events.set(event.blockNumber, bucket);
    }
  }

  async deleteEventsFromBlock(blockNumber: number): Promise<void> {
    const bucket = this.events.get(blockNumber);
    if (bucket) {
      for (const event of bucket) this.eventIds.delete(event.id);
    }
    this.events.delete(blockNumber);
  }

  async deleteBlocksFrom(blockNumber: number): Promise<void> {
    for (const key of [...this.blocks.keys()]) {
      if (key >= blockNumber) this.blocks.delete(key);
    }
    for (const key of [...this.events.keys()]) {
      if (key >= blockNumber) {
        const bucket = this.events.get(key);
        if (bucket) {
          for (const event of bucket) this.eventIds.delete(event.id);
        }
        this.events.delete(key);
      }
    }
  }

  async getEvents(filter: EventFilter = {}): Promise<IndexedEvent[]> {
    let all: IndexedEvent[] = [];
    for (const bucket of this.events.values()) {
      all = all.concat(bucket);
    }

    const contract = filter.contractAddress
      ? normalizeAddress(filter.contractAddress)
      : undefined;

    const result = all.filter((e) => {
      if (filter.eventName && e.eventName !== filter.eventName) return false;
      if (contract && normalizeAddress(e.contractAddress) !== contract)
        return false;
      if (filter.fromBlock !== undefined && e.blockNumber < filter.fromBlock)
        return false;
      if (filter.toBlock !== undefined && e.blockNumber > filter.toBlock)
        return false;
      return true;
    });

    result.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber - b.blockNumber,
    );

    const offset = filter.offset ?? 0;
    const end = filter.limit !== undefined ? offset + filter.limit : undefined;
    return result.slice(offset, end).map((e) => ({ ...e }));
  }

  async close(): Promise<void> {
    this.blocks.clear();
    this.events.clear();
    this.eventIds.clear();
  }
}
