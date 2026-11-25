// Shared helpers: money in integer cents, Beirut time, ids, and safe storage updates.
import crypto from 'node:crypto';

export const TZ_DEFAULT = 'Asia/Beirut';

// ---------- money (always integer cents) ----------
export const toCents = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) throw new Error('Invalid amount.');
  return Math.round(n * 100);
};
export const pct = (cents, ratePercent) => Math.round((cents * ratePercent) / 100); // half-up rounding to the cent
export const fmt = (cents, symbol = '$') => `${cents < 0 ? '-' : ''}${symbol}${(Math.abs(cents) / 100).toFixed(2)}`;

// ---------- ids ----------
export const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
export const txid = () => 'TX' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();

// ---------- time ----------
export function zoneParts(date, tz = TZ_DEFAULT) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
export const dayKey = (date = new Date(), tz = TZ_DEFAULT) => { const p = zoneParts(date, tz); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const monthKey = (date = new Date(), tz = TZ_DEFAULT) => dayKey(date, tz).slice(0, 7);
// "2026-12-24T18:00" in the venue's time zone -> ISO UTC string
export function localToISO(local, tz = TZ_DEFAULT) {
  const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) throw new Error('Invalid date/time.');
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += want - shown;
  }
  return new Date(guess).toISOString();
}
export function isoToLocal(iso, tz = TZ_DEFAULT) {
  const p = zoneParts(new Date(iso), tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}
export const addMonths = (iso, months) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString(); };
export const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 864e5).toISOString();

// ---------- text ----------
export const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export const normPhone = (raw) => {
  let d = String(raw ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '961' + d.slice(1);
  else if (d.length <= 8) d = '961' + d;
  return d.replace(/\D/g, '');
};
export const normEmail = (e) => { const s = String(e ?? '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : ''; };
export const normRef = (r) => String(r ?? '').trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9._/-]/g, '').slice(0, 40);
export const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hashPin = (pin, salt = rid(8)) => ({ salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') });
export const checkPin = (pin, rec) => rec && safeEq(crypto.scryptSync(String(pin), rec.salt, 32).toString('hex'), rec.hash);

// ---------- storage helpers ----------
// store: { getJSON(key) -> {data, etag}|null, setJSON(key, data, {onlyIfMatch|onlyIfNew}) -> {modified}, list(prefix) -> keys, del(key) }
export class Busy extends Error {}
export async function update(store, key, fn, { create = false, tries = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    const cur = await store.getJSON(key);
    if (!cur && !create) return { data: null, changed: false };
    const draft = cur ? structuredClone(cur.data) : null;
    const next = await fn(draft);
    if (next === undefined) return { data: cur?.data ?? null, changed: false };
    const res = await store.setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return { data: next, changed: true };
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (i + 1)));
  }
  throw new Busy('The system is busy, please try again.');
}
export async function append(store, key, items, max = 20000) {
  if (!items.length) return;
  await update(store, key, (l) => { l = l || []; l.push(...items); return l.length > max ? l.slice(-max) : l; }, { create: true });
}
