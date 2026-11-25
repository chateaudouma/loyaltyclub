// In-memory store with the same behaviour as Netlify Blobs (used for local testing only).
export function memStore() {
  const mem = new Map(); let ver = 0;
  return {
    mem,
    async getJSON(k) { const v = mem.get(k); return v ? { data: structuredClone(v.data), etag: String(v.etag) } : null; },
    async setJSON(k, data, o = {}) {
      await new Promise((r) => setTimeout(r, 0)); // simulate network; check-and-set below is atomic
      const cur = mem.get(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || String(cur.etag) !== o.onlyIfMatch)) return { modified: false };
      mem.set(k, { data: structuredClone(data), etag: ++ver });
      return { modified: true };
    },
    async list(p) { return [...mem.keys()].filter((k) => k.startsWith(p)); },
    async del(k) { mem.delete(k); },
  };
}
