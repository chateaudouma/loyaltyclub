// Scheduled Netlify Function: once a day expires old cashback, sends expiry warnings and birthday rewards.
import { runDaily } from '../../core.mjs';
import { blobStore, envFrom } from '../../store-netlify.mjs';

export default async () => { await runDaily(blobStore(), envFrom((k) => Netlify.env.get(k))); return new Response('ok'); };
export const config = { schedule: '15 5 * * *' }; // every morning (05:15 UTC = 07:15 or 08:15 in Beirut)
