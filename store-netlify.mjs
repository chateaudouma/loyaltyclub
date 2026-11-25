// Netlify Blobs wrapped in the small interface the app uses.
import { getStore } from '@netlify/blobs';
export function blobStore() {
  const s = getStore({ name: 'douma-loyalty', consistency: 'strong' });
  return {
    async getJSON(key) {
      const r = await s.getWithMetadata(key, { type: 'json', consistency: 'strong' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async setJSON(key, data, opts = {}) {
      const r = await s.setJSON(key, data, opts);
      return { modified: r?.modified ?? true };
    },
    async list(prefix) {
      const out = [];
      for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
      return out;
    },
    async del(key) { await s.delete(key); },
  };
}
export const envFrom = (get) => Object.fromEntries([
  'STAFF_PIN', 'OWNER_PIN', 'SESSION_SECRET', 'SITE_URL', 'URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
  'APPLE_PASS_TYPE_ID', 'APPLE_TEAM_ID', 'APPLE_PASS_CERT', 'APPLE_PASS_KEY', 'APPLE_PASS_KEY_PASSWORD', 'APPLE_WWDR_CERT',
  'GOOGLE_WALLET_ISSUER_ID', 'GOOGLE_WALLET_SERVICE_ACCOUNT', 'RESEND_API_KEY', 'EMAIL_FROM',
].map((k) => [k, get(k)]));
