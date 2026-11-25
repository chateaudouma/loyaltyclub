// Netlify Function entry: every /api/* request. (The build step copies this file into netlify/functions.)
import { handle } from '../../core.mjs';
import { blobStore, envFrom } from '../../store-netlify.mjs';

export default async (req) => handle(req, blobStore(), envFrom((k) => Netlify.env.get(k)));
export const config = { path: '/api/*' };
