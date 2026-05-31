import type { Block, Log, Provider } from "ethers";

export interface MockBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface MockLog {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  index: number;
  address: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

/**
 * A minimal in-memory stand-in for an ethers `Provider`, sufficient for the
 * indexer's needs: `getBlockNumber`, `getBlock`, and `getLogs`. Block hashes
 * can be mutated mid-test to simulate reorgs.
 */
export class MockProvider {
  private chain = new Map<number, MockBlock>();
  private logs: MockLog[] = [];
  private head = 0;

  /** number of getLogs calls, for assertions on batching/caching. */
  getLogsCalls = 0;
  getBlockCalls = 0;

  setHead(n: number): void {
    this.head = n;
  }

  setBlock(block: MockBlock): void {
    this.chain.set(block.number, block);
    if (block.number > this.head) this.head = block.number;
  }

  /** Bulk-generate a linear chain `[from, to]` with deterministic hashes. */
  fillChain(from: number, to: number, salt = "a"): void {
    let parentHash = this.chain.get(from - 1)?.hash ?? `0x${"0".repeat(64)}`;
    for (let i = from; i <= to; i++) {
      const hash = `0x${salt}${i.toString(16).padStart(63, "0")}`;
      this.chain.set(i, {
        number: i,
        hash,
        parentHash,
        timestamp: 1_700_000_000 + i * 12,
      });
      parentHash = hash;
    }
    if (to > this.head) this.head = to;
  }

  /** Rewrite blocks `[from, to]` with a new salt to simulate a reorg. */
  reorg(from: number, to: number, salt: string): void {
    this.fillChain(from, to, salt);
  }

  /** Hash of a stored block, or a zero hash if unknown. */
  hashOf(blockNumber: number): string {
    return this.chain.get(blockNumber)?.hash ?? `0x${"0".repeat(64)}`;
  }

  addLog(log: MockLog): void {
    this.logs.push(log);
  }

  clearLogs(): void {
    this.logs = [];
  }

  async getBlockNumber(): Promise<number> {
    return this.head;
  }

  async getBlock(blockNumber: number): Promise<Block | null> {
    this.getBlockCalls++;
    const b = this.chain.get(blockNumber);
    if (!b) return null;
    return {
      number: b.number,
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: b.timestamp,
    } as unknown as Block;
  }

  async getLogs(filter: {
    address?: string;
    fromBlock: number;
    toBlock: number;
    topics?: (string | string[] | null)[];
  }): Promise<Log[]> {
    this.getLogsCalls++;
    const addr = filter.address?.toLowerCase();
    const topicFilter = filter.topics?.[0];
    const allowed =
      topicFilter == null
        ? null
        : new Set(Array.isArray(topicFilter) ? topicFilter : [topicFilter]);

    return this.logs
      .filter((l) => {
        if (l.blockNumber < filter.fromBlock || l.blockNumber > filter.toBlock)
          return false;
        if (addr && l.address.toLowerCase() !== addr) return false;
        if (allowed && !allowed.has(l.topics[0]!)) return false;
        return true;
      })
      .map((l) => ({ ...l }) as unknown as Log);
  }

  /** Cast to a `Provider` for injection into components under test. */
  asProvider(): Provider {
    return this as unknown as Provider;
  }
}
