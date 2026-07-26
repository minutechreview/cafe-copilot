#!/usr/bin/env node
import { config } from 'dotenv';
import { getDemoPosClient } from '../pos-client.mjs';

config({ path: new URL('../../.env.local', import.meta.url), quiet: true });

const EXPECTED_REF = 'ljnzschozufepfpkzwjy';
const configuredUrl = new URL(process.env.POS_SUPABASE_URL || 'https://invalid.example');
if (configuredUrl.hostname !== `${EXPECTED_REF}.supabase.co`) {
  throw new Error(`SAFETY ABORT: staging ${EXPECTED_REF} is required`);
}

const supabase = await getDemoPosClient();
const membership = await supabase
  .from('business_memberships')
  .select('business_id,role,status')
  .eq('status', 'active')
  .in('role', ['owner', 'manager'])
  .limit(1)
  .maybeSingle();

if (membership.error || !membership.data?.business_id) {
  throw new Error('Staging smoke failed: active owner/manager membership was not readable');
}

const sessions = await supabase
  .from('till_sessions')
  .select('id,staff_profiles!till_sessions_business_staff_fkey(name,role)')
  .eq('business_id', membership.data.business_id)
  .limit(1);

if (sessions.error) {
  throw new Error(`Staging smoke failed: till session staff relationship was not resolvable (${sessions.error.code || 'unknown'})`);
}

const waste = await supabase
  .from('waste_comp_logs')
  .select('id')
  .eq('business_id', membership.data.business_id)
  .limit(1);

if (waste.error) {
  throw new Error('Staging smoke failed: waste log was not readable');
}

console.log(JSON.stringify({
  ok: true,
  project: EXPECTED_REF,
  membership: membership.data.role,
  staffRelationship: 'resolvable',
  wasteLog: 'readable',
}));
