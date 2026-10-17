import type { CacheStore, CursorStore } from "@mail-mcp/core";

export function kvCache(kv: KVNamespace): CacheStore {
  return {
    async get(key) {
      return kv.get(`cache:${key}`);
    },
    async set(key, value, ttlSeconds) {
      await kv.put(`cache:${key}`, value, ttlSeconds > 0 ? { expirationTtl: ttlSeconds } : undefined);
    },
    async delete(key) {
      await kv.delete(`cache:${key}`);
    },
  };
}

export function kvCursors(kv: KVNamespace): CursorStore {
  return {
    async get(key) {
      return kv.get(key);
    },
    async set(key, value) {
      await kv.put(key, value);
    },
  };
}
