// Château Douma Loyalty Club — server API (runs as a Netlify Function).
// Storage: Netlify Blobs. Each member is one record updated atomically (optimistic locking),
// so a purchase, redemption, refund or reward either fully happens or not at all.
import * as webpushNs from 'web-push';
import crypto from 'node:crypto';
import {
  toCents, fmt, rid, dayKey, monthKey, localToISO, isoToLocal, addDays, clean, normPhone, normEmail, normRef,
  safeEq, sha, hashPin, checkPin, update, append, Busy,
} from './util.mjs';
import * as E from './engine.mjs';
import { appleConfig, buildPkpass, applePush, googleConfig, googleSaveUrl, googleUpdate, TIER_COLORS } from './wallet.mjs';

const webpush = webpushNs.default ?? webpushNs;

// ---------- responses ----------
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (msg, status = 400) => json({ error: msg }, status);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(msg, status); };

// ---------- context ----------
function makeCtx(req, store, env) {
  const url = new URL(req.url);
  const origin = (env.SITE_URL || env.URL || url.origin).replace(/\/$/, '');
  return { req, store, env, url, origin, now: env.__now || new Date().toISOString(), cache: {} };
}
async function settings(ctx) {
  if (!ctx.cache.settings) ctx.cache.settings = E.mergeSettings((await ctx.store.getJSON('config/settings'))?.data);
  return ctx.cache.settings;
}
async function campaigns(ctx) {
  if (!ctx.cache.campaigns) ctx.cache.campaigns = (await ctx.store.getJSON('config/campaigns'))?.data || [];
  return ctx.cache.campaigns;
}
async function secret(ctx) {
  if (ctx.env.SESSION_SECRET) return ctx.env.SESSION_SECRET;
  let s = (await ctx.store.getJSON('config/secret'))?.data;
  if (!s) { await ctx.store.setJSON('config/secret', { v: rid(32) }, { onlyIfNew: true }); s = (await ctx.store.getJSON('config/secret')).data; }
  return s.v;
}

// ---------- events, audit, index ----------
// Purchase entries also carry running refund totals; only refund/reversal entries count those in reports.
const ev = (e, mid) => evRaw(e.type === 'refund' || e.type === 'reversal' ? e : { ...e, spendReversed: undefined, restored: undefined, earnedReversed: undefined, cashRefund: undefined, refund: undefined }, mid);
const evRaw = (e, mid) => ({
  at: e.at, tx: e.id, m: mid, type: e.type, cat: e.category, inv: e.invoice, paid: e.paid, base: e.base, earned: e.earned, red: e.redeemed,
  rew: e.reward, exp: e.expired, adj: e.adjust, refund: e.refund, rest: e.restored, er: e.earnedReversed, sr: e.spendReversed,
  cash: e.cashRefund, ref: e.invoiceRef, by: e.by?.name, tier: e.toTier, locked: e.locked, label: e.label,
});
async function logEvents(ctx, mid, entries) {
  const byMonth = {};
  for (const e of entries) (byMonth[monthKey(new Date(e.at))] ||= []).push(ev(e, mid));
  for (const [mk, list] of Object.entries(byMonth)) await append(ctx.store, `events/${mk}`, list);
}
async function audit(ctx, by, action, member, details, reason) {
  await append(ctx.store, `audit/${monthKey(new Date(ctx.now))}`, [{ at: ctx.now, by: by ? { id: by.id, name: by.name, role: by.role } : null, action, member: member || null, details: details || null, reason: reason || null }]);
}
async function indexMember(ctx, m) {
  const s = await settings(ctx);
  await update(ctx.store, 'index/members', (ix) => { ix = ix || {}; ix[m.id] = E.summary(m, s, ctx.now); return ix; }, { create: true });
}

// ---------- members ----------
async function loadMember(ctx, id) {
  if (!/^CD\d{3,7}$/.test(String(id || ''))) return null;
  const rec = await ctx.store.getJSON(`members/${id}`);
  if (!rec) return null;
  const m = rec.data;
  if (m.schema < E.SCHEMA) {
    // first time we see an old record: upgrade it safely through a normal write
    await mutate(ctx, id, () => ({}), {});
    return (await ctx.store.getJSON(`members/${id}`)).data;
  }
  return m;
}

// Atomically change one member. fn gets the draft record and returns {notes, events}.
// Lazy upkeep (expiry, birthday) runs in the same write.
async function mutate(ctx, id, fn, { by, action, reason, details, quiet } = {}) {
  const s = await settings(ctx);
  let result, notes, events, before;
  const res = await update(ctx.store, `members/${id}`, (m) => {
    if (!m) throw new HttpError('Member not found.', 404);
    notes = []; events = []; result = null;
    const migrated = E.migrate(m, s, ctx.now);
    before = JSON.stringify([E.balance(m, ctx.now).available, m.tier, m.name, m.lastVisit, m.status]);
    const ex = E.applyExpiry(m, s, ctx.now); const bd = E.maybeBirthday(m, s, ctx.now);
    result = fn(m) || {};
    notes = [...ex.notes, ...bd.notes, ...(result.notes || [])];
    events = [...ex.events, ...bd.events, ...(result.events || [])];
    const changed = migrated || ex.changed || bd.changed || result.changed !== false && (result.events?.length || result.notes?.length || result.touch);
    if (!changed) return undefined;
    for (const n of notes) {
      m.inbox.push({ id: rid(6), at: ctx.now, type: n.type, essential: n.essential, title: n.title, body: n.body });
    }
    if (m.inbox.length > 80) m.inbox = m.inbox.slice(-80);
    const after = JSON.stringify([E.balance(m, ctx.now).available, m.tier, m.name, m.lastVisit, m.status]);
    if (after !== before) m.wallet.updatedAt = ctx.now;
    return m;
  });
  const m = res.data;
  if (!res.changed || !m) return { m, result };
  const walletChanged = JSON.stringify([E.balance(m, ctx.now).available, m.tier, m.name, m.lastVisit, m.status]) !== before;
  // follow-up work (outside the money write; safe to retry / rebuild)
  await logEvents(ctx, m.id, events);
  await indexMember(ctx, m);
  if (action) await audit(ctx, by, action, m.id, details || (result.entry ? { tx: result.entry.id } : null), reason);
  if (!quiet) await Promise.allSettled([pushNotes(ctx, m, notes), walletChanged ? refreshPasses(ctx, m) : null]);
  return { m, result };
}

// ---------- push notifications ----------
async function vapid(ctx) {
  if (ctx.env.VAPID_PUBLIC_KEY && ctx.env.VAPID_PRIVATE_KEY) return { publicKey: ctx.env.VAPID_PUBLIC_KEY, privateKey: ctx.env.VAPID_PRIVATE_KEY };
  let k = (await ctx.store.getJSON('config/vapid'))?.data;
  if (!k) { await ctx.store.setJSON('config/vapid', webpush.generateVAPIDKeys(), { onlyIfNew: true }); k = (await ctx.store.getJSON('config/vapid')).data; }
  return k;
}
async function pushTo(ctx, ids, payload) {
  const keys = await vapid(ctx);
  webpush.setVapidDetails(ctx.env.VAPID_SUBJECT || 'mailto:hello@chateaudouma.com', keys.publicKey, keys.privateKey);
  let sent = 0;
  await Promise.all(ids.map(async (id) => {
    const rec = await ctx.store.getJSON(`subs/${id}`);
    if (!rec?.data?.length) return;
    const dead = [];
    await Promise.all(rec.data.map(async (sub) => {
      try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400 }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint); }
    }));
    if (dead.length) await update(ctx.store, `subs/${id}`, (l) => (l || []).filter((x) => !dead.includes(x.endpoint)));
  }));
  return sent;
}
async function pushNotes(ctx, m, notes) {
  for (const n of notes) if (n.essential || m.prefs.marketing) await pushTo(ctx, [m.id], { title: n.title, body: n.body, tier: n.tier || null });
}

// ---------- wallet passes ----------
async function refreshPasses(ctx, m) {
  const tasks = [];
  const ac = appleConfig(ctx.env);
  if (ac.ready && m.wallet.apple?.length) tasks.push(applePush(ac, m.wallet.apple.map((d) => d.push)));
  const gc = googleConfig(ctx.env);
  if (gc.ready && m.wallet.google) tasks.push(googleUpdate(m, await settings(ctx), ctx.origin, gc, ctx.now).catch(() => false));
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 6000))]);
}

// ---------- auth ----------
const ipOf = (req) => (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
async function rateGate(ctx, bucket, limit, windowMin) {
  const key = `locks/${bucket}-${sha(ipOf(ctx.req)).slice(0, 20)}`;
  const l = (await ctx.store.getJSON(key))?.data;
  if (l && l.until > Date.now()) throw new HttpError('Too many attempts. Please try again later.', 429);
  return {
    async fail() {
      await update(ctx.store, key, (x) => {
        x = x && x.start > Date.now() - windowMin * 60e3 ? x : { n: 0, start: Date.now(), until: 0 };
        x.n++; if (x.n >= limit) { x.until = Date.now() + windowMin * 60e3; x.n = 0; }
        return x;
      }, { create: true });
    },
  };
}
const BASE_STAFF = { scan: true, purchase: true, redeem: true, refund: false, history: false };
async function staffList(ctx) { return (await ctx.store.getJSON('config/staff'))?.data || []; }
async function signToken(ctx, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', await secret(ctx)).update(body).digest('base64url');
  return `${body}.${sig}`;
}
async function session(ctx, needRole) {
  const h = ctx.req.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = tok.split('.');
  need(body && sig, 'Please sign in.', 401);
  const good = crypto.createHmac('sha256', await secret(ctx)).update(body).digest('base64url');
  need(safeEq(sig, good), 'Please sign in again.', 401);
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  need(p.exp > Date.now(), 'Your session expired. Please sign in again.', 401);
  if (p.role === 'staff' && p.sub !== 'shared') {
    const st = (await staffList(ctx)).find((x) => x.id === p.sub);
    need(st && st.active, 'This staff account is no longer active.', 401);
    p.perms = { ...BASE_STAFF, ...st.perms }; p.name = st.name;
  }
  if (p.role === 'staff' && p.sub === 'shared') { need(!!ctx.env.STAFF_PIN, 'Shared staff PIN is no longer active.', 401); p.perms = { ...BASE_STAFF }; }
  if (p.role === 'owner') p.perms = { scan: true, purchase: true, redeem: true, refund: true, history: true, owner: true };
  if (needRole === 'owner') need(p.role === 'owner', 'Only the owner can do this.', 403);
  return { id: p.sub, name: p.name, role: p.role, perms: p.perms };
}

// ---------- helpers ----------
async function body(req) { try { return await req.json(); } catch (_) { return {}; } }
async function customer(ctx, m, t) {
  const rec = await loadMember(ctx, m);
  need(rec && safeEq(rec.token, t || ''), 'Card not found.', 404);
  return rec;
}
async function inboxFor(ctx, m) {
  const all = (await ctx.store.getJSON('messages/all'))?.data || [];
  return [
    ...all.filter((x) => x.at >= m.joinedAt && m.prefs.marketing).map((x) => ({ ...x, scope: 'all' })),
    ...m.inbox.map((x) => ({ ...x, scope: 'you' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}
function publicSettings(s, env) {
  return {
    currency: s.currency, timezone: s.timezone, tiers: s.tiers.map((t) => ({ ...t, colors: TIER_COLORS[t.key] })),
    welcome: s.welcome, birthday: s.birthday, expiry: s.expiry, stamps: s.stamps,
    categories: s.categories, excludedProducts: s.excludedProducts, redemption: s.redemption, terms: s.terms,
    wallet: { apple: appleConfig(env).ready, google: googleConfig(env).ready },
  };
}
const activeCampaignsFor = (list, m, now) => list.filter((c) => E.campaignActive(c, now) && (!c.tiers?.length || c.tiers.includes(m.tier)))
  .map((c) => ({ id: c.id, name: c.name, type: c.type, value: c.value, endAt: c.endAt, categories: c.categories, description: c.description || '' }));

async function findMembers(ctx, q) {
  q = String(q || '').trim();
  if (!q) return [];
  // a scanned QR: https://site/m/<code>
  const qm = q.match(/\/m\/([\w-]{8,40})/) || (/^[\w-]{12,20}$/.test(q) && !/^\d+$/.test(q) && !/^cd\d+$/i.test(q) ? [null, q] : null);
  if (qm) { const ref = (await ctx.store.getJSON(`qr/${qm[1]}`))?.data; if (ref) return [ref.id]; }
  const old = q.match(/[?&]m=(CD\d+)/i); // cards from the first version
  if (old) return [old[1].toUpperCase()];
  const id = q.replace(/^#/, '').match(/^cd\s*-?\s*(\d{3,7})$/i) || q.match(/^(\d{4,6})$/); // member number, with or without CD
  if (id) return [`CD${id[1]}`];
  const em = normEmail(q);
  if (em) { const ref = (await ctx.store.getJSON(`emails/${sha(em)}`))?.data; return ref ? [ref.id] : []; }
  const digits = q.replace(/[^\d]/g, '');
  if (digits.length >= 7) { const ref = (await ctx.store.getJSON(`phones/${normPhone(q)}`))?.data; if (ref) return [ref.id]; }
  const ix = (await ctx.store.getJSON('index/members'))?.data || {};
  const lq = q.toLowerCase();
  return Object.values(ix).filter((x) => x.name.toLowerCase().includes(lq) || (digits.length >= 3 && x.phone.includes(digits))).slice(0, 20).map((x) => x.id);
}

// Staff see only what they need; the owner sees everything.
function sv(m, s, now, by) {
  const v = E.staffView(m, s, now, by.role === 'owner' || by.perms.history);
  if (by.role !== 'owner') { v.phone = m.phone ? '…' + m.phone.slice(-3) : ''; v.email = m.email ? m.email.replace(/^(.).*(@.*)$/, '$1•••$2') : ''; v.dob = m.dob ? '••' + m.dob.slice(4) : ''; delete v.notes; delete v.totals; }
  return v;
}

// ---------- CSV ----------
function csv(rows) { return '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
const money = (c) => (c == null ? '' : (c / 100).toFixed(2));
const csvResp = (name, rows) => new Response(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });

// ---------- analytics ----------
async function eventsBetween(ctx, from, to) {
  const out = [];
  const d = new Date(from.slice(0, 7) + '-01T00:00:00Z');
  const end = new Date(to);
  for (let i = 0; i < 60 && d <= end; i++) {
    const mk = d.toISOString().slice(0, 7);
    const l = (await ctx.store.getJSON(`events/${mk}`))?.data || [];
    out.push(...l.filter((e) => e.at >= from && e.at < to));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
async function analytics(ctx, from, to) {
  const s = await settings(ctx);
  const ix = Object.values((await ctx.store.getJSON('index/members'))?.data || {});
  const evs = await eventsBetween(ctx, from, to);
  const sum = (f) => evs.reduce((a, e) => a + (f(e) || 0), 0);
  const tiers = Object.fromEntries(s.tiers.map((t) => [t.key, ix.filter((x) => x.tier === t.key).length]));
  const sales = sum((e) => (e.type === 'purchase' ? e.base : 0)) - sum((e) => e.sr);
  const paidSales = sum((e) => (e.type === 'purchase' ? e.paid : 0));
  const issued = sum((e) => (e.type === 'purchase' ? e.earned : 0)) + sum((e) => (['welcome', 'birthday', 'complimentary'].includes(e.type) ? e.rew : 0)) - sum((e) => e.er);
  const redeemed = sum((e) => (e.type === 'purchase' ? e.red : 0)) - sum((e) => e.rest);
  const expired = sum((e) => e.exp);
  const purchases = evs.filter((e) => e.type === 'purchase');
  const buyers = new Set(purchases.map((e) => e.m));
  const active = ix.filter((x) => x.visits > 0);
  const inactiveBefore = addDays(ctx.now, -(s.inactiveDays || 60));
  const nextOf = (x) => { const i = E.tierIndex(s, x.tier); const nx = s.tiers[i + 1]; return nx ? { name: nx.name, remaining: nx.min - x.spend } : null; };
  const pick = (x) => ({ id: x.id, name: x.name, tier: x.tier, spend: x.spend, visits: x.visits, lastVisit: x.lastVisit, available: x.available });
  return {
    range: { from, to },
    members: { total: ix.length, ...tiers, newInRange: ix.filter((x) => x.joinedAt >= from && x.joinedAt < to).length, newThisMonth: ix.filter((x) => monthKey(new Date(x.joinedAt), s.timezone) === monthKey(new Date(ctx.now), s.timezone)).length, suspended: ix.filter((x) => x.status !== 'active').length },
    sales, paidSales, purchases: purchases.length, customersBuying: buyers.size,
    issued, redeemed, expired, outstanding: ix.reduce((a, x) => a + x.available, 0), lockedWelcome: ix.reduce((a, x) => a + (x.locked || 0), 0),
    welcome: { count: evs.filter((e) => e.type === 'welcome').length, cents: sum((e) => (e.type === 'welcome' ? e.rew : 0)) },
    birthday: { count: evs.filter((e) => e.type === 'birthday').length, cents: sum((e) => (e.type === 'birthday' ? e.rew : 0)) },
    complimentary: sum((e) => (e.type === 'complimentary' ? e.rew : 0)),
    refunds: sum((e) => e.refund),
    costPercent: sales > 0 ? Math.round((issued / sales) * 10000) / 100 : 0,
    avgSpend: active.length ? Math.round(active.reduce((a, x) => a + x.spend, 0) / active.length) : 0,
    avgVisits: active.length ? Math.round((active.reduce((a, x) => a + x.visits, 0) / active.length) * 10) / 10 : 0,
    returnRate: active.length ? Math.round((ix.filter((x) => x.visits >= 2).length / active.length) * 1000) / 10 : 0,
    topSpenders: [...ix].sort((a, b) => b.spend - a.spend).slice(0, 10).filter((x) => x.spend > 0).map(pick),
    mostFrequent: [...ix].sort((a, b) => b.visits - a.visits).slice(0, 10).filter((x) => x.visits > 0).map(pick),
    inactive: ix.filter((x) => x.status === 'active' && (x.lastVisit ? x.lastVisit < inactiveBefore : x.joinedAt < inactiveBefore)).sort((a, b) => (a.lastVisit || '').localeCompare(b.lastVisit || '')).slice(0, 50).map(pick),
    approaching: ix.map((x) => ({ ...pick(x), next: nextOf(x) })).filter((x) => x.next && x.next.remaining > 0 && x.next.remaining <= (s.approachingWithinCents || 5000)).sort((a, b) => a.next.remaining - b.next.remaining).slice(0, 50),
    daily: Object.entries(purchases.reduce((a, e) => { const k = dayKey(new Date(e.at), s.timezone); a[k] = (a[k] || 0) + (e.base || 0); return a; }, {})).sort(),
  };
}

// ---------- daily upkeep (expiry, warnings, birthdays) ----------
export async function runDaily(store, env) {
  const ctx = makeCtx(new Request('https://local/api/daily'), store, env);
  const keys = await store.list('members/');
  let touched = 0;
  for (const k of keys) {
    const id = k.slice('members/'.length);
    try { const r = await mutate(ctx, id, () => ({}), {}); if (r) touched++; } catch (e) { console.error('daily', id, e.message); }
  }
  return { members: keys.length };
}

// ---------- router ----------
export async function handle(req, store, env = {}) {
  const ctx = makeCtx(req, store, env);
  const path = ctx.url.pathname.replace(/^\/(api|\.netlify\/functions\/api)/, '');
  const method = req.method;
  const q = ctx.url.searchParams;
  try {
    // ================= PUBLIC / CUSTOMER =================
    if (path === '/public/settings' && method === 'GET') return json(publicSettings(await settings(ctx), env));

    if (path === '/join' && method === 'POST') {
      const b = await body(req);
      const s = await settings(ctx);
      const gate = await rateGate(ctx, 'join', 12, 60 * 24);
      const name = clean(b.name, 60), phone = normPhone(b.phone), email = '';
      const dob = clean(b.dob, 10);
      need(name.length >= 2, 'Please enter your full name.');
      need(phone.length >= 8 && phone.length <= 15, 'Please enter a valid phone number.');
      if (dob) {
        need(/^\d{4}-\d{2}-\d{2}$/.test(dob) && !isNaN(new Date(dob)), 'Please check your date of birth.');
        const age = (Date.now() - new Date(dob + 'T00:00:00Z')) / (365.25 * 864e5);
        need(age >= 18 && age < 120, 'You must be 18 or older to join.');
      }
      need(b.adult === true, 'Please confirm you are 18 or older.');
      need(b.consent === true, 'Please accept the terms to join.');
      const pin = String(b.pin || '');
      need(/^\d{4}$/.test(pin), 'Choose a 4-digit PIN to protect your card.');
      need(!/^(\d)\1{3}$/.test(pin) && !['1234', '4321', '0123', '9876'].includes(pin), 'That PIN is too easy to guess. Choose another 4 digits.');
      const exists = 'This phone number already has a card. Tap "Sign in" to open it on this phone.';
      need(!(await store.getJSON(`phones/${phone}`)), exists, 409);
      if (email) need(!(await store.getJSON(`emails/${sha(email)}`)), 'This email already has a card.', 409);
      const counter = (await update(store, 'config/counter', (c) => ({ next: (c?.next || 1000) + 1 }), { create: true })).data;
      const id = `CD${counter.next}`;
      const claims = [];
      try {
        const p = await store.setJSON(`phones/${phone}`, { id }, { onlyIfNew: true });
        need(p.modified, exists, 409); claims.push(`phones/${phone}`);
        if (email) { const e = await store.setJSON(`emails/${sha(email)}`, { id }, { onlyIfNew: true }); need(e.modified, 'This email already has a card.', 409); claims.push(`emails/${sha(email)}`); }
        const { m, notes, events } = E.newMember({ id, name, phone, email, dob, marketing: !!b.marketing }, s, ctx.now);
        m.pin = hashPin(pin);
        for (const n of notes) m.inbox.push({ id: rid(6), at: ctx.now, type: n.type, essential: n.essential, title: n.title, body: n.body });
        await store.setJSON(`qr/${m.qr}`, { id }, { onlyIfNew: true }); claims.push(`qr/${m.qr}`);
        const w = await store.setJSON(`members/${id}`, m, { onlyIfNew: true });
        need(w.modified, 'Please try again.', 409);
        await logEvents(ctx, id, events);
        await indexMember(ctx, m);
        await audit(ctx, null, 'member.join', id, { name });
        return json({ id, token: m.token });
      } catch (e) {
        for (const k of claims) await store.del(k).catch(() => {});
        await gate.fail();
        throw e;
      }
    }

    if (path === '/me' && method === 'GET') {
      let m = await customer(ctx, q.get('m'), q.get('t'));
      const s = await settings(ctx);
      // run lazy upkeep (expiry / birthday) so the card is always current
      const r = await mutate(ctx, m.id, () => ({}), {}); if (r.m) m = r.m;
      return json({
        member: E.customerView(m, s, ctx.now), settings: publicSettings(s, env), inbox: await inboxFor(ctx, m),
        campaigns: activeCampaignsFor(await campaigns(ctx), m, ctx.now), vapidPublicKey: (await vapid(ctx)).publicKey,
        qrUrl: `${ctx.origin}/m/${m.qr}`,
      });
    }

    if (path === '/me/profile' && method === 'POST') {
      const b = await body(req);
      const m0 = await customer(ctx, b.m, b.t);
      const s = await settings(ctx);
      const r = await mutate(ctx, m0.id, (m) => {
        if (b.dob && !m.dob) {
          need(/^\d{4}-\d{2}-\d{2}$/.test(b.dob), 'Please check your date of birth.');
          const age = (Date.now() - new Date(b.dob + 'T00:00:00Z')) / (365.25 * 864e5);
          need(age >= 18 && age < 120, 'Please check your date of birth.');
          m.dob = b.dob; m.dobSetAt = ctx.now;
        } else if (b.dob && m.dob && b.dob !== m.dob) throw new HttpError('Your birthday is already saved. Please ask our team to correct it.', 400);
        if (b.prefs && typeof b.prefs.marketing === 'boolean') m.prefs.marketing = b.prefs.marketing;
        if (b.newPin !== undefined) {
          const np = String(b.newPin);
          need(/^\d{4}$/.test(np), 'Your PIN must be 4 digits.');
          need(!/^(\d)\1{3}$/.test(np) && !['1234', '4321', '0123', '9876'].includes(np), 'That PIN is too easy to guess. Choose another 4 digits.');
          m.pin = hashPin(np); m.pinFails = 0; m.pinLockUntil = null;
        }
        return { touch: true, notes: [], events: [] };
      }, { action: 'member.profile', by: { id: m0.id, name: 'Customer', role: 'customer' }, quiet: true });
      return json({ member: E.customerView(r.m, s, ctx.now) });
    }

    // ---- sign in on another phone with phone number + the member's own 4-digit PIN ----
    if (path === '/login' && method === 'POST') {
      const b = await body(req);
      const gate = await rateGate(ctx, 'login', 10, 15);
      const phone = normPhone(b.phone), pin = String(b.pin || '');
      need(phone.length >= 8 && phone.length <= 15, 'Enter the phone number you joined with.');
      need(/^\d{4}$/.test(pin), 'Enter your 4-digit PIN.');
      const bad = 'Phone number or PIN is not right.';
      const ref = (await store.getJSON(`phones/${phone}`))?.data;
      if (!ref) { await gate.fail(); return fail(bad, 401); }
      let m = await loadMember(ctx, ref.id);
      if (!m) { await gate.fail(); return fail(bad, 401); }
      if (!m.pin) return fail('Your card has no PIN yet. Ask our team to send you your card link on WhatsApp, then set a PIN in Profile.', 403);
      if (m.pinLockUntil && m.pinLockUntil > ctx.now) return fail('Too many wrong PINs. Try again in 15 minutes, or ask our team to send your card link.', 429);
      if (!checkPin(pin, m.pin)) {
        await gate.fail();
        await mutate(ctx, m.id, (x) => { x.pinFails = (x.pinFails || 0) + 1; if (x.pinFails >= 5) { x.pinFails = 0; x.pinLockUntil = addDays(ctx.now, 1 / 96); } return { touch: true }; }, { quiet: true });
        return fail(bad, 401);
      }
      if (m.pinFails) await mutate(ctx, m.id, (x) => { x.pinFails = 0; return { touch: true }; }, { quiet: true });
      return json({ m: m.id, t: m.token });
    }

    if (path === '/subscribe' && method === 'POST') {
      const b = await body(req);
      const m = await customer(ctx, b.m, b.t);
      const sub = b.subscription;
      need(sub?.endpoint && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth, 'Bad subscription.');
      await update(store, `subs/${m.id}`, (l) => { l = (l || []).filter((x) => x.endpoint !== sub.endpoint); l.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }); return l.slice(-5); }, { create: true });
      return json({ ok: true });
    }

    if (path === '/manifest' && method === 'GET') {
      const m = q.get('m') || '', t = q.get('t') || '';
      const start = /^CD\d+$/.test(m) && /^[\w-]{10,40}$/.test(t) ? `/card?m=${m}&t=${t}` : '/join';
      return new Response(JSON.stringify({
        name: 'Château Douma', short_name: 'Château Douma', description: 'Château Douma Loyalty Club', start_url: start, scope: '/', display: 'standalone',
        background_color: '#F6F1E7', theme_color: '#F6F1E7',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
      }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } });
    }

    // ---- wallet passes for the customer ----
    if (path === '/wallet/apple/pass' && method === 'GET') {
      const m = await customer(ctx, q.get('m'), q.get('t'));
      const cfg = appleConfig(env); need(cfg.ready, 'Apple Wallet is not set up yet.', 503);
      const buf = await buildPkpass(m, await settings(ctx), ctx.origin, cfg, ctx.now);
      return new Response(buf, { headers: { 'content-type': 'application/vnd.apple.pkpass', 'content-disposition': `attachment; filename="ChateauDouma-${m.id}.pkpass"`, 'cache-control': 'no-store' } });
    }
    if (path === '/wallet/google' && method === 'GET') {
      const m0 = await customer(ctx, q.get('m'), q.get('t'));
      const cfg = googleConfig(env); need(cfg.ready, 'Google Wallet is not set up yet.', 503);
      const r = await mutate(ctx, m0.id, (m) => { if (m.wallet.google) return { changed: false }; m.wallet.google = true; return { touch: true }; }, { quiet: true });
      return json({ url: googleSaveUrl(r.m || m0, await settings(ctx), ctx.origin, cfg, ctx.now) });
    }
    // ---- Apple Wallet web service (Apple's servers call these) ----
    if (path.startsWith('/wallet/apple/v1/')) {
      const cfg = appleConfig(env);
      if (!cfg.ready) return new Response(null, { status: 404 });
      const parts = path.slice('/wallet/apple/v1/'.length).split('/');
      const auth = (req.headers.get('authorization') || '').replace(/^ApplePass /, '');
      if (parts[0] === 'log') return new Response(null, { status: 200 });
      if (parts[0] === 'passes' && method === 'GET') {
        const m = await loadMember(ctx, parts[2]);
        if (!m || parts[1] !== cfg.passTypeId || !safeEq(m.wallet.authToken, auth)) return new Response(null, { status: 401 });
        const since = req.headers.get('if-modified-since');
        if (since && new Date(since) >= new Date(new Date(m.wallet.updatedAt).toUTCString())) return new Response(null, { status: 304 });
        const buf = await buildPkpass(m, await settings(ctx), ctx.origin, cfg, ctx.now);
        return new Response(buf, { headers: { 'content-type': 'application/vnd.apple.pkpass', 'last-modified': new Date(m.wallet.updatedAt).toUTCString() } });
      }
      if (parts[0] === 'devices' && parts[2] === 'registrations') {
        const dev = clean(parts[1], 100), ptid = parts[3], serial = parts[4];
        if (ptid !== cfg.passTypeId) return new Response(null, { status: 404 });
        if (method === 'GET') {
          const serials = (await store.getJSON(`apple-dev/${sha(dev)}`))?.data || [];
          const since = q.get('passesUpdatedSince') || '';
          const out = [];
          for (const sn of serials) { const m = await loadMember(ctx, sn); if (m && (!since || m.wallet.updatedAt > since)) out.push(sn); }
          if (!out.length) return new Response(null, { status: 204 });
          return json({ serialNumbers: out, lastUpdated: ctx.now });
        }
        const m = await loadMember(ctx, serial);
        if (!m || !safeEq(m.wallet.authToken, auth)) return new Response(null, { status: 401 });
        if (method === 'POST') {
          const b = await body(req);
          let isNew = false;
          await mutate(ctx, m.id, (x) => { x.wallet.apple = (x.wallet.apple || []).filter((d) => d.dev !== dev); x.wallet.apple.push({ dev, push: clean(b.pushToken, 200) }); isNew = true; return { touch: true }; }, { quiet: true });
          await update(store, `apple-dev/${sha(dev)}`, (l) => { l = l || []; if (!l.includes(m.id)) l.push(m.id); return l; }, { create: true });
          return new Response(null, { status: isNew ? 201 : 200 });
        }
        if (method === 'DELETE') {
          await mutate(ctx, m.id, (x) => { x.wallet.apple = (x.wallet.apple || []).filter((d) => d.dev !== dev); return { touch: true }; }, { quiet: true });
          await update(store, `apple-dev/${sha(dev)}`, (l) => (l || []).filter((x) => x !== m.id));
          return new Response(null, { status: 200 });
        }
      }
      return new Response(null, { status: 404 });
    }

    // ================= STAFF & OWNER =================
    if (path === '/auth/login' && method === 'POST') {
      const b = await body(req);
      const gate = await rateGate(ctx, 'pin', 8, 15);
      const pin = String(b.pin || '');
      let who = null;
      if (env.OWNER_PIN && safeEq(pin, env.OWNER_PIN)) who = { sub: 'owner', name: 'Owner', role: 'owner' };
      else if (env.STAFF_PIN && safeEq(pin, env.STAFF_PIN)) who = { sub: 'shared', name: 'Shared staff PIN', role: 'staff' };
      else { const st = (await staffList(ctx)).find((x) => x.active && checkPin(pin, x.pin)); if (st) who = { sub: st.id, name: st.name, role: 'staff' }; }
      if (!who && !env.OWNER_PIN && !env.STAFF_PIN && !(await staffList(ctx)).length) {
        return fail('No PIN is set up on the server yet. In Netlify add OWNER_PIN (numbers only), then publish again.', 503);
      }
      if (!who) { await gate.fail(); return fail('Wrong PIN.', 401); }
      if (b.need === 'owner' && who.role !== 'owner') { await gate.fail(); return fail('This needs the owner PIN.', 403); }
      const token = await signToken(ctx, who);
      await audit(ctx, { id: who.sub, name: who.name, role: who.role }, 'auth.login', null, null, null);
      const sess = await (async () => { ctx.req = new Request(req.url, { headers: { authorization: `Bearer ${token}` } }); return session(ctx); })();
      return json({ token, ...sess });
    }

    if (path.startsWith('/staff/') || path.startsWith('/owner/') || path === '/auth/me') {
      const isOwnerPath = path.startsWith('/owner/');
      const by = await session(ctx, isOwnerPath ? 'owner' : null);
      const s = await settings(ctx);
      if (path === '/auth/me') return json(by);
      const b = method === 'POST' ? await body(req) : {};

      if (path === '/staff/find' && method === 'GET') {
        const ids = await findMembers(ctx, q.get('q'));
        const list = [];
        for (const id of ids) { const m = await loadMember(ctx, id); if (m) list.push(m); }
        need(list.length, 'No member found.', 404);
        if (list.length === 1) return json({ member: sv(list[0], s, ctx.now, by), settings: publicSettings(s, env), campaigns: activeCampaignsFor(await campaigns(ctx), list[0], ctx.now) });
        return json({ matches: list.map((m) => ({ id: m.id, name: m.name, tier: m.tier, phone: by.role === 'owner' ? m.phone : '…' + m.phone.slice(-3) })) });
      }
      if (path === '/staff/member' && method === 'GET') {
        const m = await loadMember(ctx, q.get('id')); need(m, 'Member not found.', 404);
        const r = await mutate(ctx, m.id, () => ({}), {});
        return json({ member: sv(r.m || m, s, ctx.now, by), settings: publicSettings(s, env), campaigns: activeCampaignsFor(await campaigns(ctx), m, ctx.now) });
      }
      if (path === '/staff/quote' && method === 'POST') {
        const m = await loadMember(ctx, b.memberId); need(m, 'Member not found.', 404);
        if (!by.perms.redeem) need(!toCents(b.redeem), 'You are not allowed to redeem cashback.', 403);
        const draft = structuredClone(m); E.applyExpiry(draft, s, ctx.now);
        const qd = E.quote(draft, s, await campaigns(ctx), { invoiceCents: toCents(b.invoice), nonEligibleCents: toCents(b.nonEligible), category: b.category, redeemCents: toCents(b.redeem) }, ctx.now);
        return json({ quote: qd });
      }
      if (path === '/staff/purchase' && method === 'POST') {
        need(by.perms.purchase, 'You are not allowed to record purchases.', 403);
        if (!by.perms.redeem) need(!toCents(b.redeem), 'You are not allowed to redeem cashback.', 403);
        const txKey = clean(b.txKey, 60); need(txKey.length >= 8, 'Missing transaction key. Please refresh.');
        // the receipt reference is optional; without one, the confirmation key keeps the purchase from being saved twice
        const ref = normRef(b.invoiceRef) || `P-${txKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase()}`;
        const m0 = await loadMember(ctx, b.memberId); need(m0, 'Member not found.', 404);
        // idempotency: the same confirmation sent twice returns the first result
        const dup = m0.ledger.find((x) => x.txKey === txKey);
        if (dup) return json({ entry: E.publicTx(dup), member: sv(m0, s, ctx.now, by), duplicate: true });
        const claim = await store.setJSON(`invoices/${ref}`, { id: m0.id, at: ctx.now, txKey }, { onlyIfNew: true });
        if (!claim.modified) {
          const c = (await store.getJSON(`invoices/${ref}`))?.data;
          need(c?.txKey === txKey, `Invoice ${ref} was already recorded${c?.id ? ` (member #${c.id})` : ''}. Duplicate blocked.`, 409);
        }
        try {
          const camps = await campaigns(ctx);
          const r = await mutate(ctx, m0.id, (m) => {
            return E.purchase(m, s, camps, {
              invoiceCents: toCents(b.invoice), nonEligibleCents: toCents(b.nonEligible), category: b.category, redeemCents: toCents(b.redeem),
              invoiceRef: ref, notes: clean(b.notes, 300), txKey, glasses: b.glasses | 0, bottles: b.bottles | 0,
            }, ctx.now, by);
          }, { by, action: 'purchase.record', details: { invoice: ref } });
          await update(store, `invoices/${ref}`, (c) => ({ ...c, tx: r.result.entry.id }));
          return json({ entry: E.publicTx(r.result.entry), member: sv(r.m, s, ctx.now, by), tierChanged: r.result.tierChanged || null });
        } catch (e) {
          await store.del(`invoices/${ref}`).catch(() => {});
          throw e;
        }
      }
      if (path === '/staff/stamp-redeem' && method === 'POST') {
        const r = await mutate(ctx, b.memberId, (m) => E.stampRedeem(m, s, b.kind, ctx.now, by), { by, action: 'stamp.redeem', details: { kind: b.kind } });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/staff/verify/start' && method === 'POST') {
        const code = String(crypto.randomInt(100000, 1000000));
        const r = await mutate(ctx, b.memberId, (m) => { m.verifyCode = { kind: 'phone', hash: sha(code + m.id), exp: addDays(ctx.now, 1 / 96) }; return { touch: true }; }, { quiet: true });
        const text = `Château Douma: your verification code is ${code}`;
        return json({ whatsapp: `https://wa.me/${r.m.phone}?text=${encodeURIComponent(text)}`, sms: `sms:+${r.m.phone}?&body=${encodeURIComponent(text)}` });
      }
      if (path === '/staff/card-link' && method === 'POST') {
        // re-send a lost card to the member's own WhatsApp number
        const m = await loadMember(ctx, b.memberId); need(m, 'Member not found.', 404);
        await audit(ctx, by, 'member.card-link', m.id, null, null);
        const text = `Hi ${m.name.split(' ')[0]}, here is your Château Douma loyalty card: ${ctx.origin}/card?m=${m.id}&t=${m.token}`;
        return json({ whatsapp: `https://wa.me/${m.phone}?text=${encodeURIComponent(text)}` });
      }
      if (path === '/staff/verify/confirm' && method === 'POST') {
        const r = await mutate(ctx, b.memberId, (m) => {
          need(m.verifyCode?.kind === 'phone' && m.verifyCode.exp > ctx.now && safeEq(m.verifyCode.hash, sha(String(b.code || '').trim() + m.id)), 'That code is not right or has expired.');
          m.verifyCode = null;
          return { ...E.verify(m, s, 'phone', ctx.now), touch: true };
        }, { by, action: 'member.verify.phone' });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/staff/refund' && method === 'POST') {
        need(by.perms.refund, 'Only the owner (or staff allowed to refund) can refund.', 403);
        const reason = clean(b.reason, 300);
        const r = await mutate(ctx, b.memberId, (m) => E.refund(m, s, b.txId, b.amount === '' || b.amount == null ? null : toCents(b.amount), reason, ctx.now, by), { by, action: 'purchase.refund', reason, details: { tx: b.txId, amount: b.amount } });
        return json({ entry: E.publicTx(r.result.entry), cashRefund: r.result.entry.cashRefund, shortfall: r.result.entry.shortfall, member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/staff/today' && method === 'GET') {
        const start = localToISO(dayKey(new Date(ctx.now), s.timezone) + 'T00:00', s.timezone);
        const evs = await eventsBetween(ctx, start, addDays(start, 1));
        const p = evs.filter((e) => e.type === 'purchase');
        return json({ purchases: p.length, sales: p.reduce((a, e) => a + (e.paid || 0), 0), earned: p.reduce((a, e) => a + (e.earned || 0), 0), redeemed: p.reduce((a, e) => a + (e.red || 0), 0), joins: evs.filter((e) => e.type === 'welcome').length });
      }

      // ---------------- owner only ----------------
      const reason = clean(b.reason, 300);
      if (path === '/owner/adjust' && method === 'POST') {
        const r = await mutate(ctx, b.memberId, (m) => E.adjust(m, s, toCents(b.amount), b.kind === 'complimentary' ? 'complimentary' : 'adjust', reason, ctx.now, by), { by, action: `wallet.${b.kind === 'complimentary' ? 'complimentary' : 'adjust'}`, reason, details: { amount: b.amount } });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/owner/reverse' && method === 'POST') {
        const r = await mutate(ctx, b.memberId, (m) => E.reverseCredit(m, s, b.txId, reason, ctx.now, by), { by, action: 'tx.reverse', reason, details: { tx: b.txId } });
        return json({ member: sv(r.m, s, ctx.now, by), entry: E.publicTx(r.result.entry) });
      }
      if (path === '/owner/tier' && method === 'POST') {
        const r = await mutate(ctx, b.memberId, (m) => { const o = E.setTier(m, s, b.tier, !!b.lock, reason, ctx.now, by); return { ...o, touch: true }; }, { by, action: 'member.tier', reason, details: { tier: b.tier, lock: !!b.lock } });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/owner/status' && method === 'POST') {
        need(reason, 'A reason is required.'); need(['active', 'suspended'].includes(b.status), 'Bad status.');
        const r = await mutate(ctx, b.memberId, (m) => { m.status = b.status; return { touch: true }; }, { by, action: `member.${b.status === 'active' ? 'reactivate' : 'suspend'}`, reason });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/owner/note' && method === 'POST') {
        const text = clean(b.text, 1000); need(text, 'Write a note.');
        const r = await mutate(ctx, b.memberId, (m) => { m.notes.push({ at: ctx.now, by: by.name, text }); return { touch: true }; }, { by, action: 'member.note', quiet: true });
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/owner/edit' && method === 'POST') {
        need(reason, 'A reason is required.');
        const m0 = await loadMember(ctx, b.memberId); need(m0, 'Member not found.', 404);
        const name = b.name !== undefined ? clean(b.name, 60) : m0.name;
        need(name.length >= 2, 'Name is too short.');
        let phone = m0.phone, email = m0.email;
        if (b.phone !== undefined && normPhone(b.phone) !== m0.phone) {
          phone = normPhone(b.phone); need(phone.length >= 8, 'Invalid phone.');
          const c = await store.setJSON(`phones/${phone}`, { id: m0.id }, { onlyIfNew: true }); need(c.modified, 'That phone number belongs to another member.', 409);
        }
        if (b.email !== undefined && (normEmail(b.email) || '') !== m0.email) {
          email = b.email ? normEmail(b.email) : ''; need(!b.email || email, 'Invalid email.');
          if (email) { const c = await store.setJSON(`emails/${sha(email)}`, { id: m0.id }, { onlyIfNew: true }); need(c.modified, 'That email belongs to another member.', 409); }
        }
        const r = await mutate(ctx, m0.id, (m) => {
          m.name = name;
          if (phone !== m.phone) { m.phone = phone; m.verified.phone = false; }
          if (email !== m.email) { m.email = email; m.verified.email = false; }
          if (b.dob !== undefined && b.dob !== m.dob) { need(!b.dob || /^\d{4}-\d{2}-\d{2}$/.test(b.dob), 'Invalid date of birth.'); m.dob = b.dob || ''; m.dobSetAt = ctx.now; }
          return { touch: true };
        }, { by, action: 'member.edit', reason, details: { name, phone, email, dob: b.dob } });
        if (phone !== m0.phone) await store.del(`phones/${m0.phone}`).catch(() => {});
        if (email !== m0.email && m0.email) await store.del(`emails/${sha(m0.email)}`).catch(() => {});
        return json({ member: sv(r.m, s, ctx.now, by) });
      }
      if (path === '/owner/customers' && method === 'GET') {
        const ix = (await store.getJSON('index/members'))?.data || {};
        return json({ customers: Object.values(ix).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })), settings: publicSettings(s, env) });
      }
      if (path === '/owner/transactions' && method === 'GET') {
        const from = q.get('from') || addDays(ctx.now, -30), to = q.get('to') || addDays(ctx.now, 1);
        const ix = (await store.getJSON('index/members'))?.data || {};
        const evs = (await eventsBetween(ctx, from, to)).reverse().map((e) => ({ ...e, name: ix[e.m]?.name || '' }));
        return json({ events: evs.slice(0, 2000), total: evs.length });
      }
      if (path === '/owner/analytics' && method === 'GET') {
        return json(await analytics(ctx, q.get('from') || addDays(ctx.now, -30), q.get('to') || addDays(ctx.now, 1)));
      }
      if (path === '/owner/audit' && method === 'GET') {
        const from = q.get('from') || addDays(ctx.now, -30), to = q.get('to') || addDays(ctx.now, 1);
        const out = []; const d = new Date(from.slice(0, 7) + '-01T00:00:00Z');
        for (let i = 0; i < 24 && d <= new Date(to); i++) { out.push(...((await store.getJSON(`audit/${d.toISOString().slice(0, 7)}`))?.data || [])); d.setUTCMonth(d.getUTCMonth() + 1); }
        return json({ audit: out.filter((a) => a.at >= from && a.at < to).reverse().slice(0, 2000) });
      }
      if (path === '/owner/settings' && method === 'GET') return json({ settings: s, campaignsCount: (await campaigns(ctx)).length, wallet: publicSettings(s, env).wallet });
      if (path === '/owner/settings' && method === 'POST') {
        const next = validateSettings(b.settings, s);
        await update(store, 'config/settings', () => next, { create: true });
        await audit(ctx, by, 'settings.update', null, diff(s, next), reason || null);
        return json({ settings: next });
      }
      if (path === '/owner/campaigns' && method === 'GET') return json({ campaigns: (await campaigns(ctx)).map((c) => ({ ...c, startLocal: isoToLocal(c.startAt, s.timezone), endLocal: isoToLocal(c.endAt, s.timezone), active: E.campaignActive(c, ctx.now) })), settings: publicSettings(s, env) });
      if (path === '/owner/campaigns' && method === 'POST') {
        const c = validateCampaign(b.campaign, s);
        let saved;
        await update(store, 'config/campaigns', (l) => { l = l || []; const i = l.findIndex((x) => x.id === c.id); if (i >= 0) l[i] = { ...l[i], ...c, updatedAt: ctx.now }; else l.push({ ...c, createdAt: ctx.now }); saved = l; return l; }, { create: true });
        await audit(ctx, by, 'campaign.save', null, c, null);
        return json({ ok: true, campaigns: saved.length });
      }
      if (path === '/owner/campaigns/announce' && method === 'POST') {
        const c = (await campaigns(ctx)).find((x) => x.id === b.id); need(c, 'Campaign not found.', 404);
        const r = await broadcast(ctx, by, clean(b.title, 80) || c.name, clean(b.body, 500) || c.description || c.name, c.tiers);
        return json(r);
      }
      if (path === '/owner/staff' && method === 'GET') return json({ staff: (await staffList(ctx)).map(({ pin, ...x }) => x), shared: !!env.STAFF_PIN });
      if (path === '/owner/staff' && method === 'POST') {
        const list = await staffList(ctx);
        const allPins = (p) => (env.OWNER_PIN && safeEq(p, env.OWNER_PIN)) || (env.STAFF_PIN && safeEq(p, env.STAFF_PIN)) || list.some((x) => x.id !== b.id && checkPin(p, x.pin));
        let saved;
        if (b.pin) { need(/^\d{4,10}$/.test(String(b.pin)), 'PIN must be 4–10 digits.'); need(!allPins(String(b.pin)), 'That PIN is already used. Choose another.'); }
        await update(store, 'config/staff', (l) => {
          l = l || [];
          if (b.action === 'create') {
            need(clean(b.name, 40).length >= 2, 'Enter the staff member’s name.'); need(b.pin, 'Set a PIN.');
            l.push({ id: 'S' + rid(5), name: clean(b.name, 40), pin: hashPin(String(b.pin)), active: true, perms: { refund: !!b.perms?.refund, history: !!b.perms?.history, redeem: b.perms?.redeem !== false, purchase: true }, createdAt: ctx.now });
          } else {
            const x = l.find((y) => y.id === b.id); need(x, 'Staff not found.', 404);
            if (b.name) x.name = clean(b.name, 40);
            if (typeof b.active === 'boolean') x.active = b.active;
            if (b.perms) x.perms = { ...x.perms, refund: !!b.perms.refund, history: !!b.perms.history, redeem: b.perms.redeem !== false };
            if (b.pin) x.pin = hashPin(String(b.pin));
          }
          saved = l; return l;
        }, { create: true });
        await audit(ctx, by, `staff.${b.action === 'create' ? 'create' : 'update'}`, null, { name: b.name, id: b.id, active: b.active, perms: b.perms, pinChanged: !!b.pin }, null);
        return json({ staff: saved.map(({ pin, ...x }) => x) });
      }
      if (path === '/owner/notify' && method === 'POST') {
        const title = clean(b.title, 80), text = clean(b.body, 500);
        need(title && text, 'Please write a title and a message.');
        if (b.to === 'all') return json(await broadcast(ctx, by, title, text, null));
        const r = await mutate(ctx, b.to, (m) => ({ notes: [{ type: 'message', essential: true, title, body: text }], events: [] }), { by, action: 'message.send', details: { title } });
        return json({ ok: true, recipients: 1, member: r.m.id });
      }
      if (path === '/owner/messages' && method === 'GET') {
        const log = (await store.getJSON('messages/log'))?.data || [];
        return json({ sent: [...log].reverse().slice(0, 50) });
      }
      if (path === '/owner/rebuild' && method === 'POST') return json(await rebuild(ctx, by));
      if (path === '/owner/run-daily' && method === 'POST') { const r = await runDaily(store, env); await audit(ctx, by, 'system.daily', null, r, null); return json(r); }
      if (path === '/owner/export' && method === 'GET') return exportCsv(ctx, q, s);
    }
    return fail('Not found.', 404);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    if (e instanceof Busy) return fail(e.message, 503);
    if (e && e.constructor === Error && e.message) return fail(e.message, 400); // business-rule errors from the engine
    console.error(e);
    return fail('Something went wrong. Nothing was changed.', 500);
  }
}

async function broadcast(ctx, by, title, text, tiers) {
  const msg = { id: rid(8), at: ctx.now, title, body: text, marketing: true, tiers: tiers?.length ? tiers : null };
  await update(ctx.store, 'messages/all', (l) => [...(l || []), msg].slice(-100), { create: true });
  const ix = Object.values((await ctx.store.getJSON('index/members'))?.data || {});
  const targets = [];
  for (const x of ix) {
    if (x.status !== 'active' || (msg.tiers && !msg.tiers.includes(x.tier))) continue;
    const m = (await ctx.store.getJSON(`members/${x.id}`))?.data;
    if (m?.prefs?.marketing) targets.push(x.id);
  }
  const pushed = await pushTo(ctx, targets, { title, body: text });
  await update(ctx.store, 'messages/log', (l) => [...(l || []), { ...msg, to: tiers?.length ? `Members (${tiers.join(', ')})` : 'All members', recipients: targets.length, pushed }].slice(-200), { create: true });
  await audit(ctx, by, 'message.broadcast', null, { title, recipients: targets.length }, null);
  return { ok: true, recipients: targets.length, pushed };
}

async function rebuild(ctx, by) {
  const s = await settings(ctx);
  const keys = await ctx.store.list('members/');
  const ix = {}; const months = {};
  for (const k of keys) {
    const id = k.slice('members/'.length);
    const r = await mutate(ctx, id, () => ({}), { quiet: true });
    const m = r.m || (await ctx.store.getJSON(k)).data;
    ix[m.id] = E.summary(m, s, ctx.now);
    for (const e of m.ledger) (months[monthKey(new Date(e.at))] ||= []).push(ev(e, m.id));
  }
  await ctx.store.setJSON('index/members', ix);
  for (const [mk, l] of Object.entries(months)) await ctx.store.setJSON(`events/${mk}`, l.sort((a, b) => a.at.localeCompare(b.at)));
  await audit(ctx, by, 'system.rebuild', null, { members: keys.length }, null);
  return { members: keys.length, months: Object.keys(months).length };
}

function diff(a, b) { const out = {}; for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k]; return out; }

function validateSettings(inp, cur) {
  need(inp && typeof inp === 'object', 'Missing settings.');
  const s = E.mergeSettings({ ...cur, ...inp });
  need(Array.isArray(s.tiers) && s.tiers.length === 3, 'There must be three membership levels.');
  s.tiers = s.tiers.map((t, i) => ({ key: cur.tiers[i].key, name: clean(t.name, 40).toUpperCase() || cur.tiers[i].name, rate: Number(t.rate), min: i === 0 ? 0 : Math.round(Number(t.min)) }));
  for (const t of s.tiers) need(t.rate >= 0 && t.rate <= 50, 'Cashback rates must be between 0% and 50%.');
  need(s.tiers[1].min > 0 && s.tiers[2].min > s.tiers[1].min, 'Spending thresholds must go up from level to level.');
  s.welcome = { enabled: !!s.welcome.enabled, amount: Math.max(0, Math.min(100000, Math.round(s.welcome.amount))) };
  s.birthday = { enabled: !!s.birthday.enabled, amount: Math.max(0, Math.min(100000, Math.round(s.birthday.amount))), validDays: Math.max(1, Math.min(365, Math.round(s.birthday.validDays))) };
  s.expiry = { months: Math.max(1, Math.min(60, Math.round(s.expiry.months))), warnDays: Math.max(1, Math.min(120, Math.round(s.expiry.warnDays))) };
  s.categories = (s.categories || []).map((c) => ({ name: clean(c.name, 40), eligible: !!c.eligible })).filter((c) => c.name);
  need(s.categories.length, 'Add at least one purchase category.');
  s.excludedProducts = clean(s.excludedProducts, 1000);
  s.redemption = { minCents: Math.max(0, Math.round(s.redemption.minCents || 0)), maxPercentOfInvoice: Math.max(0, Math.min(100, Number(s.redemption.maxPercentOfInvoice))), allowOnExcluded: !!s.redemption.allowOnExcluded };
  s.campaigns = { allowStacking: !!s.campaigns.allowStacking };
  s.stamps = { enabled: !!s.stamps.enabled, goal: Math.max(2, Math.min(20, Math.round(s.stamps.goal))) };
  for (const k of Object.keys(E.DEFAULT_SETTINGS.notifications)) s.notifications[k] = !!s.notifications[k];
  s.currency = { code: clean(s.currency.code, 3).toUpperCase() || 'USD', symbol: clean(s.currency.symbol, 3) || '$' };
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch (_) { throw new HttpError('Unknown time zone.'); }
  s.approachingWithinCents = Math.max(0, Math.round(s.approachingWithinCents));
  s.inactiveDays = Math.max(7, Math.min(365, Math.round(s.inactiveDays)));
  s.terms = clean(s.terms, 6000);
  return s;
}
function validateCampaign(c, s) {
  need(c && typeof c === 'object', 'Missing campaign.');
  const out = {
    id: c.id && /^C[\w-]+$/.test(c.id) ? c.id : 'C' + rid(6), name: clean(c.name, 60), description: clean(c.description, 300),
    startAt: localToISO(c.startLocal, s.timezone), endAt: localToISO(c.endLocal, s.timezone),
    type: c.type === 'fixed' ? 'fixed' : 'multiplier', value: Number(c.value),
    tiers: (c.tiers || []).filter((k) => s.tiers.some((t) => t.key === k)),
    categories: (c.categories || []).filter((n) => s.categories.some((x) => x.name === n)),
    maxPerTxCents: toCents(c.maxPerTx), maxPerCustomerCents: toCents(c.maxPerCustomer),
    enabled: !!c.enabled, stackable: !!c.stackable,
  };
  need(out.name.length >= 2, 'Give the campaign a name.');
  need(out.endAt > out.startAt, 'The end must be after the start.');
  need(out.type === 'multiplier' ? out.value > 1 && out.value <= 10 : out.value > 0 && out.value <= 50, out.type === 'multiplier' ? 'Multiplier must be between 1.1 and 10.' : 'Fixed cashback must be between 0.1% and 50%.');
  return out;
}

async function exportCsv(ctx, q, s) {
  const type = q.get('type');
  const from = q.get('from') || addDays(ctx.now, -30), to = q.get('to') || addDays(ctx.now, 1);
  const tname = (k) => E.tierByKey(s, k).name;
  const d = (iso) => (iso ? isoToLocal(iso, s.timezone).replace('T', ' ') : '');
  if (type === 'customers') {
    const ix = Object.values((await ctx.store.getJSON('index/members'))?.data || {});
    return csvResp(`douma-customers-${dayKey()}.csv`, [['Member no', 'Name', 'Phone', 'Email', 'Membership', 'Status', 'Available cashback', 'Locked welcome', 'Lifetime eligible spending', 'Lifetime earned', 'Lifetime redeemed', 'Visits', 'Last visit', 'Joined', 'Verified'],
      ...ix.map((x) => [x.id, x.name, '+' + x.phone, x.email, tname(x.tier), x.status, money(x.available), money(x.locked), money(x.spend), money(x.earned), money(x.redeemed), x.visits, d(x.lastVisit), d(x.joinedAt), x.verified ? 'yes' : 'no'])]);
  }
  if (type === 'transactions') {
    const ix = (await ctx.store.getJSON('index/members'))?.data || {};
    const evs = await eventsBetween(ctx, from, to);
    return csvResp(`douma-transactions-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv`, [['Date', 'Transaction', 'Member no', 'Name', 'Type', 'Category', 'Invoice ref', 'Invoice', 'Paid', 'Eligible spend', 'Cashback earned', 'Cashback redeemed', 'Reward', 'Expired', 'Adjustment', 'Refund', 'Cashback restored', 'Cashback reversed', 'Cash refund', 'By'],
      ...evs.map((e) => [d(e.at), e.tx, e.m, ix[e.m]?.name || '', e.type, e.cat || '', e.ref || '', money(e.inv), money(e.paid), money(e.base), money(e.earned), money(e.red), money(e.rew), money(e.exp), money(e.adj), money(e.refund), money(e.rest), money(e.er), money(e.cash), e.by || ''])]);
  }
  if (type === 'member') {
    const m = await loadMember(ctx, q.get('id')); need(m, 'Member not found.', 404);
    return csvResp(`douma-${m.id}-history.csv`, [['Date', 'Transaction', 'Type', 'Description', 'Category', 'Invoice ref', 'Invoice', 'Paid', 'Cashback earned', 'Cashback redeemed', 'Reward', 'Expired', 'Adjustment', 'Refund', 'Balance after', 'By', 'Reason / notes'],
      ...m.ledger.map((e) => [d(e.at), e.id, e.type, e.label || '', e.category || '', e.invoiceRef || '', money(e.invoice), money(e.paid), money(e.earned), money(e.redeemed), money(e.reward), money(e.expired), money(e.adjust), money(e.refund), money(e.balance), e.by?.name || '', e.reason || e.notes || ''])]);
  }
  if (type === 'analytics') {
    const a = await analytics(ctx, from, to);
    const rows = [['Report', `${d(from)} to ${d(to)}`], [], ['Metric', 'Value'],
      ['Total members', a.members.total], ...s.tiers.map((t) => [t.name, a.members[t.key]]), ['New registrations in period', a.members.newInRange], ['New this month', a.members.newThisMonth],
      ['Eligible member sales', money(a.sales)], ['Amount paid by members', money(a.paidSales)], ['Purchases', a.purchases], ['Cashback issued', money(a.issued)], ['Cashback redeemed', money(a.redeemed)], ['Cashback expired', money(a.expired)],
      ['Outstanding balances', money(a.outstanding)], ['Welcome rewards issued', `${a.welcome.count} (${money(a.welcome.cents)})`], ['Birthday rewards issued', `${a.birthday.count} (${money(a.birthday.cents)})`],
      ['Effective cashback cost % of sales', a.costPercent], ['Average spending per customer', money(a.avgSpend)], ['Average visits per customer', a.avgVisits], ['Return rate %', a.returnRate],
      [], ['Top spenders'], ...a.topSpenders.map((x) => [x.id, x.name, money(x.spend)]), [], ['Most frequent'], ...a.mostFrequent.map((x) => [x.id, x.name, x.visits])];
    return csvResp(`douma-report-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv`, rows);
  }
  if (type === 'audit') {
    const out = []; const dd = new Date(from.slice(0, 7) + '-01T00:00:00Z');
    for (let i = 0; i < 24 && dd <= new Date(to); i++) { out.push(...((await ctx.store.getJSON(`audit/${dd.toISOString().slice(0, 7)}`))?.data || [])); dd.setUTCMonth(dd.getUTCMonth() + 1); }
    return csvResp('douma-audit.csv', [['Date', 'By', 'Role', 'Action', 'Member', 'Reason', 'Details'], ...out.filter((a) => a.at >= from && a.at < to).map((a) => [d(a.at), a.by?.name, a.by?.role, a.action, a.member, a.reason, JSON.stringify(a.details || '')])]);
  }
  return fail('Unknown export.', 400);
}
