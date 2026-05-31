/**
 * Re-exports the storage contract types so backends can import from a single,
 * stable module path: `reorg-safe-indexer/storage/interface` semantics.
 */
export type {
  StorageBackend,
  BlockRecord,
  IndexedEvent,
  EventFilter,
} from "../types";
