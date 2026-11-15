// Party Trivia server — no installs needed, just Node.js.
// Start it with:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const QRCode = require('./qrcode.js');
const QRErrorCorrectLevel = QRCode.ErrorCorrectLevel;

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SAVE_FILE = path.join(ROOT, 'game-save.json');
const HOST_KEY = process.env.HOST_KEY || String(Math.floor(1000 + Math.random() * 9000));
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 150;
const READ_MS = 3000;          // time to read the question before answers open

// ---------- questions ----------
const QUIZ = JSON.parse(fs.readFileSync(path.join(ROOT, 'questions.json'), 'utf8'));
const QUESTIONS = QUIZ.questions;
const LIMIT_MS = (Number(QUIZ.secondsPerQuestion) || 20) * 1000;
QUESTIONS.forEach((q, i) => {
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4)
    throw new Error(`Question ${i + 1} needs 2 to 4 options`);
  if (!(q.correct >= 0 && q.correct < q.options.length))
    throw new Error(`Question ${i + 1} has a "correct" number that doesn't match an option (0 = first option)`);
});

// ---------- game state ----------
// phase: lobby | question | reveal | leaderboard | final   (live game, host moves everyone together)
//        open                                              (all-night mode: everyone plays at their own pace)
let game = freshGame();
// pid -> { name, score, streak, answers: { [qIndex]: {choice, points, correct, ms} }, spQ, spAt }
//   spQ = next question this player will see in all-night mode; spAt = when its timer started (0 = not started)
const players = new Map();
let revealTimer = null;

function freshGame() {
  return { phase: 'lobby', mode: 'live', qIndex: -1, openAt: 0, endAt: 0 };
}

function loadSave() {
  try {
    const s = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    for (const [pid, p] of Object.entries(s.players || {})) players.set(pid, p);
    game = s.game || freshGame();
    // If the laptop restarted mid-question, park on the leaderboard so the host can carry on.
    if (game.phase === 'question' || game.phase === 'reveal') {
      const q = game.qIndex;
      for (const p of players.values()) if (!p.answers[q]) p.answers[q] = { choice: null, points: 0, correct: false };
      game.phase = 'leaderboard';
    }
    console.log(`  Restored saved game: ${players.size} players, question ${game.qIndex + 1}.`);
  } catch (_) { /* no save yet */ }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { game, players: Object.fromEntries(players) };
    fs.writeFile(SAVE_FILE, JSON.stringify(data), () => {});
  }, 300);
}

function ranked() {
  const list = [...players.entries()].map(([pid, p]) => ({ pid, name: p.name, score: p.score, streak: p.streak }));
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let lastScore = null, lastRank = 0;
  list.forEach((p, i) => {
    p.rank = p.score === lastScore ? lastRank : i + 1;
    lastScore = p.score; lastRank = p.rank;
  });
  return list;
}

function award(p, correct, elapsedMs) {
  let points = 0;
  if (correct) {
    const t = Math.min(1, Math.max(0, elapsedMs / LIMIT_MS));
    p.streak += 1;
    points = Math.round(1000 * (1 - t / 2)) + Math.min(500, 100 * (p.streak - 1));
    p.score += points;
  } else {
    p.streak = 0;
  }
  return points;
}

function review(p) {
  return QUESTIONS.map((Q, i) => {
    const a = p.answers[i];
    return { text: Q.question, options: Q.options, correct: Q.correct, choice: a ? a.choice : null, points: a ? a.points : 0 };
  });
}

function answerCounts(q) {
  const counts = QUESTIONS[q].options.map(() => 0);
  for (const p of players.values()) {
    const a = p.answers[q];
    if (a && a.choice !== null && a.choice !== undefined) counts[a.choice]++;
  }
  return counts;
}

function answeredCount(q) {
  let n = 0;
  for (const p of players.values()) if (p.answers[q] && p.answers[q].choice !== null) n++;
  return n;
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();   // { res, pid, host }

function publicState(now) {
  const q = game.qIndex;
  const Q = QUESTIONS[q];
  const st = {
    title: QUIZ.title, subtitle: QUIZ.subtitle,
    phase: game.phase, mode: game.mode || 'live', qIndex: q, total: QUESTIONS.length,
    playerCount: players.size,
    serverNow: now,
  };
  if (game.phase === 'open') {
    st.limitMs = LIMIT_MS;
    st.finished = [...players.values()].filter(p => (p.spQ || 0) >= QUESTIONS.length).length;
  }
  if (Q && game.phase !== 'lobby' && game.phase !== 'open') {
    st.question = { round: Q.round, text: Q.question, options: Q.options };
    st.limitMs = LIMIT_MS;
  }
  if (game.phase === 'question') {
    st.openInMs = Math.max(0, game.openAt - now);
    st.remainingMs = Math.max(0, game.endAt - now);
    st.answered = answeredCount(q);
  }
  if (game.phase === 'reveal') {
    st.correct = Q.correct;
    st.counts = answerCounts(q);
    st.answered = answeredCount(q);
  }
  if (game.phase === 'reveal' || game.phase === 'leaderboard' || game.phase === 'final') {
    st.top = ranked().slice(0, 10).map(({ name, score, rank, streak }) => ({ name, score, rank, streak }));
  }
  return st;
}

function personal(st, pid, rankList) {
  const p = players.get(pid);
  if (!p) return { ...st, you: null };
  const me = rankList.find(r => r.pid === pid);
  const idx = rankList.indexOf(me);
  const ahead = idx > 0 ? rankList[idx - 1] : null;
  const you = { name: p.name, score: p.score, streak: p.streak, rank: me.rank };
  if (ahead && ahead.score > p.score) you.behind = { name: ahead.name, gap: ahead.score - p.score };
  if (game.phase === 'open') {
    const q = p.spQ || 0;
    const sp = { q, done: q >= QUESTIONS.length, started: !!p.spAt };
    if (!sp.done) {
      const Q = QUESTIONS[q];
      sp.question = { round: Q.round, text: Q.question, options: Q.options };
      if (p.spAt) sp.remainingMs = Math.max(0, p.spAt + LIMIT_MS - Date.now());
    }
    you.sp = sp;
  }
  if (game.phase === 'final') {
    you.review = review(p);
    you.right = Object.values(p.answers).filter(a => a.correct).length;
  }
  const a = game.phase === 'open' ? null : p.answers[game.qIndex];
  if (a) you.answer = { choice: a.choice, ...(game.phase !== 'question' ? { points: a.points, correct: a.correct } : {}) };
  return { ...st, you };
}

function hostState(st) {
  const list = ranked();
  return {
    ...st,
    host: true,
    players: list.map(({ pid, name, score }) => ({ id: pid.slice(0, 8), name, score, done: Math.min(players.get(pid).spQ || 0, QUESTIONS.length) })),
    correct: (game.phase === 'question' || game.phase === 'reveal') ? QUESTIONS[game.qIndex].correct : st.correct,
    counts: game.qIndex >= 0 ? answerCounts(game.qIndex) : undefined,
  };
}

// Coalesce bursts (e.g. 50 answers landing at once) into at most ~5 updates a second.
let broadcastQueued = false, lastBroadcast = 0;
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  const wait = Math.max(0, 200 - (Date.now() - lastBroadcast));
  setTimeout(() => {
    broadcastQueued = false;
    lastBroadcast = Date.now();
    const now = Date.now();
    const st = publicState(now);
    const rankList = ranked();
    const hostMsg = 'data: ' + JSON.stringify(hostState(st)) + '\n\n';
    for (const c of clients) {
      try {
        c.res.write(c.host ? hostMsg : 'data: ' + JSON.stringify(personal(st, c.pid, rankList)) + '\n\n');
      } catch (_) { clients.delete(c); }
    }
  }, wait);
}

setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (_) { clients.delete(c); } } }, 15000);

// ---------- game actions ----------
function startQuestion(i) {
  clearTimeout(revealTimer);
  const now = Date.now();
  game = { phase: 'question', qIndex: i, openAt: now + READ_MS, endAt: now + READ_MS + LIMIT_MS };
  revealTimer = setTimeout(reveal, READ_MS + LIMIT_MS + 300);
  save(); broadcast();
}

function reveal() {
  if (game.phase !== 'question') return;
  clearTimeout(revealTimer);
  const q = game.qIndex;
  for (const p of players.values()) {
    if (!p.answers[q]) p.answers[q] = { choice: null, points: 0, correct: false };
    if (!p.answers[q].correct) p.streak = 0;
  }
  game.phase = 'reveal';
  save(); broadcast();
}

function hostAction(action, body) {
  switch (action) {
    case 'openNight':    // all-night mode: everyone plays at their own pace, results revealed later
      if (game.phase !== 'lobby') return;
      clearTimeout(revealTimer);
      game = { phase: 'open', mode: 'selfpaced', qIndex: -1, openAt: 0, endAt: 0 };
      save(); return broadcast();
    case 'next':
      if (game.phase === 'open') { game.phase = 'final'; save(); return broadcast(); }
      if (game.phase === 'lobby') return startQuestion(0);
      if (game.phase === 'question') return reveal();
      if (game.phase === 'reveal') { game.phase = 'leaderboard'; save(); return broadcast(); }
      if (game.phase === 'leaderboard') {
        if (game.qIndex + 1 < QUESTIONS.length) return startQuestion(game.qIndex + 1);
        game.phase = 'final'; save(); return broadcast();
      }
      return;
    case 'final':
      clearTimeout(revealTimer); game.phase = 'final'; save(); return broadcast();
    case 'restart':      // same players, scores back to zero
      clearTimeout(revealTimer);
      for (const p of players.values()) { p.score = 0; p.streak = 0; p.answers = {}; p.spQ = 0; p.spAt = 0; }
      game = freshGame(); save(); return broadcast();
    case 'reset':        // everyone has to join again
      clearTimeout(revealTimer);
      players.clear(); game = freshGame(); save(); return broadcast();
    case 'kick': {
      for (const pid of players.keys()) if (pid.slice(0, 8) === body.id) players.delete(pid);
      save(); return broadcast();
    }
  }
}

function join(body) {
  let name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) return { status: 400, data: { error: 'Please enter a nickname.' } };
  if (body.pid && players.has(body.pid)) return { status: 200, data: { pid: body.pid, name: players.get(body.pid).name } };
  if (players.size >= MAX_PLAYERS) return { status: 403, data: { error: 'The game is full.' } };
  const taken = new Set([...players.values()].map(p => p.name.toLowerCase()));
  let final = name, n = 2;
  while (taken.has(final.toLowerCase())) final = `${name.slice(0, 13)} ${n++}`;
  const pid = crypto.randomBytes(12).toString('hex');
  // Late joiners simply score 0 on questions they missed.
  players.set(pid, { name: final, score: 0, streak: 0, answers: {}, spQ: 0, spAt: 0 });
  save(); broadcast();
  return { status: 200, data: { pid, name: final } };
}

function answer(body) {
  const p = players.get(body.pid);
  if (!p) return { status: 404, data: { error: 'not-joined' } };
  if (game.phase === 'open') return answerNight(p, body);
  if (game.phase !== 'question') return { status: 409, data: { error: 'Too late!' } };
  const now = Date.now();
  if (now < game.openAt) return { status: 409, data: { error: 'Not open yet' } };
  const q = game.qIndex;
  if (p.answers[q]) return { status: 200, data: { ok: true } };
  const choice = Number(body.choice);
  const Q = QUESTIONS[q];
  if (!(Number.isInteger(choice) && choice >= 0 && choice < Q.options.length)) return { status: 400, data: { error: 'bad choice' } };
  const correct = choice === Q.correct;
  const points = award(p, correct, now - game.openAt);
  p.answers[q] = { choice, points, correct };
  save();
  if (answeredCount(q) >= players.size) setTimeout(reveal, 800);  // everyone's in
  broadcast();
  return { status: 200, data: { ok: true } };
}

// ---------- all-night mode ----------
const GRACE_MS = 2500;   // allowance for slow phone connections

function startNight(body) {
  const p = players.get(body.pid);
  if (!p) return { status: 404, data: { error: 'not-joined' } };
  if (game.phase !== 'open') return { status: 409, data: { error: 'not open' } };
  if ((p.spQ || 0) < QUESTIONS.length && !p.spAt) { p.spAt = Date.now(); save(); broadcast(); }
  return { status: 200, data: { ok: true } };
}

function answerNight(p, body) {
  const q = p.spQ || 0;
  if (q >= QUESTIONS.length) return { status: 200, data: { ok: true, done: true } };
  if (Number(body.q) !== q) return { status: 200, data: { ok: true } };   // duplicate / stale tap
  if (!p.spAt) return { status: 409, data: { error: 'not started' } };
  const Q = QUESTIONS[q];
  const elapsed = Date.now() - p.spAt;
  let choice = Number(body.choice);
  if (!(Number.isInteger(choice) && choice >= 0 && choice < Q.options.length) || elapsed > LIMIT_MS + GRACE_MS) choice = null;
  const correct = choice !== null && choice === Q.correct;
  const points = award(p, correct, Math.min(elapsed, LIMIT_MS));
  p.answers[q] = { choice, points, correct, ms: Math.min(elapsed, LIMIT_MS) };
  p.spQ = q + 1; p.spAt = 0;
  save(); broadcast();
  return { status: 200, data: { ok: true, done: p.spQ >= QUESTIONS.length } };
}

// If the online host restarts during all-night mode, phones re-send what they already answered.
function restoreNight(body) {
  if (game.phase !== 'open') return { status: 409, data: { error: 'not open' } };
  const pid = String(body.pid || '');
  if (!/^[a-f0-9]{24}$/.test(pid)) return { status: 400, data: { error: 'bad id' } };
  if (players.has(pid)) return { status: 200, data: { ok: true } };
  if (players.size >= MAX_PLAYERS) return { status: 403, data: { error: 'The game is full.' } };
  let name = String(body.name || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
  const taken = new Set([...players.values()].map(x => x.name.toLowerCase()));
  let final = name, n = 2;
  while (taken.has(final.toLowerCase())) final = `${name.slice(0, 13)} ${n++}`;
  const p = { name: final, score: 0, streak: 0, answers: {}, spQ: 0, spAt: 0 };
  const log = Array.isArray(body.log) ? body.log.slice(0, QUESTIONS.length) : [];
  for (const e of log) {
    const q = p.spQ;
    if (Number(e.q) !== q) break;
    const Q = QUESTIONS[q];
    const choice = Number.isInteger(e.choice) && e.choice >= 0 && e.choice < Q.options.length ? e.choice : null;
    const ms = Math.min(LIMIT_MS, Math.max(0, Number(e.ms) || LIMIT_MS));
    const correct = choice !== null && choice === Q.correct;
    p.answers[q] = { choice, points: award(p, correct, ms), correct, ms };
    p.spQ = q + 1;
  }
  players.set(pid, p);
  save(); broadcast();
  return { status: 200, data: { ok: true, name: final } };
}

// ---------- helpers ----------
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  // Prefer typical home Wi-Fi ranges first
  const score = a => a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : a.address.startsWith('172.') ? 2 : 3;
  return out.sort((a, b) => score(a) - score(b));
}

// When the game is hosted online (e.g. Render), the join link is the site's own public address.
// When it runs on a laptop, it's the laptop's Wi-Fi address.
function joinUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  const h = req && String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (h && !/^(localhost|127\.|\[?::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    return `${proto}://${h}`;
  }
  const a = lanAddresses()[0];
  return `http://${a ? a.address : 'localhost'}:${PORT}`;
}
const ONLINE = !!(process.env.RENDER || process.env.PUBLIC_URL);

function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), m = 2, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hostAllowed(req, url, body) {
  if (isLocal(req)) return true;
  const key = (body && body.key) || url.searchParams.get('key');
  return key === HOST_KEY;
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
  });
}

const STATIC = {
  '/': ['play.html', 'text/html; charset=utf-8'],
  '/host': ['host.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function csv() {
  const rows = [['Place', 'Name', 'Score', 'Correct answers']];
  for (const r of ranked()) {
    const p = players.get(r.pid);
    const right = Object.values(p.answers).filter(a => a.correct).length;
    rows.push([r.rank, r.name, r.score, right]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, file)).pipe(res);
  }

  if (req.method === 'HEAD' && p === '/events') {
    res.writeHead(url.searchParams.get('host') === '1' && !hostAllowed(req, url) ? 403 : 200);
    return res.end();
  }

  if (req.method === 'GET' && p === '/events') {
    const host = url.searchParams.get('host') === '1';
    if (host && !hostAllowed(req, url)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    const c = { res, host, pid: url.searchParams.get('pid') || '' };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return broadcast();
  }

  if (req.method === 'GET' && p === '/qr.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(qrSvg(joinUrl(req)));
  }

  if (req.method === 'GET' && p === '/info') {
    return send(res, 200, { online: ONLINE, joinUrl: joinUrl(req), all: lanAddresses().map(a => `http://${a.address}:${PORT}`) });
  }

  if (req.method === 'GET' && p === '/results.csv') {
    if (!hostAllowed(req, url)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="trivia-results.csv"' });
    return res.end('﻿' + csv());
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (p === '/api/join') { const r = join(body); return send(res, r.status, r.data); }
    if (p === '/api/answer') { const r = answer(body); return send(res, r.status, r.data); }
    if (p === '/api/night/start') { const r = startNight(body); return send(res, r.status, r.data); }
    if (p === '/api/night/restore') { const r = restoreNight(body); return send(res, r.status, r.data); }
    if (p === '/api/ping') return send(res, 200, { ok: true });   // keeps the free online host awake
    if (p === '/api/host') {
      if (!hostAllowed(req, url, body)) return send(res, 403, { error: 'Wrong host code' });
      if (body.action === 'resumeNight') {   // host page saw the server restart during all-night mode
        if (game.phase === 'lobby' && players.size === 0) { game = { phase: 'open', mode: 'selfpaced', qIndex: -1, openAt: 0, endAt: 0 }; save(); broadcast(); }
        return send(res, 200, { ok: true });
      }
      hostAction(String(body.action), body);
      return send(res, 200, { ok: true });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

loadSave();
server.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(60);
  if (ONLINE) {
    console.log(`\n${line}\n  ${QUIZ.title} trivia is running online.\n  Players join at: ${joinUrl()}\n  Host screen: ${joinUrl()}/host   (host code: ${HOST_KEY})\n${line}\n`);
    return;
  }
  const join = joinUrl();
  console.log(`\n${line}\n  ${QUIZ.title} — trivia is running!\n${line}`);
  console.log(`\n  HOST SCREEN (put this on the TV):  http://localhost:${PORT}/host`);
  console.log(`\n  PLAYERS JOIN AT:  ${join}`);
  const others = lanAddresses().slice(1);
  if (others.length) console.log(`     (if that doesn't work, try: ${others.map(a => `http://${a.address}:${PORT}`).join('  or  ')})`);
  console.log(`\n  Host code (only needed to run the game from another device): ${HOST_KEY}`);
  console.log(`\n  Keep this window open during the party. Close it to stop the game.\n${line}\n`);
  if (!process.env.NO_OPEN) {
    const u = `http://localhost:${PORT}/host`;
    const cmd = process.platform === 'darwin' ? `open "${u}"` : process.platform === 'win32' ? `start "" "${u}"` : `xdg-open "${u}"`;
    exec(cmd, () => {});
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log(`\n  Port ${PORT} is busy — the game may already be running in another window.\n`);
  else console.error(e);
  process.exit(1);
});
