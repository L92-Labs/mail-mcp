import type { CacheStore } from "./types.js";

export function memoryCache(): CacheStore {
  const map = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt > 0 && Date.now() > hit.expiresAt) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
      map.set(key, { value, expiresAt });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export async function cachedJson<T>(
  cache: CacheStore | undefined,
  ttlSeconds: number,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cache || ttlSeconds <= 0) return loader();
  const hit = await cache.get(key);
  if (hit !== null) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // fall through
    }
  }
  const value = await loader();
  await cache.set(key, JSON.stringify(value), ttlSeconds);
  return value;
}

export function cacheKey(parts: Array<string | number | boolean | undefined | null>): string {
  return parts.map((p) => (p === undefined || p === null ? "" : String(p))).join("|");
}
