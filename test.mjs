// Automated checks for the loyalty system. Run: node test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import forge from 'node-forge';
import JSZip from 'jszip';
import { handle } from './core.mjs';
import { memStore } from './memstore.mjs';
import * as E from './engine.mjs';

const store = memStore();
let NOW = '2026-11-25T10:00:00.000Z';
const env = () => ({ OWNER_PIN: '730551', STAFF_PIN: '482913', SITE_URL: 'https://douma.example', __now: NOW, ...extraEnv });
let extraEnv = {};
const call = async (method, path, body, token) => {
  const r = await handle(new Request('https://douma.example/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), store, env());
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
};
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } };
const money = (c) => c / 100;

console.log('\nChâteau Douma Loyalty Club — test run\n');
let owner, staff, A, B, C;
const join = (name, phone, extra = {}) => call('POST', '/join', { name, phone, adult: true, consent: true, marketing: true, pin: '2580', ...extra });
const me = (x) => call('GET', `/me?m=${x.id}&t=${x.token}`);
const buy = (id, invoice, extra = {}, tok = staff) => call('POST', '/staff/purchase', { memberId: id, invoice, category: 'Wine bottles', invoiceRef: 'INV-' + crypto.randomUUID().slice(0, 8), txKey: crypto.randomUUID(), ...extra }, tok);

await t('Registration creates sequential membership numbers from #CD1001', async () => {
  const a = await join('Michelle Issa', '+961 71 234 567', { dob: '1994-11-26' });
  const b = await join('Rami Haddad', '03 111 222');
  const c = await join('Nadia Sleiman', '70 555 444');
  assert.equal(a.status, 200); assert.equal(a.data.id, 'CD1001'); assert.equal(b.data.id, 'CD1002'); assert.equal(c.data.id, 'CD1003');
  A = a.data; B = b.data; C = c.data;
});
await t('Duplicate phone number cannot register again (no second welcome reward)', async () => {
  const r = await join('Michelle Again', '71234567');
  assert.equal(r.status, 409); assert.match(r.data.error, /Sign in/);
});
await t('A 4-digit PIN is required at sign-up, and easy PINs are refused', async () => {
  assert.equal((await join('No Pin', '76 222 333', { pin: '' })).status, 400);
  assert.equal((await join('Weak Pin', '76 222 333', { pin: '1111' })).status, 400);
  assert.equal((await join('Weak Pin', '76 222 333', { pin: '1234' })).status, 400);
});
await t('Existing member signs in on another phone with phone number + PIN (no staff needed)', async () => {
  assert.equal((await call('POST', '/login', { phone: '+961 71 234 567', pin: '9999' })).status, 401);
  assert.equal((await call('POST', '/login', { phone: '+961 76 123 123', pin: '2580' })).status, 401, 'unknown number gives the same answer');
  const ok = await call('POST', '/login', { phone: '+961 71 234 567', pin: '2580' });
  assert.equal(ok.status, 200); assert.equal(ok.data.m, 'CD1001'); assert.equal(ok.data.t, A.token);
});
await t('Five wrong PINs lock sign-in for that card for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/login', { phone: '03 111 222', pin: '0001' });
  assert.equal((await call('POST', '/login', { phone: '03 111 222', pin: '2580' })).status, 429);
});
await t('Member can change their PIN from Profile', async () => {
  assert.equal((await call('POST', '/me/profile', { m: C.id, t: C.token, newPin: '7391' })).status, 200);
  assert.equal((await call('POST', '/login', { phone: '70 555 444', pin: '2580' })).status, 401);
  assert.equal((await call('POST', '/login', { phone: '70 555 444', pin: '7391' })).status, 200);
});
await t('Under-18 date of birth is refused', async () => {
  const r = await join('Young', '76 999 999', { dob: '2012-01-01' }); assert.equal(r.status, 400);
});
await t('Welcome reward: $2 usable immediately after joining, not counted as spending', async () => {
  const r = await me(A);
  assert.equal(r.data.member.available, 200); assert.equal(r.data.member.locked, 0); assert.equal(r.data.member.spend, 0);
  assert.equal(r.data.member.tier, 'classic'); assert.equal(r.data.member.rate, 5);
  assert.match(r.data.inbox[0].title, /Welcome/);
});
await t('Owner and staff sign in; wrong PIN refused; staff cannot open owner tools', async () => {
  assert.equal((await call('POST', '/auth/login', { pin: '000000' })).status, 401);
  owner = (await call('POST', '/auth/login', { pin: '730551' })).data.token;
  staff = (await call('POST', '/auth/login', { pin: '482913' })).data.token;
  assert.ok(owner && staff);
  assert.equal((await call('GET', '/owner/customers', null, staff)).status, 403);
  assert.equal((await call('GET', '/owner/customers', null, owner)).status, 200);
  assert.equal((await call('GET', '/staff/find?q=CD1001')).status, 401);
});
await t('QR scan identifies the customer without exposing personal data in the code', async () => {
  const qrUrl = (await me(A)).data.qrUrl;
  assert.match(qrUrl, /^https:\/\/douma\.example\/m\/[\w-]{16}$/);
  assert.ok(!qrUrl.includes('CD1001') && !qrUrl.includes('71234567'));
  const r = await call('GET', '/staff/find?q=' + encodeURIComponent(qrUrl), null, staff);
  assert.equal(r.data.member.id, 'CD1001');
  assert.ok(r.data.member.phone.startsWith('…'), 'staff sees masked phone');
});
await t('Manual lookup by name, member number and phone', async () => {
  assert.equal((await call('GET', '/staff/find?q=CD1002', null, staff)).data.member.id, 'CD1002');
  assert.equal((await call('GET', '/staff/find?q=1002', null, staff)).data.member.id, 'CD1002', 'number without CD');
  assert.equal((await call('GET', '/staff/find?q=' + encodeURIComponent('cd 1003'), null, staff)).data.member.id, 'CD1003');
  assert.equal((await call('GET', '/staff/find?q=' + encodeURIComponent('+96171234567'), null, staff)).data.member.id, 'CD1001');
  assert.equal((await call('GET', '/staff/find?q=' + encodeURIComponent('70 555 444'), null, staff)).data.member.id, 'CD1003');
  assert.equal((await call('GET', '/staff/find?q=nadia', null, staff)).data.member.id, 'CD1003');
});
await t('Scanning alone changes nothing (purchase needs explicit confirmation)', async () => {
  assert.equal((await me(A)).data.member.transactions.filter((x) => x.type === 'purchase').length, 0);
});
await t('Quote previews the maths without saving', async () => {
  const q = (await call('POST', '/staff/quote', { memberId: 'CD1001', invoice: '100', category: 'Wine bottles' }, staff)).data.quote;
  assert.equal(q.earned, 500); assert.equal(q.newBalance, 700); assert.equal(q.rate, 5);
  assert.equal((await me(A)).data.member.available, 200);
});
await t('Classic purchase: $100 at 5% = $5.00 on top of the $2 welcome', async () => {
  const r = await buy('CD1001', '100');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.entry.earned, 500); assert.equal(r.data.entry.balance, 700);
  const m = (await me(A)).data.member;
  assert.equal(m.available, 700); assert.equal(m.spend, 10000); assert.equal(m.visits, 1);
});
await t('Welcome reward can be spent on the very first purchase', async () => {
  const r = await buy('CD1003', '10', { redeem: '2' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.entry.redeemed, 200); assert.equal(r.data.entry.paid, 800);
});
await t('Duplicate invoice reference is blocked; same confirmation sent twice is not double-counted', async () => {
  const key = crypto.randomUUID();
  const one = await buy('CD1002', '20', { invoiceRef: 'R-555', txKey: key });
  const again = await buy('CD1002', '20', { invoiceRef: 'R-555', txKey: key });
  assert.equal(one.status, 200); assert.equal(again.status, 200); assert.equal(again.data.duplicate, true);
  const other = await buy('CD1001', '20', { invoiceRef: 'r 555', txKey: crypto.randomUUID() });
  assert.equal(other.status, 409);
  assert.equal((await me(B)).data.member.available, 300);
});
await t('Partial redemption (spec example): $50 invoice, redeem $5 of $7 -> pay $45, earn 5% of $45 = $2.25', async () => {
  const r = await buy('CD1001', '50', { redeem: '5' });
  assert.equal(r.data.entry.paid, 4500); assert.equal(r.data.entry.redeemed, 500); assert.equal(r.data.entry.earned, 225);
  assert.equal(r.data.entry.balance, 700 - 500 + 225);
});
await t('Cannot redeem more than the wallet balance or the invoice amount', async () => {
  assert.equal((await buy('CD1001', '50', { redeem: '100' })).status, 400);
  assert.equal((await buy('CD1003', '10', { redeem: '1' })).status, 400);
});
await t('Full redemption: redeem whole balance', async () => {
  const bal = (await me(A)).data.member.available;
  const r = await buy('CD1001', '30', { redeem: String(bal / 100) });
  assert.equal(r.data.entry.redeemed, bal); assert.equal(r.data.entry.paid, 3000 - bal);
  assert.equal(r.data.entry.earned, Math.round((3000 - bal) * 0.05));
});
await t('Redemption uses the earliest-expiring cashback first', async () => {
  const m = (await store.getJSON('members/CD1001')).data;
  const red = m.ledger.filter((x) => x.type === 'purchase' && x.redeemed).at(-1);
  const exps = red.redeemedFrom.map((u) => u.expiresAt);
  assert.deepEqual(exps, [...exps].sort());
});
await t('Automatic upgrade to SEMI-PREMIUM at $250 — new rate applies only to later purchases', async () => {
  const before = (await me(B)).data.member; // spend $20
  const r = await buy('CD1002', '240'); // crosses $250 within this purchase
  assert.equal(r.data.entry.earned, 1200, 'still 5% on the purchase that crossed the threshold');
  assert.equal(r.data.tierChanged.to, 'semi');
  const after = (await me(B)).data;
  assert.equal(after.member.tier, 'semi'); assert.equal(after.member.rate, 7.5);
  assert.ok(after.inbox.some((n) => /SEMI-PREMIUM/.test(n.title)), 'upgrade notification');
  const r2 = await buy('CD1002', '100');
  assert.equal(r2.data.entry.earned, 750, 'spec example: $100 at 7.5% = $7.50');
});
await t('Automatic upgrade to PREMIUM at $1,000, then 10%', async () => {
  await buy('CD1002', '400');
  assert.equal((await me(B)).data.member.tier, 'semi', '$760 is still Semi-Premium');
  await buy('CD1002', '240');
  assert.equal((await me(B)).data.member.tier, 'premium');
  const r = await buy('CD1002', '100');
  assert.equal(r.data.entry.earned, 1000);
});
await t('Excluded category (gift card) earns no cashback and no qualifying spend', async () => {
  const s0 = (await me(C)).data.member.spend;
  const r = await buy('CD1003', '50', { category: 'Gift card' });
  assert.equal(r.data.entry.earned, 0);
  assert.equal((await me(C)).data.member.spend, s0);
});
await t('Mixed invoice: non-eligible part excluded from cashback', async () => {
  const r = await buy('CD1003', '100', { nonEligible: '40' });
  assert.equal(r.data.entry.earned, 300);
});
await t('Partial refund reverses cashback and spending proportionally', async () => {
  const p = await buy('CD1003', '200'); // earns $10
  const tx = p.data.entry.id;
  assert.equal((await call('POST', '/staff/refund', { memberId: 'CD1003', txId: tx, amount: '50', reason: 'Bottle returned' }, staff)).status, 403, 'staff cannot refund by default');
  const r = await call('POST', '/staff/refund', { memberId: 'CD1003', txId: tx, amount: '50', reason: 'Bottle returned' }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.entry.earnedReversed, 250); assert.equal(r.data.cashRefund, 5000);
  const full = await call('POST', '/staff/refund', { memberId: 'CD1003', txId: tx, reason: 'Rest returned' }, owner);
  assert.equal(full.data.entry.earnedReversed, 750); assert.equal(full.data.entry.refund, 15000);
  assert.equal((await call('POST', '/staff/refund', { memberId: 'CD1003', txId: tx, reason: 'again' }, owner)).status, 400);
});
await t('Refund after spending the earned cashback: shortfall is deducted from the cash refund', async () => {
  const p = await buy('CD1003', '100'); // earns $5
  const bal = (await me(C)).data.member.available;
  await buy('CD1003', '20', { redeem: String(Math.min(bal, 2000) / 100) }); // spends it
  const left = (await me(C)).data.member.available;
  const r = await call('POST', '/staff/refund', { memberId: 'CD1003', txId: p.data.entry.id, reason: 'Returned' }, owner);
  assert.equal(r.data.entry.earnedReversed, 500);
  assert.equal(r.data.shortfall, Math.max(0, 500 - left));
  assert.equal(r.data.cashRefund, 10000 - Math.max(0, 500 - left));
  assert.ok((await me(C)).data.member.available >= 0);
});
await t('Refund restores cashback that was used on the refunded purchase', async () => {
  await call('POST', '/owner/adjust', { memberId: 'CD1003', amount: '10', kind: 'complimentary', reason: 'Apology for wait' }, owner);
  const b0 = (await me(C)).data.member.available;
  const p = await buy('CD1003', '40', { redeem: '10' });
  const r = await call('POST', '/staff/refund', { memberId: 'CD1003', txId: p.data.entry.id, reason: 'Cancelled order' }, owner);
  assert.equal(r.data.entry.restored, 1000);
  assert.equal((await me(C)).data.member.available, b0);
});
await t('Owner adjustments need a reason and are audited; staff cannot adjust', async () => {
  assert.equal((await call('POST', '/owner/adjust', { memberId: 'CD1003', amount: '5', kind: 'complimentary' }, owner)).status, 400);
  assert.equal((await call('POST', '/owner/adjust', { memberId: 'CD1003', amount: '5', kind: 'complimentary', reason: 'x' }, staff)).status, 403);
  const au = (await call('GET', '/owner/audit', null, owner)).data.audit;
  assert.ok(au.some((a) => a.action === 'wallet.complimentary' && a.reason === 'Apology for wait'));
  assert.ok(au.some((a) => a.action === 'purchase.record' && a.by.name === 'Shared staff PIN'));
});
await t('Reversal entry corrects a mistaken complimentary credit (records are never deleted)', async () => {
  const r = await call('POST', '/owner/adjust', { memberId: 'CD1002', amount: '3', kind: 'complimentary', reason: 'Typo test' }, owner);
  const tx = r.data.member.transactions.find((x) => x.type === 'complimentary');
  const before = (await me(B)).data.member.available;
  const rv = await call('POST', '/owner/reverse', { memberId: 'CD1002', txId: tx.id, reason: 'Entered by mistake' }, owner);
  assert.equal(rv.status, 200);
  const m = (await me(B)).data.member;
  assert.equal(m.available, before - 300);
  assert.ok(m.transactions.some((x) => x.id === tx.id), 'original still in history');
});
await t('Customers cannot change balances, spending or level through their profile', async () => {
  const r = await call('POST', '/me/profile', { m: A.id, t: A.token, available: 99999, spend: 999999, tier: 'premium', prefs: { marketing: false } });
  assert.equal(r.status, 200);
  const m = (await me(A)).data.member;
  assert.notEqual(m.available, 99999); assert.equal(m.tier, 'classic'); assert.equal(m.prefs.marketing, false);
  assert.equal((await call('GET', `/me?m=CD1001&t=wrongtoken123`)).status, 404);
});
await t('Concurrent redemptions cannot overspend the wallet', async () => {
  await call('POST', '/owner/adjust', { memberId: 'CD1002', amount: '10', kind: 'complimentary', reason: 'test' }, owner);
  const bal = (await me(B)).data.member.available;
  const rs = await Promise.all([1, 2, 3].map(() => buy('CD1002', String(bal / 100 + 1), { redeem: String(bal / 100) })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status + ' ' + (r.data.error || '')).join(' | '));
  assert.ok((await me(B)).data.member.available >= 0);
});
await t('Birthday: $5 once per year, valid 30 days; birthday cannot be changed by the customer', async () => {
  NOW = '2026-11-26T08:00:00.000Z'; // Michelle's birthday (26 Nov)
  const r = await me(A);
  assert.ok(r.data.member.transactions.some((x) => x.type === 'birthday' && x.reward === 500));
  const again = await me(A);
  assert.equal(again.data.member.transactions.filter((x) => x.type === 'birthday').length, 1);
  assert.equal((await call('POST', '/me/profile', { m: A.id, t: A.token, dob: '1994-12-01' })).status, 400);
  NOW = '2026-12-27T09:00:00.000Z';
  const after = (await me(A)).data.member;
  assert.ok(after.transactions.some((x) => x.type === 'expire'), 'unused birthday reward expired after 30 days');
});
let D;
await t('Campaign: Double Cashback Weekend (Beirut time), not stacking, capped per transaction', async () => {
  NOW = '2026-12-05T10:00:00.000Z';
  D = (await join('Karim Aoun', '71 888 777')).data;
  const c1 = await call('POST', '/owner/campaigns', { campaign: { name: 'Double Cashback Weekend', startLocal: '2026-12-05T00:00', endLocal: '2026-12-07T00:00', type: 'multiplier', value: 2, enabled: true } }, owner);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  await call('POST', '/owner/campaigns', { campaign: { name: 'Workshop special', startLocal: '2026-12-01T00:00', endLocal: '2026-12-31T00:00', type: 'fixed', value: 6, enabled: true, categories: ['Workshop'] } }, owner);
  const r = await buy(D.id, '100');
  assert.equal(r.data.entry.earned, 1000, '5% doubled to 10%');
  const camp = (await call('GET', '/owner/campaigns', null, owner)).data.campaigns.find((c) => c.name === 'Double Cashback Weekend');
  assert.equal(camp.startLocal, '2026-12-05T00:00'); assert.equal(camp.startAt, '2026-12-04T22:00:00.000Z');
  await call('POST', '/owner/campaigns', { campaign: { ...camp, maxPerTx: '2' } }, owner);
  const r2 = await buy(D.id, '50');
  assert.equal(r2.data.entry.earned, 450, 'bonus capped at $2');
  NOW = '2026-12-07T10:00:00.000Z';
  const r3 = await buy(D.id, '20');
  assert.equal(r3.data.entry.earned, 100, 'campaign ended automatically');
});
await t('Settings: owner changes rates and thresholds without code changes', async () => {
  const s = (await call('GET', '/owner/settings', null, owner)).data.settings;
  s.tiers[0].rate = 6;
  assert.equal((await call('POST', '/owner/settings', { settings: s }, owner)).status, 200);
  const r = await buy(D.id, '10');
  assert.equal(r.data.entry.earned, 60);
  s.tiers[0].rate = 5; s.tiers[2].min = 10; // invalid: thresholds must go up
  assert.equal((await call('POST', '/owner/settings', { settings: s }, owner)).status, 400);
  s.tiers[2].min = 100000;
  assert.equal((await call('POST', '/owner/settings', { settings: s }, owner)).status, 200);
});
await t('Cashback expires 12 months after issuance, with a warning first', async () => {
  NOW = '2027-11-01T09:00:00.000Z';
  const w = (await me(B)).data;
  assert.ok(w.inbox.some((n) => /expiring/i.test(n.title)), 'warning sent');
  NOW = '2028-01-10T09:00:00.000Z';
  const m = (await me(B)).data.member;
  assert.ok(m.transactions.some((x) => x.type === 'expire'));
  assert.equal(m.available, 0);
  NOW = '2026-12-08T10:00:00.000Z';
});
await t('Suspended members cannot earn or redeem', async () => {
  await call('POST', '/owner/status', { memberId: 'CD1003', status: 'suspended', reason: 'Fraud check' }, owner);
  assert.equal((await buy('CD1003', '10')).status, 400);
  await call('POST', '/owner/status', { memberId: 'CD1003', status: 'active', reason: 'Cleared' }, owner);
  assert.equal((await buy('CD1003', '10')).status, 200);
});
await t('Manual level change by owner (with reason, kept fixed)', async () => {
  const r = await call('POST', '/owner/tier', { memberId: 'CD1001', tier: 'premium', lock: true, reason: 'VIP partner' }, owner);
  assert.equal(r.data.member.tier, 'premium');
  assert.equal((await buy('CD1001', '10')).data.entry.earned, 100);
});
await t('Individual staff accounts with their own PIN and permissions', async () => {
  const r = await call('POST', '/owner/staff', { action: 'create', name: 'Joe', pin: '5511', perms: { refund: true } }, owner);
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/owner/staff', { action: 'create', name: 'Dup', pin: '730551' }, owner)).status, 400, 'cannot reuse owner PIN');
  const joe = (await call('POST', '/auth/login', { pin: '5511' })).data;
  assert.equal(joe.name, 'Joe'); assert.equal(joe.perms.refund, true);
  const p = await buy('CD1002', '10', {}, joe.token);
  assert.equal(p.status, 200);
  const hist = (await call('GET', '/staff/member?id=CD1002', null, owner)).data.member.transactions;
  assert.equal(hist.find((x) => x.id === p.data.entry.id).by, 'Joe');
  const id = r.data.staff[0].id;
  await call('POST', '/owner/staff', { action: 'update', id, active: false }, owner);
  assert.equal((await buy('CD1002', '10', {}, joe.token)).status, 401, 'deactivated staff is locked out');
});
await t('Every 5 visits (one per day with a purchase) earns a complimentary glass', async () => {
  const E2 = (await join('Visit Tester', '76 444 555')).data;
  const days = ['2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13'];
  for (const d of days) { NOW = d + 'T12:00:00.000Z'; await buy(E2.id, '20'); }
  NOW = '2026-12-13T18:00:00.000Z'; await buy(E2.id, '20'); // same day: no extra visit
  let m = (await me(E2)).data.member;
  assert.equal(m.stamps.glasses, 4); assert.equal(m.stamps.glassRewards, 0);
  NOW = '2026-12-14T12:00:00.000Z'; await buy(E2.id, '20');
  m = (await me(E2)).data.member;
  assert.equal(m.stamps.glasses, 0); assert.equal(m.stamps.glassRewards, 1);
  assert.ok((await me(E2)).data.inbox.some((n) => /complimentary glass/i.test(n.title)));
  const rr = await call('POST', '/staff/stamp-redeem', { memberId: E2.id, kind: 'glass' }, staff);
  assert.equal(rr.data.member.stamps.glassRewards, 0);
  NOW = '2026-12-08T10:00:00.000Z';
});
await t('Real-time sync: the customer card reflects staff changes immediately', async () => {
  const before = (await me(C)).data.member.available;
  const r = await buy('CD1003', '20');
  assert.equal((await me(C)).data.member.available, before + r.data.entry.earned);
});
await t('Analytics and CSV exports', async () => {
  const a = (await call('GET', '/owner/analytics?from=2026-11-01T00:00:00Z&to=2027-01-01T00:00:00Z', null, owner)).data;
  assert.equal(a.members.total, 5); assert.ok(a.sales > 0); assert.ok(a.issued > 0); assert.ok(a.redeemed > 0); assert.ok(a.costPercent > 0);
  assert.equal(a.welcome.count, 5); assert.equal(a.birthday.count, 1);
  assert.ok(a.topSpenders[0].id === 'CD1002');
  const csv = await call('GET', '/owner/export?type=transactions&from=2026-11-01T00:00:00Z&to=2027-01-01T00:00:00Z', null, owner);
  const text = new TextDecoder().decode(csv.data);
  assert.match(text, /Cashback earned/); assert.ok(text.split('\n').length > 20);
  const mc = new TextDecoder().decode((await call('GET', '/owner/export?type=member&id=CD1001', null, owner)).data);
  assert.match(mc, /birthday/);
});
await t('Rebuild reports gives the same totals as live tracking', async () => {
  { const live = {}; for (const k of await store.list('events/')) for (const e of (await store.getJSON(k)).data) if (e.type === 'purchase') live[e.m] = (live[e.m] || 0) + e.base;
    const led = {}; for (const k of await store.list('members/')) { const m = (await store.getJSON(k)).data; for (const e of m.ledger) if (e.type === 'purchase') led[m.id] = (led[m.id] || 0) + e.base; }
    assert.deepEqual(live, led); }
  const a1 = (await call('GET', '/owner/analytics?from=2026-01-01T00:00:00Z&to=2029-01-01T00:00:00Z', null, owner)).data;
  await call('POST', '/owner/rebuild', {}, owner);
  const a2 = (await call('GET', '/owner/analytics?from=2026-01-01T00:00:00Z&to=2029-01-01T00:00:00Z', null, owner)).data;
  for (const k of ['sales', 'issued', 'redeemed', 'expired', 'outstanding']) assert.equal(a1[k], a2[k], k);
});
await t('Ledger always balances: wallet = credits − redemptions − expiries − reversals', async () => {
  for (const id of ['CD1001', 'CD1002', 'CD1003']) {
    const m = (await store.getJSON('members/' + id)).data;
    const bal = E.balance(m, NOW).available + E.balance(m, NOW).locked;
    const credits = m.lots.reduce((a, l) => a + l.orig, 0);
    const lotsNow = m.lots.reduce((a, l) => a + l.cents, 0);
    assert.equal(bal, lotsNow);
    assert.ok(credits >= lotsNow);
    assert.ok(m.lots.every((l) => Number.isInteger(l.cents) && l.cents >= 0));
  }
});
await t('Existing v1 member (stamp card only) is upgraded without losing stamps', async () => {
  await store.setJSON('members/CD1099', { id: 'CD1099', token: 'oldtoken123456', name: 'Old Member', phone: '96170999888', dob: '1980-01-01', joinedAt: '2026-11-24T10:00:00.000Z', lastVisit: null, glasses: 5, bottles: 2, lifetime: { glasses: 7, bottles: 2, freeGlasses: 1, freeBottles: 0 }, history: [] });
  const r = await call('GET', '/me?m=CD1099&t=oldtoken123456');
  assert.equal(r.status, 200);
  assert.equal(r.data.member.stamps.glassRewards, 1); assert.equal(r.data.member.stamps.bottles, 2); assert.equal(r.data.member.available, 0);
  assert.equal((await call('GET', '/staff/find?q=' + encodeURIComponent('https://old/card?m=CD1099&t=x'), null, staff)).data.member.id, 'CD1099');
});
await t('Apple Wallet: signed .pkpass in the tier colours (test certificate)', async () => {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 864e5);
  cert.setSubject([{ name: 'commonName', value: 'Pass Type ID: pass.test' }]); cert.setIssuer(cert.subject.attributes); cert.sign(keys.privateKey);
  const pem = Buffer.from(forge.pki.certificateToPem(cert)).toString('base64');
  extraEnv = { APPLE_PASS_TYPE_ID: 'pass.com.chateaudouma.loyalty', APPLE_TEAM_ID: 'ABCDE12345', APPLE_PASS_CERT: pem, APPLE_PASS_KEY: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)).toString('base64'), APPLE_WWDR_CERT: pem };
  const r = await call('GET', `/wallet/apple/pass?m=${B.id}&t=${B.token}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const zip = await JSZip.loadAsync(Buffer.from(r.data));
  const pass = JSON.parse(await zip.file('pass.json').async('string'));
  assert.equal(pass.serialNumber, 'CD1002'); assert.equal(pass.storeCard.primaryFields[0].value, 'PREMIUM MEMBER');
  assert.equal(pass.backgroundColor, 'rgb(198, 160, 82)'); assert.equal(pass.foregroundColor, 'rgb(89, 64, 22)');
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  for (const [n, h] of Object.entries(manifest)) assert.equal(crypto.createHash('sha1').update(await zip.file(n).async('nodebuffer')).digest('hex'), h);
  assert.ok((await zip.file('signature').async('nodebuffer')).length > 500);
  // Apple's servers: register device, list updated passes, fetch latest
  const auth = { authorization: 'ApplePass ' + pass.authenticationToken };
  const reg = await handle(new Request(`https://douma.example/api/wallet/apple/v1/devices/dev1/registrations/${pass.passTypeIdentifier}/CD1002`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pushToken: 'abc' }) }), store, env());
  assert.equal(reg.status, 201);
  const list = await handle(new Request(`https://douma.example/api/wallet/apple/v1/devices/dev1/registrations/${pass.passTypeIdentifier}`), store, env());
  assert.deepEqual((await list.json()).serialNumbers, ['CD1002']);
  const bad = await handle(new Request(`https://douma.example/api/wallet/apple/v1/passes/${pass.passTypeIdentifier}/CD1002`, { headers: { authorization: 'ApplePass wrong' } }), store, env());
  assert.equal(bad.status, 401);
  extraEnv = {};
});
await t('Google Wallet: signed "Save to Google Wallet" link in the tier colours (test key)', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'wallet@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  extraEnv = { GOOGLE_WALLET_ISSUER_ID: '3388000000012345678', GOOGLE_WALLET_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(sa)).toString('base64') };
  const r = await call('GET', `/wallet/google?m=${C.id}&t=${C.token}`);
  const jwt = r.data.url.split('/save/')[1];
  const [h, p, sig] = jwt.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')));
  const obj = JSON.parse(Buffer.from(p, 'base64url')).payload.genericObjects[0];
  assert.equal(obj.hexBackgroundColor, { classic: '#EBC5C5', semi: '#C0C0C0', premium: '#C6A052' }[(await me(C)).data.member.tier]); assert.equal(obj.barcode.type, 'QR_CODE'); assert.match(obj.header.defaultValue.value, /^\$/);
  extraEnv = {};
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.\n`);
