// Run locally with SUPABASE_JWT_SECRET in the environment. Store ONLY the output
// token in Cloudflare SITE_MAINTENANCE_TOKEN; never deploy the JWT signing secret.
import { createHmac } from 'node:crypto';
const secret = process.env.SUPABASE_JWT_SECRET;
if (!secret) throw new Error('Set SUPABASE_JWT_SECRET locally.');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'khub_site_maintenance', iss: 'supabase', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+90*86400 })}`;
process.stdout.write(`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}\n`);
