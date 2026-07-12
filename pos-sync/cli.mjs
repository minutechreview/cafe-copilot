#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { generateDailySummary } from './summarizer.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const line of (await fs.readFile(path.join(root, '.env.local'), 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const args = {};
for (let i=2;i<process.argv.length;i++) { const key=process.argv[i]; if (!key.startsWith('--') || !process.argv[i+1] || process.argv[i+1].startsWith('--')) throw new Error(`Invalid argument: ${key}`); args[key.slice(2)]=process.argv[++i]; }
if (!args.business || !/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) throw new Error('Usage: node pos-sync/cli.mjs --business <uuid> --date YYYY-MM-DD [--out dir]');
const url = process.env.POS_SUPABASE_URL;
let ref = ''; try { ref = new URL(url).hostname.split('.')[0]; } catch {}
if (ref !== 'ljnzschozufepfpkzwjy') throw new Error(`SAFETY ABORT: staging ljnzschozufepfpkzwjy required; received ${ref || 'invalid/missing URL'}.`);
if (!process.env.POS_SUPABASE_ANON_KEY) throw new Error('POS_SUPABASE_ANON_KEY is required.');
const supabase = createClient(url, process.env.POS_SUPABASE_ANON_KEY, { auth: { persistSession:false, autoRefreshToken:false } });
const email = process.env.DEMO_OWNER_EMAIL || 'cafe-copilot-demo@example.com';
const password = process.env.DEMO_OWNER_PASSWORD || 'CafeCopilot-Demo-2026!';
const auth = await supabase.auth.signInWithPassword({ email, password });
if (auth.error) throw new Error(`Authentication failed: ${auth.error.message}`);
const summary = await generateDailySummary({ supabase, businessId:args.business, date:args.date });
if (summary === null) { console.log(`No activity for ${args.date}; no file written.`); process.exit(0); }
const out = path.resolve(args.out || process.cwd()); await fs.mkdir(out,{recursive:true});
const file = path.join(out,`summary-${args.business}-${args.date}.json`);
await fs.writeFile(file,JSON.stringify(summary,null,2)+'\n'); console.log(file);
