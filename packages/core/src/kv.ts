import type { Db } from "./db.js";

/**
 * Tiny durable key-value store for adapter state that is not part of the domain (for example an
 * identity a backend adapter provisioned). Adapters depend on this interface only.
 */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** SQLite-backed store, namespaced so adapters cannot collide. */
export class SqliteKv implements KeyValueStore {
  constructor(
    private readonly db: Db,
    private readonly namespace: string,
  ) {}

  get(key: string): string | undefined {
    const r = this.db
      .prepare("SELECT value FROM kv WHERE namespace = ? AND key = ?")
      .get(this.namespace, key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO kv (namespace, key, value) VALUES (?, ?, ?)")
      .run(this.namespace, key, value);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?").run(this.namespace, key);
  }
}

/** In-memory store for tests. */
export class MemoryKv implements KeyValueStore {
  private m = new Map<string, string>();
  get(key: string) {
    return this.m.get(key);
  }
  set(key: string, value: string) {
    this.m.set(key, value);
  }
  delete(key: string) {
    this.m.delete(key);
  }
}
