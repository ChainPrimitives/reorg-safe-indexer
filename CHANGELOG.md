# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-31

### Added

- Initial release.
- `ReorgSafeIndexer` polling engine with confirmation depth, batching, and
  graceful start/stop.
- `ReorgDetector` with configurable rollback depth and fork-point search.
- `EventProcessor` with per-range block-header caching and full ABI decoding.
- `BlockTracker` for persisting block hashes used in reorg detection.
- Storage backends: `MemoryStorage`, `SqliteStorage` (better-sqlite3),
  `PostgresStorage` (pg).
- Idempotent event persistence, BigInt-safe serialization, and event querying
  with filters/pagination.
- Retry with exponential backoff + jitter for transient RPC errors.
- Lifecycle events: `batch`, `reorg`, `synced`, `error`.
- `tick()` for cron-driven (non-polling) deployments.
