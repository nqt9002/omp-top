import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OmpTopApp } from '../src/top.mjs';
import { readRequestWindow } from '../src/request-windows.mjs';
import { renderWorkspace } from '../src/views.mjs';
import { renderComparison } from '../src/window-view.mjs';
import { stripAnsi, visibleWidth } from '../src/format.mjs';
import { getLocale, setLocale } from '../src/i18n.mjs';
import { parseOptions } from '../src/upgrade-options.mjs';

const now = 1_800_000_000_000, hour = 3600000;
async function flush(){ for(let i=0;i<16;i++) await Promise.resolve(); }
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages(timestamp INTEGER,provider TEXT,model TEXT,agent_type TEXT,folder TEXT,session_file TEXT,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER)');
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)');
  for(const [age,model] of [[.5,'recent-model'],[2,'older-model'],[8,'day-model'],[49,'history-model']]) insert.run(now-age*hour,'p',model,'worker','/project','/session',100,200,0);
  return db;
}
function makeApp(overrides={}) {
  let app,screen='';
  const ui={rows:35,start(){},stop(){},draw(){if(app) screen=stripAnsi(app.render(120,35).join('\n'));}};
  app=new OmpTopApp({ui,...overrides.options,deps:{
    now:()=>now,fetchStats:async()=>({overall:{totalRequests:999},byModel:[]}),loadCacheDiagnostics:async()=>undefined,
    loadRequestWindow:async()=>({available:false}),loadHistoricalQuota:async()=>({payload:undefined}),
    createQuotaRefresh:()=>({cancel(){},run:async()=>{}}),setTimeout:()=>({}),clearTimeout(){},setInterval:()=>({}),clearInterval(){},
    ...overrides.deps,
  }});
  return {app,screen:()=>screen};
}

test('window keys use actual SQLite windows and never fabricate unsupported metrics', async()=>{
  const db=database();
  const {app,screen}=makeApp({deps:{loadRequestWindow:async options=>readRequestWindow(db,options)}});
  const locale=getLocale();
  try {
    await app.refresh();await flush();
    for(const lang of ['en','vi']) {
      setLocale(lang);
      app.handleInput('w');await flush(); // 24 -> 1
      app.handleInput('3');
      assert.match(screen(), /recent-model/);assert.doesNotMatch(screen(), /older-model|day-model/);
      app.handleInput('w');await flush(); // 1 -> 6
      assert.match(screen(), /older-model/);assert.doesNotMatch(screen(), /day-model/);
      app.handleInput('w');await flush(); // 6 -> 24
      assert.match(screen(), /day-model/);
      app.handleInput('v');
      assert.match(screen(), lang==='en'?/observed local records/:/bản ghi cục bộ/);
      app.handleInput('v');
    }
    setLocale('en');
    const result=readRequestWindow(db,{hours:1,now});
    const text=stripAnsi(renderWorkspace('overview',{stats:{...result.stats,windowHours:1},cacheDiagnostics:result.diagnostics,now},116,35).join('\n'));
    assert.match(text,/Error\/latency metrics are not available/);
    assert.match(text,/Errors -/);
    assert.doesNotMatch(text,/Errors 0|0 unhealthy/);
    assert.match(stripAnsi(renderWorkspace('agents',{stats:result.stats},116,35).join('\n')),/\s-\s/);
  } finally {app.dispose();db.close();setLocale(locale);}
});

test('missing 1h data does not substitute a 24h aggregate; stale window response cannot replace newer choice',async()=>{
  const pending=[];
  const {app,screen}=makeApp({deps:{loadRequestWindow:options=>new Promise(resolve=>pending.push({options,resolve}))}});
  try {
    await app.refresh();await flush();
    pending[0].resolve({available:false});await flush();
    app.handleInput('w');await flush();
    app.handleInput('w');await flush();
    const six={available:true,hours:6,stats:{overall:{totalRequests:6},byModel:[{provider:'p',model:'six-hour-model',totalRequests:6}]},diagnostics:undefined};
    pending.find(p=>p.options.hours===6).resolve(six);await flush();
    pending.find(p=>p.options.hours===1).resolve({...six,hours:1,stats:{byModel:[{provider:'p',model:'wrong-window'}]}});await flush();
    app.handleInput('3');assert.match(screen(),/six-hour-model/);assert.doesNotMatch(screen(),/wrong-window/);
    app.handleInput('w');await flush();app.handleInput('w');await flush();
    pending.at(-1).resolve({available:false,hours:1,reason:'No DB'});await flush();
    assert.doesNotMatch(screen(),/six-hour-model|wrong-window|999/);
    assert.match(screen(),/no substitute data/);
  } finally {app.dispose();}
});

test('comparison remains readable in both locales at all target widths and does not invent percent from zero',()=>{
  const locale=getLocale();
  try {
    for(const lang of ['en','vi']) {setLocale(lang);
      for(const width of [76,116,156,236]) {
        const lines=renderComparison({hours:1,result:{available:true,comparison:{available:true,metrics:{totalRequests:{current:5,previous:0,delta:5,percentChange:null}}}}},width);
        assert.ok(lines.every(line=>visibleWidth(line)<=width));
        assert.doesNotMatch(stripAnsi(lines.join('\n')),/Infinity|NaN|\+100%/);
      }
    }
  } finally {setLocale(locale);}
});

test('local notifications default off, require opt-in/new evidence, deduplicate and suppress stale data',async()=>{
  let time=now,bells=0;
  let payload={reports:[{provider:'p',fetchedAt:now,metadata:{accountId:'a'},limits:[{id:'weekly',label:'Weekly',status:'exhausted',amount:{usedFraction:1},window:{resetsAt:now+hour}}]}]};
  const {app,screen}=makeApp({deps:{now:()=>time,notify:()=>bells++,createQuotaRefresh:()=>({cancel(){},run:async(_r,cb)=>cb.onComplete(payload)})}});
  try {
    await app.refresh();await flush();assert.equal(bells,0);
    app.handleInput('n');await app.refresh();await flush();assert.equal(bells,0);
    time+=1000;payload.reports[0].fetchedAt=time;
    await app.refresh();await flush();assert.equal(bells,1);
    await app.refresh();await flush();assert.equal(bells,1);
    app.handleInput('6');assert.match(screen(),/Weekly: exhausted/);
    time+=10*60_000;await app.refresh();await flush();assert.equal(bells,1);
    app.handleInput('n');time+=1000;payload.reports[0].fetchedAt=time;
    await app.refresh();await flush();assert.equal(bells,1);
  } finally {app.dispose();}
  assert.equal(parseOptions([]).notify,false);
  assert.equal(parseOptions(['--notify']).notify,true);
  assert.throws(()=>parseOptions(['upgrade','--notify']));
});

test('startup opt-in does not notify from bootstrap quota history',async()=>{
  let bells=0;
  const payload={reports:[{provider:'p',fetchedAt:now,limits:[{id:'weekly',label:'Weekly',amount:{usedFraction:1},window:{resetsAt:now+hour}}]}]};
  const {app}=makeApp({options:{notify:true},deps:{notify:()=>bells++,loadHistoricalQuota:async()=>({payload}),createQuotaRefresh:()=>({cancel(){},run:async(_r,cb)=>cb.onComplete(payload)})}});
  try {void app.run();await flush();assert.equal(bells,0);} finally {app.dispose();}
});

test('local window freshness uses its own observation time even when OMP synchronization fails',async()=>{
  const db=database();
  const {app}=makeApp({deps:{fetchStats:async()=>{throw new Error('OMP sync failed');},loadRequestWindow:async options=>readRequestWindow(db,options)}});
  try {
    await app.refresh();await flush();
    const text=stripAnsi(app.render(240,60).join('\n'));
    const contextLine=text.split('\n').find(line=>line.includes('SYSTEM CONTEXT'));
    assert.ok(contextLine);
    assert.doesNotMatch(contextLine,/refresh failed|unavailable|not loaded/i);
    assert.match(contextLine,/✓/);
  } finally {app.dispose();db.close();}
});

test('OMP performance remains accessible as a separately labeled aggregate, not a fabricated local-window metric',async()=>{
  const { inspectionEntries } = await import('../src/inspection.mjs');
  const rows=inspectionEntries('models',{
    stats:{byModel:[{provider:'p',model:'m',totalRequests:2}]},
    ompStats:{byModel:[{provider:'p',model:'m',totalRequests:999,errorRate:.25,avgTtft:350,totalCost:8}]},
  });
  const detail=rows[0].detail.join('\n');
  assert.match(detail,/separate from the selected local window/);
  assert.match(detail,/TTFT: 350ms/);
  assert.equal(rows[0].row.errorRate,undefined);
  assert.equal(rows[0].row.totalRequests,2);
});

test('observed local windows do not infer request-rate acceleration from missing hourly buckets',async()=>{
  const { buildOverviewIntelligence } = await import('../src/overview-intelligence.mjs');
  const points=Array.from({length:6},(_,i)=>({timestamp:now-(5-i)*hour,requests:i<3?1:100}));
  const intelligence=buildOverviewIntelligence({now,stats:{windowHours:24,overall:{},byModel:[],timeSeries:points}});
  assert.ok(!intelligence.alerts.some(alert=>alert.kind==='request-spike'));
});
