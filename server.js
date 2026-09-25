#!/usr/bin/env node
/**
 * TeaHack Bot Panel — Pterodactyl-style single-file backend
 * Runtime Node.js / Python3 / Bash. Auto install npm + pip deps.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const BOT_DIR = path.join(__dirname, 'bots');
const LOG_LIMIT = 2000;
if (!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR, { recursive: true });

// ---------- SETUP MODE ----------
const isTermux = fs.existsSync('/data/data/com.termux');
const SETUP_CMDS = isTermux ? [
  'pkg update -y','pkg upgrade -y','pkg install git -y',
  'pkg install python make clang -y','pkg install pkg-config -y',
  'pkg install nodejs-lts git nano -y','pkg install libvips -y',
  'pkg install glib -y','pkg install libjpeg-turbo libpng libwebp -y',
  'pkg install librsvg -y','pkg install fontconfig -y',
  'pkg install termux-api -y','pkg install ffmpeg python -y',
  'pip install -U yt-dlp'
] : [
  'apt-get update -y',
  'apt-get install -y git python3 python3-pip make gcc g++ pkg-config',
  'apt-get install -y libvips-dev libglib2.0-dev libjpeg-dev libpng-dev libwebp-dev',
  'apt-get install -y librsvg2-dev fontconfig ffmpeg',
  'pip3 install -U yt-dlp --break-system-packages || pip3 install -U yt-dlp'
];

if (process.argv.includes('--setup')) {
  console.log('\x1b[36m[setup] Platform: ' + (isTermux ? 'Termux' : 'Debian/Ubuntu') + '\x1b[0m');
  for (const cmd of SETUP_CMDS) {
    console.log('\n\x1b[33m$\x1b[0m ' + cmd);
    try { execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' }); }
    catch (e) { console.error('\x1b[31m[setup] gagal: ' + cmd + '\x1b[0m'); }
  }
  console.log('\n\x1b[32m[setup] Selesai.\x1b[0m');
  process.exit(0);
}

// ---------- BOT MANAGER ----------
const bots = new Map();

function detectRunner(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.js','.mjs','.cjs'].includes(ext)) return { cmd:'node', args:[file], type:'node' };
  if (ext === '.py') return { cmd:'python3', args:['-u', file], type:'python' };
  if (ext === '.sh') return { cmd:'bash', args:[file], type:'shell' };
  return null;
}

function detectNodeDeps(code) {
  const builtins = new Set(['fs','path','os','http','https','url','util','crypto','events','stream','child_process','net','tls','zlib','buffer','assert','querystring','readline','timers','dns','cluster','worker_threads','perf_hooks','v8','vm','module','process','string_decoder','tty','constants','async_hooks','inspector']);
  const deps = new Set();
  const re1 = /require\(\s*['"]([^'".\/][^'"]*)['"]\s*\)/g;
  const re2 = /(?:from|import)\s+['"]([^'".\/][^'"]*)['"]/g;
  let m;
  while ((m = re1.exec(code))) deps.add(m[1]);
  while ((m = re2.exec(code))) deps.add(m[1]);
  return [...deps].map(d => d.replace(/^node:/,'')).filter(d => !builtins.has(d.split('/')[0]))
    .map(d => d.startsWith('@') ? d.split('/').slice(0,2).join('/') : d.split('/')[0]);
}

function detectPythonDeps(code) {
  const stdlib = new Set(['os','sys','re','json','time','datetime','math','random','subprocess','threading','asyncio','urllib','http','socket','io','base64','hashlib','logging','pathlib','collections','itertools','functools','typing','dataclasses','enum','uuid','shutil','glob','tempfile','traceback','warnings','argparse','pickle','csv','sqlite3','xml','html','email','ftplib','smtplib','ssl','select','signal','struct','binascii','codecs','copy','difflib','gc','getpass','inspect','keyword','locale','operator','platform','pprint','queue','statistics','string','textwrap','unittest','venv','webbrowser','multiprocessing','concurrent','contextlib','abc','atexit']);
  const deps = new Set();
  const re = /^\s*(?:import|from)\s+([a-zA-Z_][\w]*)/gm;
  let m;
  while ((m = re.exec(code))) deps.add(m[1]);
  return [...deps].filter(d => !stdlib.has(d));
}

function addLog(name, line, cls='out') {
  const bot = bots.get(name); if (!bot) return;
  bot.logs.push({ line, cls, ts: Date.now() });
  if (bot.logs.length > LOG_LIMIT) bot.logs.shift();
  broadcast({ type:'log', name, line, cls });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

function listBots() {
  return [...bots.entries()].map(([name,b]) => ({
    name, status:b.status, pid:b.pid, type:b.type,
    startTime:b.startTime, exit:b.exit, deps:b.deps,
    mem: b.proc ? getMem(b.pid) : 0
  }));
}

function getMem(pid) {
  try {
    if (process.platform === 'linux') {
      const statm = fs.readFileSync('/proc/' + pid + '/statm','utf-8').split(' ');
      return Math.round(parseInt(statm[1]) * 4096 / 1024 / 1024 * 10) / 10; // MB
    }
  } catch (e) {}
  return 0;
}

// ---------- INSTALL DEPS ----------
async function installDeps(name) {
  const bot = bots.get(name); if (!bot) return true;
  const filePath = path.join(BOT_DIR, name);
  const code = fs.readFileSync(filePath, 'utf-8');

  if (bot.type === 'node') {
    const deps = detectNodeDeps(code);
    bot.deps = deps;
    if (!deps.length) { addLog(name, '\x1b[90m[i] Tidak ada dependency.\x1b[0m','sys'); return true; }
    addLog(name, '\x1b[33m📥 npm install ' + deps.join(' ') + '\x1b[0m','sys');
    bot.status = 'installing'; broadcast({ type:'list', bots:listBots() });
    await new Promise(resolve => {
      const p = spawn('npm',['install','--no-audit','--no-fund','--prefix',BOT_DIR,...deps],{ cwd:BOT_DIR, env:{...process.env} });
      p.stdout.on('data', d => addLog(name, d.toString().trimEnd(),'sys'));
      p.stderr.on('data', d => addLog(name, d.toString().trimEnd(),'sys'));
      p.on('exit', c => {
        addLog(name, c===0 ? '\x1b[32m✓ Dependency OK.\x1b[0m' : '\x1b[31m[!] npm gagal ('+c+')\x1b[0m','sys');
        bot.status='idle'; broadcast({ type:'list', bots:listBots() }); resolve();
      });
    });
    return true;
  }

  if (bot.type === 'python') {
    const deps = detectPythonDeps(code);
    bot.deps = deps;
    if (!deps.length) { addLog(name, '\x1b[90m[i] Tidak ada dependency.\x1b[0m','sys'); return true; }
    addLog(name, '\x1b[33m📥 pip install ' + deps.join(' ') + '\x1b[0m','sys');
    bot.status = 'installing'; broadcast({ type:'list', bots:listBots() });
    await new Promise(resolve => {
      const p = spawn('pip3',['install','--break-system-packages',...deps],{ cwd:BOT_DIR, env:{...process.env} });
      p.stdout.on('data', d => addLog(name, d.toString().trimEnd(),'sys'));
      p.stderr.on('data', d => addLog(name, d.toString().trimEnd(),'sys'));
      p.on('exit', c => {
        addLog(name, c===0 ? '\x1b[32m✓ Dependency OK.\x1b[0m' : '\x1b[31m[!] pip gagal ('+c+')\x1b[0m','sys');
        bot.status='idle'; broadcast({ type:'list', bots:listBots() }); resolve();
      });
    });
    return true;
  }
  return true;
}

// ---------- LIFECYCLE ----------
async function startBot(name) {
  const bot = bots.get(name);
  if (!bot) return { error:'bot tidak ditemukan' };
  if (bot.proc) return { error:'sudah berjalan' };
  const runner = detectRunner(name);
  if (!runner) return { error:'tipe file tidak didukung' };
  bot.type = runner.type;

  await installDeps(name);

  addLog(name, '\x1b[36m▶ Start ' + name + '\x1b[0m','sys');
  const child = spawn(runner.cmd, runner.args, {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME:name, PYTHONUNBUFFERED:'1' }
  });
  bot.proc = child; bot.pid = child.pid;
  bot.startTime = Date.now(); bot.status='running'; bot.exit=null;
  broadcast({ type:'list', bots:listBots() });

  const pipe = (stream, cls) => stream.on('data', d => {
    for (const line of d.toString().split('\n')) if (line.length) addLog(name, line, cls);
  });
  pipe(child.stdout,'out'); pipe(child.stderr,'err');

  child.on('exit', (code,signal) => {
    addLog(name, '\x1b[31m⏹ Exit code=' + code + ' signal=' + (signal||'-') + '\x1b[0m','sys');
    bot.proc=null; bot.pid=null; bot.status='idle';
    bot.exit = { code, signal, at:Date.now() };
    broadcast({ type:'list', bots:listBots() });
  });

  return { success:true, pid:child.pid };
}

function stopBot(name) {
  const bot = bots.get(name);
  if (!bot || !bot.proc) return { error:'tidak berjalan' };
  addLog(name, '\x1b[33m⏹ Stop requested.\x1b[0m','sys');
  try { bot.proc.kill('SIGTERM'); } catch(e){}
  setTimeout(() => { if (bot.proc) try { bot.proc.kill('SIGKILL'); } catch(e){} }, 5000);
  return { success:true };
}

async function restartBot(name) {
  const bot = bots.get(name);
  if (!bot) return { error:'bot tidak ditemukan' };
  if (bot.proc) {
    addLog(name, '\x1b[33m🔄 Restart…\x1b[0m','sys');
    try { bot.proc.kill('SIGTERM'); } catch(e){}
    await new Promise(resolve => {
      const iv = setInterval(() => { if (!bot.proc) { clearInterval(iv); resolve(); } }, 100);
      setTimeout(() => { clearInterval(iv); resolve(); }, 5000);
    });
  }
  return startBot(name);
}

async function deleteBot(name) {
  const bot = bots.get(name); if (!bot) return;
  if (bot.proc) try { bot.proc.kill('SIGKILL'); } catch(e){}
  try { fs.unlinkSync(path.join(BOT_DIR, name)); } catch(e){}
  bots.delete(name); broadcast({ type:'list', bots:listBots() });
}

function registerBot(name) {
  if (bots.has(name)) return;
  const r = detectRunner(name);
  bots.set(name, { proc:null, status:'idle', logs:[], pid:null, startTime:null, exit:null, deps:[], type:r?r.type:'unknown' });
}

for (const f of fs.readdirSync(BOT_DIR)) if (detectRunner(f)) registerBot(f);

// ---------- EXPRESS ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, BOT_DIR),
  filename: (req,file,cb) => cb(null, file.originalname.replace(/[^\w.\-]/g,'_'))
});
const upload = multer({ storage, limits:{ fileSize:500*1024*1024 } });

app.post('/api/upload', upload.array('files', 30), (req,res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error:'no files' });
  const added = [];
  for (const f of req.files) {
    const name = f.filename;
    if (name.endsWith('.zip')) {
      try {
        const zip = new AdmZip(path.join(BOT_DIR, name));
        zip.extractAllTo(BOT_DIR, true);
        fs.unlinkSync(path.join(BOT_DIR, name));
        for (const e of fs.readdirSync(BOT_DIR)) {
          if (detectRunner(e) && !bots.has(e)) { registerBot(e); added.push(e); }
        }
      } catch (e) { return res.status(500).json({ error:'zip gagal: ' + e.message }); }
      continue;
    }
    if (!bots.has(name)) { registerBot(name); added.push(name); }
  }
  broadcast({ type:'list', bots:listBots() });
  res.json({ success:true, added });
});

app.get('/api/bots', (req,res) => res.json(listBots()));
app.get('/api/logs/:name', (req,res) => {
  const bot = bots.get(req.params.name);
  if (!bot) return res.status(404).json({ error:'not found' });
  res.json(bot.logs);
});
app.post('/api/bots/:name/start', async (req,res) => { const r = await startBot(req.params.name); res.status(r.error?400:200).json(r); });
app.post('/api/bots/:name/stop', (req,res) => { const r = stopBot(req.params.name); res.status(r.error?400:200).json(r); });
app.post('/api/bots/:name/restart', async (req,res) => { const r = await restartBot(req.params.name); res.status(r.error?400:200).json(r); });
app.delete('/api/bots/:name', async (req,res) => { await deleteBot(req.params.name); res.json({ success:true }); });

app.get('/', (req,res) => res.type('html').send(PANEL_HTML));
wss.on('connection', ws => ws.send(JSON.stringify({ type:'list', bots:listBots() })));

// ---------- PANEL HTML (Pterodactyl theme) ----------
const PANEL_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TeaHack Panel</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
:root{
  --bg:#0b0c10;--bg-2:#111318;--bg-3:#161a22;--bg-4:#1d222c;
  --border:#232833;--border-2:#2f3746;
  --text:#c7ccd6;--text-dim:#7a8290;--text-mute:#4a5262;
  --blue:#2f7cf6;--blue-hi:#4d92ff;--blue-dim:#1e4d99;
  --green:#4caf50;--red:#e04343;--yellow:#e0a030;--purple:#8c5cf6;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,'Segoe UI',system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column}

.topbar{height:56px;background:var(--bg-2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 18px;gap:16px;flex-shrink:0;box-shadow:0 1px 0 rgba(0,0,0,.3)}
.topbar .brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:600;font-size:14px;letter-spacing:.2px}
.topbar .brand svg{color:var(--blue)}
.topbar .sep{width:1px;height:26px;background:var(--border-2)}
.topbar .stats{display:flex;gap:20px;font-size:11px;color:var(--text-dim)}
.topbar .stats .item{display:flex;align-items:center;gap:6px}
.topbar .stats b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.topbar .right{margin-left:auto;display:flex;gap:10px;align-items:center}
.pill{padding:4px 10px;border-radius:12px;background:var(--bg-3);font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim);border:1px solid var(--border)}
.pill.on{background:rgba(76,175,80,.12);color:var(--green);border-color:rgba(76,175,80,.3)}
.pill.off{background:rgba(224,67,67,.12);color:var(--red);border-color:rgba(224,67,67,.3)}

.layout{flex:1;display:flex;min-height:0}
.sidebar{width:270px;background:var(--bg-2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sb-head{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.sb-head span{font-size:11px;letter-spacing:1px;color:var(--text-dim);text-transform:uppercase;font-weight:600}
.sb-list{flex:1;overflow-y:auto;padding:8px}

.bot{padding:12px 14px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent;transition:.12s;display:flex;align-items:center;gap:12px;position:relative}
.bot:hover{background:var(--bg-3)}
.bot.active{background:var(--bg-3);border-color:var(--blue-dim);box-shadow:inset 2px 0 0 var(--blue)}
.bot .sdot{width:9px;height:9px;border-radius:50%;background:var(--text-mute);flex-shrink:0;position:relative}
.bot .sdot.running{background:var(--green);box-shadow:0 0 10px var(--green)}
.bot .sdot.running::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:1px solid var(--green);opacity:.4;animation:ping 1.5s infinite}
@keyframes ping{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.7);opacity:0}}
.bot .sdot.installing{background:var(--yellow);animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.3}}
.bot .info{flex:1;min-width:0}
.bot .name{font-size:12px;color:#fff;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bot .sub{font-size:10px;color:var(--text-dim);margin-top:3px;font-family:'JetBrains Mono',monospace}
.bot .del{opacity:0;background:transparent;border:none;color:var(--text-mute);cursor:pointer;padding:2px 6px;border-radius:3px;transition:.12s;font-size:12px}
.bot:hover .del{opacity:1}
.bot .del:hover{background:rgba(224,67,67,.15);color:var(--red)}

.main{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
.bar{padding:12px 18px;border-bottom:1px solid var(--border);background:var(--bg-2);display:flex;align-items:center;gap:12px;flex-shrink:0}
.bar .server-name{color:#fff;font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
.bar .server-name .dot{width:8px;height:8px;border-radius:50%;background:var(--text-mute)}
.bar .server-name .dot.running{background:var(--green);box-shadow:0 0 8px var(--green)}
.bar .uuid{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-mute);background:var(--bg-3);padding:3px 8px;border-radius:4px;border:1px solid var(--border)}
.bar .spacer{flex:1}
.power{display:flex;gap:6px}
.pbtn{width:36px;height:36px;border-radius:6px;border:1px solid var(--border-2);background:var(--bg-3);color:var(--text-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;font-size:15px}
.pbtn:hover:not(:disabled){background:var(--bg-4);color:#fff;border-color:var(--blue)}
.pbtn.start:hover:not(:disabled){color:var(--green);border-color:var(--green)}
.pbtn.stop:hover:not(:disabled){color:var(--red);border-color:var(--red)}
.pbtn.restart:hover:not(:disabled){color:var(--yellow);border-color:var(--yellow)}
.pbtn:disabled{opacity:.35;cursor:not-allowed}
.btn{padding:6px 12px;border-radius:5px;border:1px solid var(--border-2);background:var(--bg-3);color:var(--text);cursor:pointer;font-size:11px;font-family:inherit;transition:.15s}
.btn:hover{background:var(--bg-4);border-color:var(--blue)}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.primary:hover{background:var(--blue-hi);border-color:var(--blue-hi)}
.btn.sm{padding:4px 9px;font-size:10px}

.console-wrap{flex:1;display:flex;flex-direction:column;min-height:0;background:#000;position:relative}
.console-head{padding:6px 14px;background:var(--bg-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;font-size:10px;color:var(--text-dim);font-family:'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase}
.console-head .dot{width:10px;height:10px;border-radius:50%}
.console-head .dot.r{background:#ff5f57}
.console-head .dot.y{background:#febc2e}
.console-head .dot.g{background:#28c840}
#term{flex:1;min-height:0}
#term .xterm{height:100%;padding:10px 12px}

.dropzone{padding:14px 18px;background:var(--bg-2);border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
.dropzone.over{background:rgba(47,124,246,.06);border-top-color:var(--blue)}
.dropzone .hint{color:var(--text-dim);font-size:11px;flex:1}
.dropzone .hint b{color:var(--blue)}

.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text-mute);pointer-events:none;text-align:center;padding:20px}
.empty .ico{font-size:42px;opacity:.35}
.empty .t1{color:var(--text-dim);font-size:13px;font-weight:500}
.empty .t2{font-size:11px;max-width:340px;line-height:1.6}

.modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px)}
.modal.on{display:flex}
.modal-box{background:var(--bg-2);border:1px solid var(--border-2);border-radius:8px;padding:22px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.modal-box h3{color:#fff;margin-bottom:10px;font-size:14px}
.modal-box p{color:var(--text-dim);font-size:12px;margin-bottom:18px;line-height:1.6}
.modal-box .row{display:flex;justify-content:flex-end;gap:8px}
.modal-box .btn.danger{background:var(--red);border-color:var(--red);color:#fff}
.modal-box .btn.danger:hover{background:#f05555}

::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:5px}
::-webkit-scrollbar-thumb:hover{background:#3f4858}

@media(max-width:700px){
  .topbar .stats{display:none}
  .sidebar{width:200px}
  .bar{padding:10px 12px;gap:6px}
  .bar .uuid{display:none}
  .dropzone{flex-direction:column;align-items:stretch;gap:8px}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h.01M11 8h6M7 12h.01M11 12h6M7 16h.01M11 16h6"/></svg>
    TeaHack Panel
  </div>
  <div class="sep"></div>
  <div class="stats">
    <div class="item">Bots <b id="statTotal">0</b></div>
    <div class="item">Running <b id="statRunning" style="color:var(--green)">0</b></div>
    <div class="item">RAM <b id="statMem">0 MB</b></div>
    <div class="item">Uptime <b id="statUptime">0s</b></div>
  </div>
  <div class="right"><span class="pill" id="connBadge">connecting</span></div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="sb-head">
      <span>Servers</span>
      <button class="btn sm" id="btnRefresh" title="Refresh">↻</button>
    </div>
    <div class="sb-list" id="botList">
      <div style="padding:24px 16px;text-align:center;color:var(--text-mute);font-size:11px;line-height:1.6">Belum ada server.<br>Upload script di bawah.</div>
    </div>
  </aside>

  <section class="main">
    <div class="bar">
      <div class="server-name">
        <span class="dot" id="activeDot"></span>
        <span id="activeName">Tidak ada server</span>
      </div>
      <span class="uuid" id="activeUuid"></span>
      <div class="spacer"></div>
      <div class="power">
        <button class="pbtn start" id="btnStart" disabled title="Start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <button class="pbtn restart" id="btnRestart" disabled title="Restart">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        </button>
        <button class="pbtn stop" id="btnStop" disabled title="Stop">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
        </button>
      </div>
    </div>

    <div class="console-wrap">
      <div class="console-head">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span style="margin-left:8px">console</span>
      </div>
      <div id="term"></div>
      <div class="empty" id="empty">
        <div class="ico">🖥️</div>
        <div class="t1">Tidak ada server dipilih</div>
        <div class="t2">Upload file <b>.js</b> / <b>.py</b> / <b>.sh</b> / <b>.zip</b> lalu klik Start.</div>
      </div>
    </div>

    <div class="dropzone" id="drop">
      <span class="hint">📦 Drop file bot ke sini, atau <b>klik Upload</b> — dukung .js .py .sh .zip</span>
      <button class="btn primary" id="btnUpload">Upload</button>
      <button class="btn" id="btnExampleJs">Contoh JS</button>
      <button class="btn" id="btnExamplePy">Contoh PY</button>
      <input type="file" id="fileInput" multiple style="display:none">
    </div>
  </section>
</div>

<div class="modal" id="modal">
  <div class="modal-box">
    <h3>Hapus server?</h3>
    <p id="modalText">Yakin?</p>
    <div class="row">
      <button class="btn" id="modalCancel">Batal</button>
      <button class="btn danger" id="modalOk">Hapus</button>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
(function(){
  var term = new Terminal({
    fontFamily:'"JetBrains Mono","Cascadia Code",Consolas,monospace',
    fontSize:12.5,lineHeight:1.35,cursorBlink:true,convertEol:true,scrollback:6000,
    theme:{
      background:'#000000',foreground:'#d4d9e0',cursor:'#2f7cf6',
      black:'#1c1c1c',red:'#e04343',green:'#4caf50',yellow:'#e0a030',
      blue:'#2f7cf6',magenta:'#b26cd6',cyan:'#3fc1c9',white:'#d4d4d4',
      brightBlack:'#5c6370',brightRed:'#ff6b6b',brightGreen:'#6bdc70',
      brightYellow:'#ffc857',brightBlue:'#6ca6ff',brightMagenta:'#d49bff',
      brightCyan:'#6ddce4',brightWhite:'#ffffff'
    }
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  fit.fit();
  window.addEventListener('resize', function(){ try{fit.fit();}catch(e){} });

  var bots = [], active = null, buffers = {};
  var ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host);

  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  function uuid(name){
    var h = 0; for (var i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
    var hex = h.toString(16).padStart(8,'0');
    return hex + '-' + hex.substr(0,4) + '-' + hex.substr(4,4) + '-0000-000000000000';
  }

  function banner(){
    term.writeln('\\x1b[38;5;39m╔══════════════════════════════════════════════╗\\x1b[0m');
    term.writeln('\\x1b[38;5;39m║\\x1b[0m  \\x1b[1;37mTeaHack Panel\\x1b[0m \\x1b[90m— console ready\\x1b[0m            \\x1b[38;5;39m║\\x1b[0m');
    term.writeln('\\x1b[38;5;39m╚══════════════════════════════════════════════╝\\x1b[0m');
    term.writeln('');
    term.writeln('\\x1b[90mRuntime : \\x1b[0mNode.js / Python3 / Bash');
    term.writeln('\\x1b[90mAuto    : \\x1b[0mnpm install · pip install');
    term.writeln('\\x1b[90mUpload  : \\x1b[0m.js .py .sh .zip');
    term.writeln('');
  }

  function printLine(name, line){
    if (name !== active){
      if (!buffers[name]) buffers[name] = [];
      buffers[name].push(line);
      if (buffers[name].length > 3000) buffers[name].shift();
      return;
    }
    term.writeln(line);
  }

  function setActive(name){
    active = name;
    term.clear(); banner();
    var empty = document.getElementById('empty');
    if (name){
      empty.style.display = 'none';
      var buf = buffers[name] || [];
      for (var i=0;i<buf.length;i++) term.writeln(buf[i]);
      term.writeln('');
      term.writeln('\\x1b[38;5;39m~ $\\x1b[0m ' + name);
    } else {
      empty.style.display = 'flex';
    }
    renderList(); updateControls();
    document.getElementById('activeName').textContent = name || 'Tidak ada server';
    document.getElementById('activeUuid').textContent = name ? uuid(name) : '';
    var dot = document.getElementById('activeDot');
    var b = bots.find(function(x){return x.name===active;});
    dot.className = 'dot' + (b && b.status==='running' ? ' running' : '');
  }

  function updateControls(){
    var b = bots.find(function(x){return x.name===active;});
    var running = b && b.status === 'running';
    document.getElementById('btnStart').disabled = !b || running;
    document.getElementById('btnStop').disabled = !b || !running;
    document.getElementById('btnRestart').disabled = !b;
  }

  function renderList(){
    var list = document.getElementById('botList');
    if (!bots.length){
      list.innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--text-mute);font-size:11px;line-height:1.6">Belum ada server.<br>Upload script di bawah.</div>';
      document.getElementById('statTotal').textContent = '0';
      document.getElementById('statRunning').textContent = '0';
      document.getElementById('statMem').textContent = '0 MB';
      return;
    }
    var html = '', running = 0, totalMem = 0;
    for (var i=0;i<bots.length;i++){
      var b = bots[i];
      if (b.status === 'running') running++;
      if (b.mem) totalMem += b.mem;
      var cls = b.status === 'running' ? 'running' : b.status === 'installing' ? 'installing' : '';
      var sub = b.status + (b.pid ? ' · ' + b.pid : '') + (b.mem ? ' · ' + b.mem + 'MB' : '');
      html += '<div class="bot' + (b.name===active?' active':'') + '" data-name="' + esc(b.name) + '">';
      html += '<span class="sdot ' + cls + '"></span>';
      html += '<div class="info"><div class="name">' + esc(b.name) + '</div><div class="sub">' + esc(sub) + '</div></div>';
      html += '<button class="del" data-del="' + esc(b.name) + '" title="Hapus">✕</button>';
      html += '</div>';
    }
    list.innerHTML = html;
    document.getElementById('statTotal').textContent = bots.length;
    document.getElementById('statRunning').textContent = running;
    document.getElementById('statMem').textContent = totalMem.toFixed(1) + ' MB';

    var items = list.querySelectorAll('.bot');
    items.forEach(function(el){
      el.addEventListener('click', function(ev){
        if (ev.target.dataset.del) return;
        setActive(el.dataset.name);
      });
      var del = el.querySelector('[data-del]');
      if (del) del.addEventListener('click', function(ev){
        ev.stopPropagation(); confirmDelete(del.dataset.del);
      });
    });
  }

  async function api(p, m){
    try { var r = await fetch(p, { method:m||'GET' }); return await r.json(); }
    catch(e){ return { error:e.message }; }
  }

  document.getElementById('btnStart').onclick = function(){ if(active) api('/api/bots/'+encodeURIComponent(active)+'/start','POST'); };
  document.getElementById('btnStop').onclick = function(){ if(active) api('/api/bots/'+encodeURIComponent(active)+'/stop','POST'); };
  document.getElementById('btnRestart').onclick = function(){ if(active) api('/api/bots/'+encodeURIComponent(active)+'/restart','POST'); };
  document.getElementById('btnRefresh').onclick = async function(){
    var d = await api('/api/bots');
    if (Array.isArray(d)) { bots = d; renderList(); updateControls(); }
  };

  var fileInput = document.getElementById('fileInput');
  document.getElementById('btnUpload').onclick = function(){ fileInput.click(); };
  fileInput.onchange = function(){ uploadFiles(fileInput.files); fileInput.value=''; };

  var drop = document.getElementById('drop');
  ['dragenter','dragover'].forEach(function(ev){ drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('over');}); });
  ['dragleave','drop'].forEach(function(ev){ drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('over');}); });
  drop.addEventListener('drop', function(e){ if(e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

  async function uploadFiles(files){
    if (!files.length) return;
    var fd = new FormData();
    for (var i=0;i<files.length;i++) fd.append('files', files[i]);
    term.writeln('\\x1b[36m[i] Mengupload ' + files.length + ' file…\\x1b[0m');
    try {
      var r = await fetch('/api/upload',{method:'POST',body:fd});
      var d = await r.json();
      if (d.added && d.added.length){
        term.writeln('\\x1b[32m[✓] Terupload: ' + d.added.join(', ') + '\\x1b[0m');
        if (!active) setActive(d.added[0]);
      } else if (d.error) term.writeln('\\x1b[31m[!] ' + d.error + '\\x1b[0m');
    } catch(e){ term.writeln('\\x1b[31m[!] ' + e.message + '\\x1b[0m'); }
  }

  document.getElementById('btnExampleJs').onclick = function(){
    var c = "import axios from 'axios';\\nconsole.log('[bot] starting…');\\nlet n=0;\\nsetInterval(async()=>{n++;try{const r=await axios.get('https://api.github.com/zen',{timeout:5000});console.log('[bot #'+n+'] '+r.data);}catch(e){console.error('[bot] error:',e.message);}},4000);\\n";
    uploadFiles([new File([c],'example-bot.js',{type:'application/javascript'})]);
  };
  document.getElementById('btnExamplePy').onclick = function(){
    var c = "import requests, time\\nprint('[bot] starting…', flush=True)\\nn=0\\nwhile True:\\n    n+=1\\n    try:\\n        r=requests.get('https://api.github.com/zen',timeout=5)\\n        print(f'[bot #{n}] {r.text}', flush=True)\\n    except Exception as e:\\n        print(f'[bot] error: {e}', flush=True)\\n    time.sleep(4)\\n";
    uploadFiles([new File([c],'example-bot.py',{type:'text/x-python'})]);
  };

  var modal = document.getElementById('modal'), pendingDelete = null;
  function confirmDelete(name){
    pendingDelete = name;
    document.getElementById('modalText').textContent = 'Hapus server "' + name + '"? File akan dihapus permanen.';
    modal.classList.add('on');
  }
  document.getElementById('modalCancel').onclick = function(){ modal.classList.remove('on'); pendingDelete = null; };
  document.getElementById('modalOk').onclick = async function(){
    if (pendingDelete){
      await api('/api/bots/'+encodeURIComponent(pendingDelete),'DELETE');
      delete buffers[pendingDelete];
      if (active === pendingDelete) setActive(null);
    }
    modal.classList.remove('on'); pendingDelete = null;
  };

  ws.onopen = function(){ var e=document.getElementById('connBadge'); e.textContent='online'; e.className='pill on'; };
  ws.onclose = function(){ var e=document.getElementById('connBadge'); e.textContent='offline'; e.className='pill off'; setTimeout(function(){location.reload();},3000); };
  ws.onmessage = function(ev){
    var m = JSON.parse(ev.data);
    if (m.type === 'list'){ bots = m.bots; renderList(); updateControls();
      var b = bots.find(function(x){return x.name===active;});
      var dot = document.getElementById('activeDot');
      if (dot) dot.className = 'dot' + (b && b.status==='running' ? ' running' : '');
    }
    else if (m.type === 'log'){
      var line = m.line;
      if (m.cls === 'err' && line.indexOf('\\x1b') === -1) line = '\\x1b[31m' + line + '\\x1b[0m';
      printLine(m.name, line);
    }
  };

  var t0 = Date.now();
  setInterval(function(){
    var s = Math.floor((Date.now()-t0)/1000);
    var h=Math.floor(s/3600), m=Math.floor(s%3600/60), ss=s%60;
    document.getElementById('statUptime').textContent = (h?h+'h ':'')+(m?m+'m ':'')+ss+'s';
  },1000);

  banner();
})();
</script>
</body>
</html>`;

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(ifaces)) for (const i of ifaces[k]) {
    if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  console.log('\x1b[38;5;39m');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║        TeaHack Panel — RUNNING           ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('\x1b[0m');
  console.log('  Local  : \x1b[32mhttp://localhost:' + PORT + '\x1b[0m');
  ips.forEach(i => console.log('  Network: \x1b[32mhttp://' + i + ':' + PORT + '\x1b[0m'));
  console.log('');
});
