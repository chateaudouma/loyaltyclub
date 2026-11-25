// Apple Wallet (.pkpass) and Google Wallet (Generic pass) integration.
// Both need the business's own credentials (see README). Without them, the buttons stay hidden
// and nothing is simulated.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import forge from 'node-forge';
import JSZip from 'jszip';
import ASSETS from './pass-assets.mjs';
import { fmt } from './util.mjs';
import { tierByKey, balance } from './engine.mjs';

export const TIER_COLORS = {
  classic: { bg: '#EBC5C5', hi: '#F5DCDC', text: '#782D39', label: '#782D39' },
  semi: { bg: '#C0C0C0', hi: '#F1F2F3', text: '#41464D', label: '#41464D' },
  premium: { bg: '#C6A052', hi: '#F2DDA4', text: '#594016', label: '#594016' },
};
const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
const b64 = (v) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');
const fmtDate = (iso, tz) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }) : '—');

// ---------------- Apple ----------------
export function appleConfig(env) {
  const c = {
    passTypeId: env.APPLE_PASS_TYPE_ID, teamId: env.APPLE_TEAM_ID,
    cert: b64(env.APPLE_PASS_CERT), key: b64(env.APPLE_PASS_KEY), keyPassword: env.APPLE_PASS_KEY_PASSWORD || '', wwdr: b64(env.APPLE_WWDR_CERT),
  };
  c.ready = !!(c.passTypeId && c.teamId && c.cert && c.key && c.wwdr);
  return c;
}

export function passJson(m, s, origin, cfg, now) {
  const t = tierByKey(s, m.tier);
  const col = TIER_COLORS[m.tier] || TIER_COLORS.classic;
  const bal = balance(m, now).available;
  return {
    formatVersion: 1, passTypeIdentifier: cfg.passTypeId, teamIdentifier: cfg.teamId, serialNumber: m.id,
    organizationName: 'Château Douma', description: 'Château Douma Loyalty Club membership',
    backgroundColor: rgb(col.bg), foregroundColor: rgb(col.text), labelColor: rgb(col.label),
    webServiceURL: `${origin}/api/wallet/apple`, authenticationToken: m.wallet.authToken,
    barcodes: [{ format: 'PKBarcodeFormatQR', message: `${origin}/m/${m.qr}`, messageEncoding: 'iso-8859-1', altText: `#${m.id}` }],
    storeCard: {
      headerFields: [{ key: 'balance', label: 'CASHBACK', value: bal / 100, currencyCode: s.currency.code, changeMessage: 'Your cashback balance is now %@' }],
      primaryFields: [{ key: 'tier', label: 'MEMBERSHIP', value: t.name, changeMessage: 'Your membership is now %@' }],
      secondaryFields: [
        { key: 'name', label: 'MEMBER', value: m.name },
        { key: 'number', label: 'MEMBER NO.', value: `#${m.id}` },
      ],
      auxiliaryFields: [
        { key: 'rate', label: 'CASHBACK RATE', value: `${t.rate}%` },
        { key: 'issued', label: 'MEMBER SINCE', value: fmtDate(m.joinedAt, s.timezone) },
        { key: 'last', label: 'LAST VISIT', value: m.lastVisit ? fmtDate(m.lastVisit, s.timezone) : '—', changeMessage: 'Last visit: %@' },
      ],
      backFields: [
        { key: 'card', label: 'Your card', value: `Open your full card, history and rewards: ${origin}/card` },
        { key: 'terms', label: 'Terms', value: 'Cashback is store credit at Château Douma only. It cannot be exchanged for cash or transferred, and expires ' + s.expiry.months + ' months after it is issued.' },
      ],
    },
  };
}

export async function buildPkpass(m, s, origin, cfg, now) {
  if (!cfg.ready) throw new Error('Apple Wallet is not configured yet.');
  const files = { 'pass.json': Buffer.from(JSON.stringify(passJson(m, s, origin, cfg, now))) };
  for (const sfx of ['', '@2x', '@3x']) {
    files[`icon${sfx}.png`] = Buffer.from(ASSETS[`pass-icon${sfx}.png`], 'base64');
    files[`logo${sfx}.png`] = Buffer.from(ASSETS[`pass-logo${sfx}.png`], 'base64');
    files[`strip${sfx}.png`] = Buffer.from(ASSETS[`pass-strip-${m.tier}${sfx}.png`] || ASSETS[`pass-strip-classic${sfx}.png`], 'base64');
  }
  const manifest = {};
  for (const [n, buf] of Object.entries(files)) manifest[n] = crypto.createHash('sha1').update(buf).digest('hex');
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const signature = signManifest(manifestBuf, cfg);
  const zip = new JSZip();
  for (const [n, buf] of Object.entries(files)) zip.file(n, buf);
  zip.file('manifest.json', manifestBuf);
  zip.file('signature', signature);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function signManifest(manifestBuf, cfg) {
  const cert = forge.pki.certificateFromPem(cfg.cert);
  const key = cfg.keyPassword ? forge.pki.decryptRsaPrivateKey(cfg.key, cfg.keyPassword) : forge.pki.privateKeyFromPem(cfg.key);
  if (!key) throw new Error('Apple pass key could not be read (check APPLE_PASS_KEY_PASSWORD).');
  const wwdr = forge.pki.certificateFromPem(cfg.wwdr);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// Tell every device holding this pass to fetch the new version (Apple Push Notification service).
export async function applePush(cfg, pushTokens) {
  if (!cfg.ready || !pushTokens.length) return 0;
  return new Promise((resolve) => {
    let ok = 0, pending = pushTokens.length;
    const client = http2.connect('https://api.push.apple.com', { cert: cfg.cert, key: cfg.key, passphrase: cfg.keyPassword || undefined });
    const done = () => { if (--pending === 0) { client.close(); resolve(ok); } };
    client.on('error', () => { try { client.close(); } catch (_) {} resolve(ok); });
    for (const tok of pushTokens) {
      const req = client.request({ ':method': 'POST', ':path': `/3/device/${tok}`, 'apns-topic': cfg.passTypeId, 'apns-push-type': 'background' });
      req.on('response', (h) => { if (h[':status'] === 200) ok++; });
      req.on('end', done); req.on('error', done);
      req.end('{}');
      req.resume();
    }
    setTimeout(() => { try { client.close(); } catch (_) {} resolve(ok); }, 8000);
  });
}

// ---------------- Google ----------------
export function googleConfig(env) {
  let sa = null;
  try { sa = env.GOOGLE_WALLET_SERVICE_ACCOUNT ? JSON.parse(b64(env.GOOGLE_WALLET_SERVICE_ACCOUNT)) : null; } catch (_) { sa = null; }
  const c = { issuerId: env.GOOGLE_WALLET_ISSUER_ID, sa };
  c.ready = !!(c.issuerId && sa?.client_email && sa?.private_key);
  return c;
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function signJwt(payload, sa) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}
export function googleObjects(m, s, origin, cfg, now) {
  const t = tierByKey(s, m.tier);
  const col = TIER_COLORS[m.tier] || TIER_COLORS.classic;
  const bal = balance(m, now).available;
  const classId = `${cfg.issuerId}.douma_membership`;
  const loc = (v) => ({ defaultValue: { language: 'en', value: v } });
  return {
    cls: { id: classId },
    obj: {
      id: `${cfg.issuerId}.${m.id}`, classId, state: 'ACTIVE', hexBackgroundColor: col.bg,
      logo: { sourceUri: { uri: `${origin}/google-logo.png` }, contentDescription: loc('Château Douma') },
      heroImage: { sourceUri: { uri: `${origin}/hero-${m.tier}.png` }, contentDescription: loc(t.name) },
      cardTitle: loc('Château Douma Loyalty Club'),
      subheader: loc('Available cashback'),
      header: loc(fmt(bal, s.currency.symbol)),
      textModulesData: [
        { id: 'tier', header: 'Membership', body: t.name },
        { id: 'rate', header: 'Cashback rate', body: `${t.rate}%` },
        { id: 'name', header: 'Member', body: m.name },
        { id: 'number', header: 'Member no.', body: `#${m.id}` },
        { id: 'issued', header: 'Member since', body: fmtDate(m.joinedAt, s.timezone) },
        { id: 'last', header: 'Last visit', body: m.lastVisit ? fmtDate(m.lastVisit, s.timezone) : '—' },
      ],
      barcode: { type: 'QR_CODE', value: `${origin}/m/${m.qr}`, alternateText: `#${m.id}` },
      linksModuleData: { uris: [{ uri: `${origin}/card`, description: 'Open my card' }] },
    },
  };
}
export function googleSaveUrl(m, s, origin, cfg, now) {
  if (!cfg.ready) throw new Error('Google Wallet is not configured yet.');
  const { cls, obj } = googleObjects(m, s, origin, cfg, now);
  const jwt = signJwt({ iss: cfg.sa.client_email, aud: 'google', typ: 'savetowallet', origins: [origin], payload: { genericClasses: [cls], genericObjects: [obj] } }, cfg.sa);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
let gToken = null;
async function googleAccessToken(cfg) {
  if (gToken && gToken.exp > Date.now() + 60e3) return gToken.value;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: cfg.sa.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, cfg.sa);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const d = await r.json();
  if (!r.ok) throw new Error('Google auth failed: ' + (d.error_description || d.error));
  gToken = { value: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return gToken.value;
}
// Update the saved Google pass after a balance or level change. 404 = customer never saved it.
export async function googleUpdate(m, s, origin, cfg, now) {
  if (!cfg.ready || !m.wallet?.google) return false;
  const { obj } = googleObjects(m, s, origin, cfg, now);
  const token = await googleAccessToken(cfg);
  const r = await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${encodeURIComponent(obj.id)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(obj),
  });
  return r.ok;
}
