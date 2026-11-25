// Cashback engine: pure functions over one member record.
// All money is integer cents. Every change is written to the member's ledger, so the
// wallet balance is always the sum of open "lots" (each credit with its own expiry date).
import { pct, fmt, rid, txid, addMonths, addDays, dayKey, zoneParts } from './util.mjs';

export const SCHEMA = 2;

export const DEFAULT_SETTINGS = {
  version: 1,
  currency: { code: 'USD', symbol: '$' },
  timezone: 'Asia/Beirut',
  tiers: [
    { key: 'classic', name: 'CLASSIC MEMBER', rate: 5, min: 0 },
    { key: 'semi', name: 'SEMI-PREMIUM MEMBER', rate: 7.5, min: 25000 },
    { key: 'premium', name: 'PREMIUM MEMBER', rate: 10, min: 100000 },
  ],
  welcome: { enabled: true, amount: 200 },
  birthday: { enabled: true, amount: 500, validDays: 30 },
  expiry: { months: 12, warnDays: 30 },
  categories: [
    { name: 'Wine bottles', eligible: true },
    { name: 'Wine by the glass', eligible: true },
    { name: 'Wine tasting', eligible: true },
    { name: 'Workshop', eligible: true },
    { name: 'Event', eligible: true },
    { name: 'Gift card', eligible: false },
    { name: 'Promotional item', eligible: false },
  ],
  excludedProducts: 'Gift cards, selected promotional items and special events marked as excluded.',
  redemption: { minCents: 0, maxPercentOfInvoice: 100, allowOnExcluded: false },
  campaigns: { allowStacking: false },
  stamps: { enabled: true, goal: 5 },
  notifications: { earned: true, redeemed: true, upgrade: true, welcome: true, birthday: true, expiry: true, reversal: true },
  approachingWithinCents: 5000,
  inactiveDays: 60,
  terms: '',
};

export function mergeSettings(saved) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!saved) return s;
  for (const k of Object.keys(s)) {
    if (saved[k] === undefined) continue;
    if (Array.isArray(s[k])) s[k] = saved[k];
    else if (s[k] && typeof s[k] === 'object') s[k] = { ...s[k], ...saved[k] };
    else s[k] = saved[k];
  }
  return s;
}

export const tierByKey = (s, key) => s.tiers.find((t) => t.key === key) || s.tiers[0];
export const tierIndex = (s, key) => Math.max(0, s.tiers.findIndex((t) => t.key === key));
export function tierForSpend(s, spend) {
  let t = s.tiers[0];
  for (const x of s.tiers) if (spend >= x.min) t = x;
  return t.key;
}
export function nextTier(s, m) {
  const i = tierIndex(s, m.tier);
  const nx = s.tiers[i + 1];
  if (!nx) return null;
  const cur = s.tiers[i];
  const span = Math.max(1, nx.min - cur.min);
  const remaining = Math.max(0, nx.min - m.spend);
  return { key: nx.key, name: nx.name, rate: nx.rate, min: nx.min, remaining, progress: Math.min(1, Math.max(0, (m.spend - cur.min) / span)) };
}

// ---------- member creation & migration ----------
export function newMember({ id, name, phone, email, dob, marketing }, s, now) {
  const m = {
    schema: SCHEMA, id, token: rid(16), qr: rid(12), name, phone, email: email || '', dob: dob || '',
    dobSetAt: dob ? now : null, joinedAt: now, status: 'active',
    verified: { phone: false, email: false, at: null },
    tier: s.tiers[0].key, tierLocked: false, spend: 0, visits: 0, lastVisit: null, firstPaidAt: null,
    lots: [], ledger: [], inbox: [], notes: [],
    totals: { earned: 0, redeemed: 0, expired: 0, welcome: 0, birthday: 0, complimentary: 0, adjustments: 0, refundsReversed: 0 },
    stamps: { glasses: 0, bottles: 0, glassRewards: 0, bottleRewards: 0, lifetimeGlasses: 0, lifetimeBottles: 0, freeGlasses: 0, freeBottles: 0 },
    campaignEarned: {}, birthdayYears: [], prefs: { marketing: !!marketing },
    wallet: { authToken: rid(18), apple: [], google: false, updatedAt: now },
  };
  const out = { notes: [], events: [] };
  if (s.welcome.enabled && s.welcome.amount > 0) {
    // usable straight away (no verification or purchase needed)
    m.lots.push({ id: rid(6), kind: 'welcome', cents: s.welcome.amount, orig: s.welcome.amount, issuedAt: now, expiresAt: addMonths(now, s.expiry.months) });
    m.totals.welcome += s.welcome.amount;
    const e = entry(m, now, { type: 'welcome', label: 'Welcome reward', reward: s.welcome.amount }, sysBy);
    out.events.push(e);
    if (s.notifications.welcome) out.notes.push(note('welcome', true, `Welcome to the club, ${name.split(' ')[0]}!`, `A ${fmt(s.welcome.amount)} welcome reward is already in your wallet. Use it on any visit.`));
  }
  return { m, ...out };
}

// Upgrade records created by the first version (stamps only) without losing anything.
export function migrate(m, s, now = new Date().toISOString()) {
  if (m.schema >= SCHEMA) return false;
  const old = structuredClone(m);
  Object.assign(m, {
    schema: SCHEMA, qr: m.qr || rid(12), email: m.email || '', dob: m.dob || '', dobSetAt: m.dob ? (m.joinedAt || now) : null,
    status: 'active', verified: { phone: false, email: false, at: null }, tier: s.tiers[0].key, tierLocked: false,
    spend: 0, visits: 0, firstPaidAt: null, lots: [], ledger: [], inbox: m.inbox || [], notes: [],
    totals: { earned: 0, redeemed: 0, expired: 0, welcome: 0, birthday: 0, complimentary: 0, adjustments: 0, refundsReversed: 0 },
    stamps: {
      glasses: old.glasses || 0, bottles: old.bottles || 0, glassRewards: 0, bottleRewards: 0,
      lifetimeGlasses: old.lifetime?.glasses || 0, lifetimeBottles: old.lifetime?.bottles || 0,
      freeGlasses: old.lifetime?.freeGlasses || 0, freeBottles: old.lifetime?.freeBottles || 0,
    },
    campaignEarned: {}, birthdayYears: [], prefs: { marketing: true },
    wallet: { authToken: rid(18), apple: [], google: false, updatedAt: now },
  });
  for (const k of ['glasses', 'bottles', 'lifetime', 'history']) delete m[k];
  // stamps that had already reached the goal become a banked free drink
  const g = s.stamps.goal || 5;
  if (m.stamps.glasses >= g) { m.stamps.glassRewards += 1; m.stamps.glasses -= g; }
  if (m.stamps.bottles >= g) { m.stamps.bottleRewards += 1; m.stamps.bottles -= g; }
  return true;
}

// ---------- wallet maths ----------
const sysBy = { id: 'system', name: 'System', role: 'system' };
const live = (l, now) => l.cents > 0 && !l.locked && (!l.expiresAt || l.expiresAt > now);
export function balance(m, now) {
  let available = 0, locked = 0;
  for (const l of m.lots) {
    if (l.cents <= 0) continue;
    if (l.locked) locked += l.cents;
    else if (!l.expiresAt || l.expiresAt > now) available += l.cents;
  }
  const soon = m.lots.filter((l) => live(l, now) && l.expiresAt).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  return { available, locked, nextExpiry: soon[0] ? { cents: soon[0].cents, at: soon[0].expiresAt } : null, lots: soon.map((l) => ({ kind: l.kind, cents: l.cents, expiresAt: l.expiresAt })) };
}

function entry(m, now, fields, by) {
  const e = { id: txid(), at: now, by: { id: by.id, name: by.name, role: by.role }, ...fields };
  e.balance = balance(m, now).available;
  e.spendAfter = m.spend;
  m.ledger.push(e);
  return e;
}
const note = (type, essential, title, body, extra = {}) => ({ type, essential, title, body, ...extra });

// Take `cents` from lots, earliest expiry first. Optionally take from a preferred lot first.
function take(m, cents, now, preferLotId) {
  const used = [];
  let left = cents;
  const order = m.lots.filter((l) => live(l, now)).sort((a, b) => {
    if (a.id === preferLotId) return -1; if (b.id === preferLotId) return 1;
    return (a.expiresAt || '9999').localeCompare(b.expiresAt || '9999');
  });
  for (const l of order) {
    if (left <= 0) break;
    const t = Math.min(l.cents, left);
    l.cents -= t; left -= t;
    used.push({ lot: l.id, kind: l.kind, cents: t, expiresAt: l.expiresAt, srcTx: l.srcTx || null });
  }
  return { used, shortfall: left };
}

// ---------- expiry, birthday ----------
export function applyExpiry(m, s, now) {
  const out = { changed: false, notes: [], events: [] };
  for (const l of m.lots) {
    if (l.kind === 'welcome' && l.locked) { l.locked = false; l.expiresAt = addMonths(now, s.expiry.months); out.changed = true; out.events.push(entry(m, now, { type: 'welcome-unlock', label: 'Welcome reward now usable', reward: 0, unlocked: l.cents }, sysBy)); }
  }
  let expired = 0;
  for (const l of m.lots) {
    if (l.cents > 0 && !l.locked && l.expiresAt && l.expiresAt <= now) { expired += l.cents; l.expiredCents = (l.expiredCents || 0) + l.cents; l.cents = 0; }
  }
  if (expired > 0) {
    m.totals.expired += expired;
    out.events.push(entry(m, now, { type: 'expire', label: 'Cashback expired', expired }, sysBy));
    out.changed = true;
  }
  // warn once per lot before it expires
  const warnAt = addDays(now, s.expiry.warnDays || 30);
  const warn = m.lots.filter((l) => live(l, now) && l.expiresAt && l.expiresAt <= warnAt && !l.warned);
  if (warn.length) {
    const cents = warn.reduce((a, l) => a + l.cents, 0);
    warn.forEach((l) => { l.warned = true; });
    const first = warn.map((l) => l.expiresAt).sort()[0];
    if (s.notifications.expiry) out.notes.push(note('expiry', true, 'Cashback expiring soon', `${fmt(cents)} of your cashback expires on ${new Date(first).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: s.timezone })}. Use it on your next visit!`));
    out.changed = true;
  }
  if (m.lots.length > 60) { m.lots = m.lots.filter((l) => l.cents > 0 || l.locked || (l.issuedAt > addMonths(now, -24))); }
  return out;
}

export function maybeBirthday(m, s, now) {
  const out = { changed: false, notes: [], events: [] };
  if (!s.birthday.enabled || !(s.birthday.amount > 0) || !m.dob || m.status !== 'active') return out;
  const p = zoneParts(new Date(now), s.timezone);
  const [, bm, bd] = m.dob.split('-').map(Number);
  const isLeapSkip = bm === 2 && bd === 29 && !(p.y % 4 === 0 && (p.y % 100 !== 0 || p.y % 400 === 0));
  const today = p.mo === bm && (p.d === bd || (isLeapSkip && p.d === 28));
  if (!today || m.birthdayYears.includes(p.y)) return out;
  m.birthdayYears.push(p.y);
  m.lots.push({ id: rid(6), kind: 'birthday', cents: s.birthday.amount, orig: s.birthday.amount, issuedAt: now, expiresAt: addDays(now, s.birthday.validDays || 30) });
  m.totals.birthday += s.birthday.amount;
  out.events.push(entry(m, now, { type: 'birthday', label: 'Birthday reward', reward: s.birthday.amount }, sysBy));
  if (s.notifications.birthday) out.notes.push(note('birthday', true, `Happy birthday, ${m.name.split(' ')[0]}!`, `A ${fmt(s.birthday.amount)} birthday reward is in your wallet. It is valid for ${s.birthday.validDays} days.`));
  out.changed = true;
  return out;
}

function maybeUnlockWelcome(m, s, now, out) {
  if (!(m.verified.phone || m.verified.email) || !m.firstPaidAt) return;
  for (const l of m.lots) {
    if (l.kind === 'welcome' && l.locked) {
      l.locked = false; l.expiresAt = addMonths(now, s.expiry.months);
      out.events.push(entry(m, now, { type: 'welcome-unlock', label: 'Welcome reward unlocked', reward: 0, unlocked: l.cents }, sysBy));
      if (s.notifications.welcome) out.notes.push(note('welcome', true, 'Your welcome reward is unlocked', `${fmt(l.cents)} welcome cashback is now available to use.`));
    }
  }
}

// ---------- campaigns ----------
export function campaignActive(c, now) { return c.enabled && c.startAt <= now && now < c.endAt; }
function campaignBonuses(m, s, campaigns, category, base, baseRate, now) {
  const list = [];
  for (const c of campaigns || []) {
    if (!campaignActive(c, now)) continue;
    if (c.tiers?.length && !c.tiers.includes(m.tier)) continue;
    if (c.categories?.length && !c.categories.includes(category)) continue;
    const rate = c.type === 'fixed' ? Number(c.value) : baseRate * Number(c.value);
    let extra = Math.max(0, pct(base, rate) - pct(base, baseRate));
    if (c.maxPerTxCents > 0) extra = Math.min(extra, c.maxPerTxCents);
    if (c.maxPerCustomerCents > 0) extra = Math.min(extra, Math.max(0, c.maxPerCustomerCents - (m.campaignEarned[c.id] || 0)));
    if (extra > 0) list.push({ id: c.id, name: c.name, rate, extra, stackable: !!c.stackable });
  }
  if (!list.length) return [];
  list.sort((a, b) => b.extra - a.extra);
  if (!s.campaigns.allowStacking) return [list[0]];
  const best = list.find((x) => !x.stackable);
  return [...(best ? [best] : []), ...list.filter((x) => x.stackable)];
}

// ---------- purchase ----------
export function quote(m, s, campaigns, input, now) {
  const invoice = input.invoiceCents | 0;
  if (!(invoice > 0)) throw new Error('Enter the invoice amount.');
  if (invoice > 10000000) throw new Error('Invoice amount looks too large.');
  const cat = s.categories.find((c) => c.name === input.category);
  if (!cat) throw new Error('Choose a purchase category.');
  let nonEligible = cat.eligible ? Math.max(0, input.nonEligibleCents | 0) : invoice;
  if (nonEligible > invoice) throw new Error('Non-eligible items cannot be more than the invoice.');
  const bal = balance(m, now);
  const capPct = Math.floor((invoice * (s.redemption.maxPercentOfInvoice ?? 100)) / 100);
  const capBase = s.redemption.allowOnExcluded ? invoice : invoice - nonEligible;
  const maxRedeem = m.status === 'active' ? Math.max(0, Math.min(bal.available, capPct, capBase)) : 0;
  const redeem = Math.max(0, input.redeemCents | 0);
  if (redeem > bal.available) throw new Error(`Only ${fmt(bal.available)} is available in this wallet.`);
  if (redeem > maxRedeem) throw new Error(`The most that can be redeemed on this invoice is ${fmt(maxRedeem)}.`);
  if (redeem > 0 && redeem < (s.redemption.minCents || 0)) throw new Error(`Minimum redemption is ${fmt(s.redemption.minCents)}.`);
  const paid = invoice - redeem;
  const eligible = invoice - nonEligible;
  // cashback is only earned on the eligible part actually paid (not on the part paid with cashback)
  const base = invoice > 0 ? Math.round((eligible * paid) / invoice) : 0;
  const t = tierByKey(s, m.tier);
  const baseEarned = m.status === 'active' ? pct(base, t.rate) : 0;
  const bonuses = m.status === 'active' ? campaignBonuses(m, s, campaigns, cat.name, base, t.rate, now) : [];
  const bonus = bonuses.reduce((a, b) => a + b.extra, 0);
  const earned = baseEarned + bonus;
  const spendAfter = m.spend + base;
  const tierAfter = m.tierLocked ? m.tier : (tierIndex(s, tierForSpend(s, spendAfter)) > tierIndex(s, m.tier) ? tierForSpend(s, spendAfter) : m.tier);
  return {
    invoice, nonEligible, eligible, redeem, paid, base, maxRedeem, available: bal.available,
    tier: m.tier, tierName: t.name, rate: t.rate, baseEarned, bonuses, bonus, earned,
    effectiveRate: base > 0 ? Math.round((earned / base) * 10000) / 100 : t.rate,
    newBalance: bal.available - redeem + earned, spendAfter, tierAfter, tierAfterName: tierByKey(s, tierAfter).name,
    category: cat.name, suspended: m.status !== 'active',
  };
}

export function purchase(m, s, campaigns, input, now, by) {
  if (m.status !== 'active') throw new Error('This membership is suspended. Ask the owner to reactivate it.');
  const q = quote(m, s, campaigns, input, now);
  const out = { notes: [], events: [], q };
  const exp = applyExpiry(m, s, now); out.notes.push(...exp.notes); out.events.push(...exp.events);
  let redeemedFrom = [];
  if (q.redeem > 0) {
    const r = take(m, q.redeem, now);
    if (r.shortfall > 0) throw new Error('Balance changed, please try again.');
    redeemedFrom = r.used;
    m.totals.redeemed += q.redeem;
  }
  const earnLot = q.earned > 0 ? { id: rid(6), kind: 'earn', cents: q.earned, orig: q.earned, issuedAt: now, expiresAt: addMonths(now, s.expiry.months) } : null;
  m.spend += q.base;
  if (q.paid > 0 && !m.firstPaidAt) m.firstPaidAt = now;
  if (!m.lastVisit || dayKey(new Date(m.lastVisit), s.timezone) !== dayKey(new Date(now), s.timezone)) m.visits += 1;
  m.lastVisit = now;
  m.totals.earned += q.earned;
  for (const b of q.bonuses) m.campaignEarned[b.id] = (m.campaignEarned[b.id] || 0) + b.extra;
  if (earnLot) m.lots.push(earnLot);
  // stamps (glasses / bottles) recorded with the purchase
  const st = stampAdd(m, s, input.glasses | 0, input.bottles | 0);
  const e = entry(m, now, {
    type: 'purchase', label: q.category, category: q.category, invoiceRef: input.invoiceRef, txKey: input.txKey,
    invoice: q.invoice, nonEligible: q.nonEligible, paid: q.paid, base: q.base, rate: q.rate, effectiveRate: q.effectiveRate,
    campaigns: q.bonuses.map((b) => ({ id: b.id, name: b.name, extra: b.extra })), earned: q.earned, redeemed: q.redeem,
    redeemedFrom, earnLot: earnLot?.id || null, notes: input.notes || '', refunded: 0, stamps: st.added,
  }, by);
  if (earnLot) earnLot.srcTx = e.id;
  out.events.push(e); out.entry = e;
  if (q.earned > 0 && s.notifications.earned) out.notes.push(note('earned', true, `You earned ${fmt(q.earned)} cashback`, `Thank you for your visit! Your wallet balance is now ${fmt(e.balance)}.`));
  if (q.redeem > 0 && s.notifications.redeemed) out.notes.push(note('redeemed', true, `${fmt(q.redeem)} cashback redeemed`, `You saved ${fmt(q.redeem)} on your purchase. Remaining balance: ${fmt(e.balance)}.`));
  // automatic upgrade, applies to the next purchases (never retroactive)
  if (!m.tierLocked) {
    const want = tierForSpend(s, m.spend);
    if (tierIndex(s, want) > tierIndex(s, m.tier)) changeTier(m, s, want, now, sysBy, 'Automatic upgrade', out);
  }
  maybeUnlockWelcome(m, s, now, out);
  if (st.rewardsReached.length) out.notes.push(note('stamp', true, 'Free drink unlocked!', `You have earned ${st.rewardsReached.join(' and ')}. Show your card to our team to enjoy it.`));
  out.entry.balance = balance(m, now).available;
  return out;
}

function changeTier(m, s, key, now, by, reason, out) {
  const from = m.tier;
  m.tier = key;
  const t = tierByKey(s, key);
  const up = tierIndex(s, key) > tierIndex(s, from);
  out.events.push(entry(m, now, { type: 'tier', label: `${up ? 'Upgraded' : 'Changed'} to ${t.name}`, fromTier: from, toTier: key, reason }, by));
  if (s.notifications.upgrade) out.notes.push(note('upgrade', true, up ? `Welcome to ${t.name}` : `Your membership is now ${t.name}`, up ? `Congratulations! From your next purchase you earn ${t.rate}% cashback.` : `Your cashback rate is now ${t.rate}%.`, { tier: key }));
  out.tierChanged = { from, to: key };
}

// ---------- refunds & reversals ----------
export function refund(m, s, txId, cents, reason, now, by, { reversal = false } = {}) {
  const p = m.ledger.find((x) => x.id === txId);
  if (!p) throw new Error('Transaction not found.');
  if (p.type !== 'purchase') throw new Error('Only purchases can be refunded.');
  const remaining = p.invoice - (p.refunded || 0);
  if (remaining <= 0) throw new Error('This purchase has already been fully refunded.');
  if (!reason) throw new Error('A reason is required.');
  const amount = cents == null ? remaining : cents | 0;
  if (!(amount > 0) || amount > remaining) throw new Error(`You can refund up to ${fmt(remaining)} on this purchase.`);
  const out = { notes: [], events: [] };
  const exp = applyExpiry(m, s, now); out.notes.push(...exp.notes); out.events.push(...exp.events);
  const last = amount === remaining; // final refund settles any rounding leftovers
  const part = (total, done) => last ? total - done : Math.min(total - done, Math.round((total * amount) / p.invoice));
  p.restored = p.restored || 0; p.earnReversed = p.earnReversed || 0; p.spendReversed = p.spendReversed || 0; p.cashRefunded = p.cashRefunded || 0;
  const restore = part(p.redeemed, p.restored);
  const reverseEarn = part(p.earned, p.earnReversed);
  const reverseSpend = part(p.base, p.spendReversed);
  const cashPart = part(p.paid, p.cashRefunded);
  // 1) give back the cashback that was used on the refunded part (keeps its expiry, minimum 30 days)
  if (restore > 0) {
    const exp2 = [...(p.redeemedFrom || [])].map((u) => u.expiresAt).filter(Boolean).sort().pop();
    const keep = exp2 && exp2 > addDays(now, 30) ? exp2 : addDays(now, 30);
    m.lots.push({ id: rid(6), kind: 'restore', cents: restore, orig: restore, issuedAt: now, expiresAt: keep });
    m.totals.redeemed -= restore;
  }
  // 2) take back the cashback earned on the refunded part; if already spent, it is deducted from the cash refund
  let shortfall = 0;
  if (reverseEarn > 0) {
    const r = take(m, reverseEarn, now, p.earnLot);
    shortfall = r.shortfall;
    m.totals.earned -= reverseEarn;
    m.totals.refundsReversed += reverseEarn - shortfall;
    for (const c of p.campaigns || []) m.campaignEarned[c.id] = Math.max(0, (m.campaignEarned[c.id] || 0) - Math.round((c.extra * amount) / p.invoice));
  }
  m.spend = Math.max(0, m.spend - reverseSpend);
  // a level reached only thanks to the refunded spending is taken back (prevents buy-upgrade-refund abuse)
  if (!m.tierLocked) {
    const want = tierForSpend(s, m.spend);
    if (tierIndex(s, want) < tierIndex(s, m.tier)) changeTier(m, s, want, now, by, 'Refund reduced qualifying spending', out);
  }
  p.refunded = (p.refunded || 0) + amount; p.restored += restore; p.earnReversed += reverseEarn; p.spendReversed += reverseSpend; p.cashRefunded += cashPart;
  const cashRefund = Math.max(0, cashPart - shortfall);
  const e = entry(m, now, {
    type: reversal ? 'reversal' : 'refund', label: reversal ? `Correction of ${p.invoiceRef}` : `Refund of ${p.invoiceRef}`,
    refOf: p.id, invoiceRef: p.invoiceRef, category: p.category, refund: amount, restored: restore, earnedReversed: reverseEarn,
    spendReversed: reverseSpend, cashRefund, shortfall, reason,
  }, by);
  if (reversal) p.reversedBy = e.id;
  out.events.push(e); out.entry = e;
  if (s.notifications.reversal) out.notes.push(note('reversal', true, reversal ? 'A transaction was corrected' : 'Refund processed',
    `${reversal ? 'Purchase' : 'Refund on purchase'} ${p.invoiceRef}: ${restore > 0 ? `${fmt(restore)} cashback returned to your wallet. ` : ''}${reverseEarn > 0 ? `${fmt(reverseEarn)} cashback earned on it was removed. ` : ''}New balance: ${fmt(e.balance)}.`));
  return out;
}

// Owner credits or debits (complimentary cashback, corrections). Reason is required.
export function adjust(m, s, cents, kind, reason, now, by) {
  if (!reason) throw new Error('A reason is required.');
  cents |= 0;
  if (!cents) throw new Error('Enter an amount.');
  const out = { notes: [], events: [] };
  const exp = applyExpiry(m, s, now); out.notes.push(...exp.notes); out.events.push(...exp.events);
  if (kind === 'complimentary' && cents < 0) throw new Error('Complimentary cashback must be positive.');
  if (cents > 0) {
    m.lots.push({ id: rid(6), kind: kind === 'complimentary' ? 'complimentary' : 'adjust', cents, orig: cents, issuedAt: now, expiresAt: addMonths(now, s.expiry.months) });
    if (kind === 'complimentary') m.totals.complimentary += cents; else m.totals.adjustments += cents;
  } else {
    const bal = balance(m, now).available;
    if (-cents > bal) throw new Error(`The wallet only has ${fmt(bal)} available.`);
    take(m, -cents, now);
    m.totals.adjustments += cents;
  }
  const e = entry(m, now, { type: kind === 'complimentary' ? 'complimentary' : 'adjustment', label: kind === 'complimentary' ? 'Complimentary cashback' : 'Balance adjustment', [kind === 'complimentary' ? 'reward' : 'adjust']: cents, reason }, by);
  out.events.push(e); out.entry = e;
  if (kind === 'complimentary') out.notes.push(note('complimentary', true, `A gift of ${fmt(cents)} cashback`, `Château Douma added ${fmt(cents)} to your wallet. ${reason}`));
  else if (s.notifications.reversal) out.notes.push(note('adjustment', true, 'Your wallet was adjusted', `${cents > 0 ? 'Added' : 'Removed'} ${fmt(Math.abs(cents))}. New balance: ${fmt(e.balance)}.`));
  return out;
}

// Reverse a non-purchase credit (complimentary, adjustment, birthday) with an opposite entry.
export function reverseCredit(m, s, txId, reason, now, by) {
  const t = m.ledger.find((x) => x.id === txId);
  if (!t) throw new Error('Transaction not found.');
  if (t.type === 'purchase') return refund(m, s, txId, null, reason, now, by, { reversal: true });
  if (t.reversedBy) throw new Error('Already reversed.');
  const amount = t.reward || t.adjust || 0;
  if (!amount || !['complimentary', 'adjustment', 'birthday'].includes(t.type)) throw new Error('This entry cannot be reversed.');
  if (!reason) throw new Error('A reason is required.');
  const out = { notes: [], events: [] };
  let shortfall = 0;
  if (amount > 0) shortfall = take(m, amount, now).shortfall;
  else m.lots.push({ id: rid(6), kind: 'adjust', cents: -amount, orig: -amount, issuedAt: now, expiresAt: addMonths(now, s.expiry.months) });
  const applied = amount > 0 ? amount - shortfall : amount;
  if (t.type === 'complimentary') m.totals.complimentary -= applied;
  else if (t.type === 'birthday') m.totals.birthday -= applied;
  else m.totals.adjustments -= applied;
  const e = entry(m, now, { type: 'reversal', label: `Correction of ${t.label}`, refOf: t.id, adjust: -applied, shortfall, reason }, by);
  t.reversedBy = e.id;
  out.events.push(e); out.entry = e;
  if (s.notifications.reversal) out.notes.push(note('reversal', true, 'A transaction was corrected', `${t.label} was corrected. New balance: ${fmt(e.balance)}.`));
  return out;
}

export function setTier(m, s, key, lock, reason, now, by) {
  if (!reason) throw new Error('A reason is required.');
  if (!s.tiers.find((t) => t.key === key)) throw new Error('Unknown membership level.');
  const out = { notes: [], events: [] };
  m.tierLocked = !!lock;
  if (key !== m.tier) changeTier(m, s, key, now, by, reason, out);
  return out;
}

export function verify(m, s, how, now) {
  const out = { notes: [], events: [] };
  m.verified[how] = true; m.verified.at = m.verified.at || now;
  maybeUnlockWelcome(m, s, now, out);
  return out;
}

// ---------- stamps (free glass / bottle cards) ----------
function stampAdd(m, s, glasses, bottles) {
  const res = { added: null, rewardsReached: [] };
  if (!s.stamps.enabled || (!glasses && !bottles)) return res;
  if (glasses < 0 || bottles < 0 || glasses > 50 || bottles > 50) throw new Error('Invalid stamp count.');
  const g = s.stamps.goal || 5, st = m.stamps;
  st.glasses += glasses; st.lifetimeGlasses += glasses;
  st.bottles += bottles; st.lifetimeBottles += bottles;
  while (st.glasses >= g) { st.glasses -= g; st.glassRewards += 1; res.rewardsReached.push('a free glass'); }
  while (st.bottles >= g) { st.bottles -= g; st.bottleRewards += 1; res.rewardsReached.push('a free bottle'); }
  res.added = { glasses, bottles };
  return res;
}
export function stampRedeem(m, s, kind, now, by) {
  const st = m.stamps;
  const out = { notes: [], events: [] };
  if (kind === 'glass') { if (!st.glassRewards) throw new Error('No free glass available.'); st.glassRewards -= 1; st.freeGlasses += 1; }
  else if (kind === 'bottle') { if (!st.bottleRewards) throw new Error('No free bottle available.'); st.bottleRewards -= 1; st.freeBottles += 1; }
  else throw new Error('Bad request.');
  out.events.push(entry(m, now, { type: 'stamp', label: `Free ${kind} redeemed (stamp card)` }, by));
  return out;
}

// ---------- views ----------
export function customerView(m, s, now) {
  const b = balance(m, now);
  const t = tierByKey(s, m.tier);
  return {
    id: m.id, name: m.name, phone: m.phone, email: m.email, dob: m.dob, dobLocked: !!m.dob, joinedAt: m.joinedAt, lastVisit: m.lastVisit,
    status: m.status, verified: m.verified, tier: m.tier, tierName: t.name, rate: t.rate, next: nextTier(s, m),
    available: b.available, locked: b.locked, nextExpiry: b.nextExpiry, lots: b.lots,
    lifetimeEarned: m.totals.earned + m.totals.welcome - lockedWelcome(m) + m.totals.birthday + m.totals.complimentary + Math.max(0, m.totals.adjustments),
    lifetimeRedeemed: m.totals.redeemed, lifetimeExpired: m.totals.expired, spend: m.spend, visits: m.visits,
    stamps: s.stamps.enabled ? { ...m.stamps, goal: s.stamps.goal } : null, prefs: m.prefs, qr: m.qr, hasPin: !!m.pin,
    transactions: m.ledger.slice(-100).reverse().map(publicTx),
  };
}
const lockedWelcome = (m) => m.lots.filter((l) => l.kind === 'welcome' && l.locked).reduce((a, l) => a + l.cents, 0);
export function publicTx(e) {
  const pick = ['id', 'at', 'type', 'label', 'category', 'invoiceRef', 'invoice', 'paid', 'earned', 'redeemed', 'reward', 'expired', 'adjust', 'refund', 'restored', 'earnedReversed', 'cashRefund', 'balance', 'locked', 'unlocked', 'campaigns', 'stamps', 'toTier'];
  const o = {}; for (const k of pick) if (e[k] !== undefined && e[k] !== null && e[k] !== '') o[k] = e[k];
  return o;
}
export function staffView(m, s, now, full) {
  const v = customerView(m, s, now);
  v.transactions = m.ledger.slice(full ? -500 : -15).reverse().map((e) => ({ ...publicTx(e), by: e.by?.name, notes: e.notes, reason: e.reason, refunded: e.refunded, reversedBy: e.reversedBy, base: e.base, nonEligible: e.nonEligible, shortfall: e.shortfall, refOf: e.refOf }));
  v.tierLocked = m.tierLocked;
  if (full) { v.notes = m.notes; v.totals = m.totals; v.campaignEarned = m.campaignEarned; v.birthdayYears = m.birthdayYears; v.firstPaidAt = m.firstPaidAt; }
  return v;
}
export function summary(m, s, now) {
  const b = balance(m, now);
  return { id: m.id, name: m.name, phone: m.phone, email: m.email, tier: m.tier, status: m.status, available: b.available, locked: b.locked,
    spend: m.spend, visits: m.visits, lastVisit: m.lastVisit, joinedAt: m.joinedAt, earned: m.totals.earned, redeemed: m.totals.redeemed,
    verified: !!(m.verified.phone || m.verified.email), qr: m.qr, dob: m.dob };
}
