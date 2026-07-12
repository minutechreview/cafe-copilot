#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DIR);
const EXPECTED_REF = 'ljnzschozufepfpkzwjy';
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]?.startsWith('--') ? true : a[i + 1] ?? true] : [String(i), v]));

async function loadEnv(file) {
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await loadEnv(path.join(ROOT, '.env.local'));
const url = process.env.POS_SUPABASE_URL;
const key = process.env.POS_SUPABASE_ANON_KEY;
const ref = (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return ''; } })();
if (ref !== EXPECTED_REF) throw new Error(`SAFETY ABORT: POS_SUPABASE_URL must target staging ${EXPECTED_REF}; received ${ref || 'an invalid/missing URL'}.`);
if (!key) throw new Error('POS_SUPABASE_ANON_KEY is required.');

const email = String(args.email || process.env.DEMO_OWNER_EMAIL || 'cafe-copilot-demo@example.com');
const password = String(args.password || process.env.DEMO_OWNER_PASSWORD || 'CafeCopilot-Demo-2026!');
const pin = String(args.pin || process.env.DEMO_OWNER_PIN || '2468');
if (!/^\d{4}$/.test(pin)) throw new Error('Owner PIN must be exactly four digits.');
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const fail = (label, error) => { if (error) throw new Error(`${label}: ${error.message}`); };
const insert = async (table, rows, select = '*') => { const q = await supabase.from(table).insert(rows).select(select); fail(`insert ${table}`, q.error); return q.data; };

let auth = await supabase.auth.signInWithPassword({ email, password });
if (auth.error) {
  const signed = await supabase.auth.signUp({ email, password });
  fail('sign up demo owner', signed.error);
  if (!signed.data.session) throw new Error('Sign-up requires email confirmation. Confirm the demo owner, then rerun with the same credentials.');
  auth = signed;
}
const user = auth.data.user;
let profileQ = await supabase.from('staff_profiles').select('id,business_id').eq('user_id', user.id).maybeSingle();
fail('lookup existing demo business', profileQ.error);
if (profileQ.data) {
  if (!args.fresh) throw new Error(`Demo business ${profileQ.data.business_id} already exists; rerun with --fresh to recreate it.`);
  const deleted = await supabase.from('businesses').delete().eq('id', profileQ.data.business_id);
  fail('delete existing demo business', deleted.error);
}

const [business] = await insert('businesses', { name: 'Harbour & Bean Demo Café', locale_default: 'en-LK', currency: 'LKR', contact_info: { phone: '+94 11 555 0142', email, address: '42 Galle Road, Colombo 03' } });
const ownerInsert = await supabase.from('staff_profiles').insert({ user_id: user.id, business_id: business.id, role: 'owner', name: 'Maya Perera', pin_hash: pin });
fail('insert owner staff_profile', ownerInsert.error);
const ownerQuery = await supabase.from('staff_profiles').select('id,user_id,business_id,name,role,created_at').eq('user_id', user.id).single();
fail('read owner staff_profile', ownerQuery.error);
const owner = ownerQuery.data;
const staffRows = [
  { business_id: business.id, role: 'manager', name: 'Nimal Silva', pin_hash: '1357' },
  { business_id: business.id, role: 'staff', name: 'Asha Fernando', pin_hash: '1122' },
  { business_id: business.id, role: 'staff', name: 'Ruwan Jayasinghe', pin_hash: '3344' }
];
const staffInsert = await supabase.from('staff_profiles').insert(staffRows);
fail('insert staff_profiles', staffInsert.error);
const staffQuery = await supabase.from('staff_profiles').select('id,user_id,business_id,name,role,created_at').eq('business_id', business.id).neq('id', owner.id).order('name');
fail('read inserted staff_profiles', staffQuery.error);
const staff = staffQuery.data;
await insert('business_config', { business_id: business.id, business_type: 'cafe', service_style: 'mixed', active_order_types: ['dine_in','takeaway','delivery'], kitchen_stations: 1, device_preference: 'tablet', active_languages: ['en','si'], recipe_depletion_enabled: false, kds_enabled: true, kds_flow: 'quick' });
const tills = await insert('tills', [{ business_id: business.id, name: 'Front Counter', standard_float: 10000 }, { business_id: business.id, name: 'Garden Counter', standard_float: 6000 }]);
const menu = await insert('menu_items', [
  ['Ceylon Flat White','Coffee',850],['Iced Milo','Cold Drinks',700],['Masala Chai','Tea',550],['Egg Hopper Plate','Breakfast',1450],['Chicken Kottu','Lunch',1950],['Avocado Toast','Breakfast',1650],['Butter Croissant','Bakery',650],['Chocolate Brownie','Bakery',750]
].map(([name,category,price]) => ({ business_id: business.id, name, category, price, active:true, available:true })));

const today = new Date(); today.setUTCHours(0,0,0,0);
const start = new Date(today); start.setUTCDate(start.getUTCDate() - 20);
const isoDay = d => d.toISOString().slice(0,10);
const at = (d, hour, minute=0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour-5, minute-30)).toISOString(); // Asia/Colombo
const counts = { businesses:1, business_config:1, staff_profiles:4, tills:2, menu_items:menu.length, till_sessions:0, orders:0, order_items:0, order_adjustments:0, paid_in_out_events:0, no_sale_events:0, waste_comp_logs:0 };
const days = [];
let orderNumber = 1;
for (let di=0; di<21; di++) {
  const day = new Date(start); day.setUTCDate(start.getUTCDate()+di);
  const dow = day.getUTCDay();
  const isWeekend = dow === 0 || dow === 6;
  const orderTarget = (isWeekend ? 19 : 13) + (di % 4);
  const isShortage = di === 12;
  const isRefundHeavy = di === 16;
  const cashier = staff[1 + (di % 2)];
  const [session] = await insert('till_sessions', { business_id:business.id, till_id:tills[0].id, staff_id:cashier.id, opened_at:at(day,6,30), opening_float:10000 });
  counts.till_sessions++;
  let cashSales=0, refundsCash=0, paidIn=0, paidOut=0, refunds=0, voids=0;
  const dayOrders=[];
  for (let oi=0; oi<orderTarget; oi++) {
    const item1=menu[(di*3+oi)%menu.length], item2=menu[(di+oi*5+2)%menu.length];
    const qty1=1+(oi%5===0?1:0), hasSecond=oi%3===0;
    const total=Number(item1.price)*qty1+(hasSecond?Number(item2.price):0);
    const payment=oi%5<3?'cash':'card';
    const orderType=['takeaway','dine_in','delivery'][(oi+di)%3];
    const hour=oi<Math.ceil(orderTarget*.55)?7+(oi%4):12+(oi%7);
    const [order]=await insert('orders',{business_id:business.id,till_session_id:session.id,order_number:orderNumber++,status:'completed',payment_method:payment,order_type:orderType,total,created_at:at(day,hour,(oi*7)%60)});
    const rows=[{business_id:business.id,order_id:order.id,menu_item_id:item1.id,qty:qty1,unit_price:Number(item1.price),created_at:order.created_at}];
    if(hasSecond) rows.push({business_id:business.id,order_id:order.id,menu_item_id:item2.id,qty:1,unit_price:Number(item2.price),created_at:order.created_at});
    await insert('order_items',rows); counts.orders++; counts.order_items+=rows.length;
    dayOrders.push({order,payment,total}); if(payment==='cash') cashSales+=total;
  }
  const adjustments=[];
  if (di%6===2 || isRefundHeavy) {
    const targets=isRefundHeavy?dayOrders.slice(1,5):dayOrders.slice(1,2);
    for(const [i,t] of targets.entries()) { const amount=Math.min(t.total, isRefundHeavy?500+i*150:350); const q=await supabase.rpc('record_order_adjustment',{p_order_id:t.order.id,p_type:'refund',p_reason:isRefundHeavy?'Customer quality complaint':'Item returned',p_amount:amount,p_pin:pin}); fail('record refund',q.error); counts.order_adjustments++; refunds++; if(t.payment==='cash') refundsCash+=amount; adjustments.push({type:'refund',amount}); }
  }
  if(di%8===4) { const t=dayOrders.at(-1); const q=await supabase.rpc('record_order_adjustment',{p_order_id:t.order.id,p_type:'void',p_reason:'Duplicate order entered',p_amount:null,p_pin:pin}); fail('record void',q.error); counts.order_adjustments++; voids++; if(t.payment==='cash') cashSales-=t.total; adjustments.push({type:'void',amount:0}); }
  if(di%5===1) { paidOut=1200+(di%3)*250; await insert('paid_in_out_events',{business_id:business.id,till_session_id:session.id,direction:'out',amount:paidOut,reason:'Local produce purchase',logged_by:cashier.name,timestamp:at(day,14)}); counts.paid_in_out_events++; }
  if(di%9===3) { paidIn=2000; await insert('paid_in_out_events',{business_id:business.id,till_session_id:session.id,direction:'in',amount:paidIn,reason:'Change float top-up',logged_by:cashier.name,timestamp:at(day,10)}); counts.paid_in_out_events++; }
  if(di%4===0) { await insert('no_sale_events',{business_id:business.id,till_session_id:session.id,logged_by:cashier.name,timestamp:at(day,15)}); counts.no_sale_events++; }
  if(di%3===1) { await insert('waste_comp_logs',{business_id:business.id,menu_item_id:menu[(di+6)%menu.length].id,qty:1,reason_code:di%2?'damaged':'quality',logged_by:cashier.name,timestamp:at(day,18)}); counts.waste_comp_logs++; }
  const expected=10000+cashSales+paidIn-paidOut-refundsCash;
  const variance=isShortage?-4800:[-120,-50,0,40,75][di%5];
  const closed=await supabase.rpc('close_till_session',{p_session_id:session.id,p_counted:expected+variance,p_pin:pin}); fail('close till session',closed.error);
  const actual=closed.data;
  if(Math.abs(Number(actual.expected_cash)-expected)>.001 || Math.abs(Number(actual.variance)-variance)>.001) throw new Error(`Reconciliation mismatch on ${isoDay(day)}: expected ${expected}/${variance}, DB returned ${actual.expected_cash}/${actual.variance}`);
  days.push({date:isoDay(day),orders:orderTarget,refunds,voids,expected_cash:expected,counted_cash:expected+variance,variance,anomaly:isShortage?'big_shortage':isRefundHeavy?'refund_heavy':null});
}

const report={schema_version:1,generated_at:new Date().toISOString(),staging_project_ref:ref,business_id:business.id,business_name:business.name,owner:{email,user_id:user.id,password_included:false},date_range:{start:isoDay(start),end:isoDay(today),days:21},anomaly_dates:{big_shortage:days.find(d=>d.anomaly==='big_shortage').date,refund_heavy:days.find(d=>d.anomaly==='refund_heavy').date},counts,reconciliation:{sessions_checked:days.length,mismatches:0,total_expected_cash:days.reduce((n,d)=>n+d.expected_cash,0),total_counted_cash:days.reduce((n,d)=>n+d.counted_cash,0),total_variance:days.reduce((n,d)=>n+d.variance,0)},days};
await fs.writeFile(path.join(DIR,'seed-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Seeded ${business.name}\nBusiness ID: ${business.id}\nOwner email: ${email}\nPassword: not printed\nReport: ${path.join(DIR,'seed-report.json')}`);
