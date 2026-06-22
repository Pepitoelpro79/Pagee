const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = 5000;
const ScriptDir = __dirname;
const DataDir = path.join(ScriptDir, 'data');
const DownloadsDir = path.join(ScriptDir, 'downloads');
const isWin = process.platform === 'win32';
const ytdlp = isWin
  ? path.join(ScriptDir, 'yt-dlp.exe')
  : (fs.existsSync(path.join(ScriptDir, 'yt-dlp')) ? path.join(ScriptDir, 'yt-dlp') : 'yt-dlp');
const ffmpeg = isWin
  ? (fs.existsSync(path.join(ScriptDir, 'ffmpeg.exe')) ? path.join(ScriptDir, 'ffmpeg.exe') : 'ffmpeg.exe')
  : (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');

for (const d of [DownloadsDir, DataDir]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

app.use(express.json({ limit: '10mb' }));
app.use(express.static(ScriptDir));

function readJSON(fp, def) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return def; } }
function writeJSON(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }

// ============ AUTH ============
const UsersFile = path.join(DataDir, 'users.json');
const SessionsFile = path.join(DataDir, 'sessions.json');

function getUsers() { return readJSON(UsersFile, []); }
function saveUsers(u) { writeJSON(UsersFile, u); }
function getSessions() { return readJSON(SessionsFile, []); }
function saveSessions(s) { writeJSON(SessionsFile, s); }

function hashPass(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPass(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
function genToken() { return crypto.randomBytes(32).toString('hex'); }

function getUserFromToken(token) {
  const sessions = getSessions();
  const s = sessions.find(s => s.token === token);
  if (!s || (Date.now() - s.createdAt) > 86400000) { // 24h expiry
    if (s) { saveSessions(sessions.filter(x => x.token !== token)); }
    return null;
  }
  const users = getUsers();
  return users.find(u => u.id === s.userId) || null;
}

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4) return res.status(400).json({ error: 'Usuario (3+ chars) y contraseña (4+ chars) requeridos' });
    const users = getUsers();
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Usuario ya existe' });
    const { salt, hash } = hashPass(password);
    const user = { id: crypto.randomUUID(), username, email: email || '', passwordHash: hash, salt, createdAt: Date.now() };
    users.push(user); saveUsers(users);
    const token = genToken();
    const sessions = getSessions();
    sessions.push({ token, userId: user.id, username, createdAt: Date.now() });
    saveSessions(sessions);
    res.json({ token, user: { id: user.id, username, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user || !verifyPass(password, user.salt, user.passwordHash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = genToken();
    const sessions = getSessions();
    sessions.push({ token, userId: user.id, username, createdAt: Date.now() });
    saveSessions(sessions);
    res.json({ token, user: { id: user.id, username, email: user.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.json({ user: null });
  const user = getUserFromToken(auth);
  res.json({ user: user ? { id: user.id, username: user.username, email: user.email, avatar: user.avatar || '' } : null });
});

app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth) { const sessions = getSessions(); saveSessions(sessions.filter(s => s.token !== auth)); }
  res.json({ ok: true });
});

// ============ GOOGLE OAUTH ============
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Credencial requerida' });
    const tokRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!tokRes.ok) return res.status(401).json({ error: 'Token invalido' });
    const info = await tokRes.json();
    if (!info.email) return res.status(401).json({ error: 'Email requerido' });
    const users = getUsers();
    let user = users.find(u => u.email === info.email);
    if (!user) {
      user = { id: crypto.randomUUID(), username: info.name || info.email.split('@')[0], email: info.email, avatar: info.picture || '', googleId: info.sub, createdAt: Date.now() };
      users.push(user); saveUsers(users);
    }
    const sessions = getSessions();
    sessions.forEach(s => { if (s.userId === user.id) { saveSessions(sessions.filter(x => x.token !== s.token)); } });
    const token = genToken();
    sessions.push({ token, userId: user.id, username: user.username, createdAt: Date.now() });
    saveSessions(sessions);
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ HISTORY ============
const HistoryFile = path.join(DataDir, 'history.json');
function getHistory() { return readJSON(HistoryFile, []); }
function addHistory(entry) {
  const h = getHistory();
  const e = { id: crypto.randomUUID(), ...entry, timestamp: Date.now() };
  h.unshift(e);
  if (h.length > 500) h.length = 500;
  writeJSON(HistoryFile, h);
  return e;
}

app.get('/api/history', (req, res) => {
  try {
    const h = getHistory();
    const auth = req.headers.authorization;
    const user = auth ? getUserFromToken(auth) : null;
    const limit = parseInt(req.query.limit) || 50;
    let result = h;
    if (req.query.user && user) result = result.filter(e => e.username === user.username);
    res.json({ history: result.slice(0, limit) });
  } catch (e) { res.json({ history: [], error: e.message }); }
});

app.delete('/api/history', (req, res) => {
  try {
    writeJSON(HistoryFile, []);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ YT-DLP HELPERS ============
const CookieFile = path.join(DataDir, 'cookies.txt');
function getYtdlpArgs(extra = []) {
  const args = [];
  args.push('--extractor-args', 'youtube:player_client=android_embedded,web;skip=webpage');
  args.push('--no-warnings');
  if (isWin) args.push('--cookies-from-browser', 'chrome');
  else if (fs.existsSync(CookieFile)) args.push('--cookies', CookieFile);
  args.push('--socket-timeout', '30');
  return args.concat(extra);
}
function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(ytdlp, getYtdlpArgs(args), { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
function downloadYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(ytdlp, getYtdlpArgs(args), { maxBuffer: 100 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(err.message));
      resolve(stdout);
    });
  });
}
function sanitize(s) { return s.replace(/[\\/:*?"<>|]/g, ''); }
function getUserFromReq(req) {
  const auth = req.headers.authorization;
  return auth ? getUserFromToken(auth) : null;
}

// ============ SEARCH ============
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const max = parseInt(req.query.max) || 10;
    const stdout = await runYtdlp([`ytsearch${max}:${q}`, '--dump-json', '--no-download', '--flat-playlist', '--no-warnings']);
    const results = stdout.trim().split('\n').filter(l => l.trim()).map(line => {
      try { const d = JSON.parse(line); return { id: d.id, title: d.title, url: d.webpage_url || `https://youtube.com/watch?v=${d.id}`, thumbnail: d.thumbnail || `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`, duration: d.duration || 0, channel: d.channel || d.uploader || '', views: d.view_count || 0 }; } catch { return null; }
    }).filter(r => r);
    res.json({ results });
  } catch (e) { res.json({ results: [], error: e.message }); }
});

// ============ INFO ============
app.post('/api/info', async (req, res) => {
  try {
    const url = req.body.url;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const stdout = await runYtdlp(['--dump-json', '--no-warnings', url]);
    const info = JSON.parse(stdout);
    res.json({ id: info.id, title: info.title, duration: info.duration || 0, thumbnail: info.thumbnail, channel: info.channel || info.uploader || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ DOWNLOAD HELPERS ============
async function doDownload(url, fmt) {
  const stdout = await runYtdlp(['--dump-json', '--no-warnings', url]);
  const info = JSON.parse(stdout);
  const title = sanitize(info.title);
  const ext = fmt === 'mp3' ? 'mp3' : 'mp4';
  const outTmpl = path.join(DownloadsDir, `${title}.%(ext)s`);
  let args = ['-o', outTmpl, '--newline'];
  if (fmt === 'mp3') { args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0'); if (fs.existsSync(ffmpeg)) args.push('--ffmpeg-location', ScriptDir); }
  else { args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4'); }
  args.push(url);
  await downloadYtdlp(args);
  let finalFile = path.join(DownloadsDir, `${title}.${ext}`);
  if (!fs.existsSync(finalFile)) {
    const files = fs.readdirSync(DownloadsDir).filter(f => f.startsWith(title));
    if (files.length) finalFile = path.join(DownloadsDir, files[0]);
    else throw new Error('Archivo no encontrado');
  }
  return { filename: path.basename(finalFile), title: info.title, url, thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`, duration: info.duration || 0, channel: info.channel || info.uploader || '' };
}

function trackDownload(result, fmt, user) {
  try { addHistory({ filename: result.filename, title: result.title, url: result.url || '', thumbnail: result.thumbnail || '', duration: result.duration || 0, channel: result.channel || '', format: fmt || 'mp3', userId: user?.id || null, username: user?.username || 'anonymous', userAvatar: user?.avatar || '' }); } catch {}
}

// ============ DOWNLOAD SINGLE ============
app.post('/api/download', async (req, res) => {
  try {
    const url = req.body.url; const fmt = req.body.format || 'mp3';
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const result = await doDownload(url, fmt);
    const user = getUserFromReq(req);
    trackDownload(result, fmt, user);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AUTO-DOWNLOAD ============
app.post('/api/auto-download', async (req, res) => {
  try {
    const query = req.body.query; const fmt = req.body.format || 'mp3';
    if (!query) return res.status(400).json({ error: 'Query requerida' });
    const searchOut = await runYtdlp([`ytsearch1:${query}`, '--dump-json', '--no-download', '--no-warnings']);
    const line = searchOut.trim().split('\n').filter(l => l.trim())[0];
    if (!line) return res.status(404).json({ error: 'No se encontró la canción' });
    const info = JSON.parse(line);
    const url = info.webpage_url || `https://youtube.com/watch?v=${info.id}`;
    const result = await doDownload(url, fmt);
    result.query = query;
    const user = getUserFromReq(req);
    trackDownload(result, fmt, user);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ MULTI-DOWNLOAD ============
app.post('/api/multi-download', async (req, res) => {
  try {
    const queries = req.body.queries; const fmt = req.body.format || 'mp3';
    if (!queries || !queries.length) return res.status(400).json({ error: 'Queries requeridas' });
    const user = getUserFromReq(req);
    const results = [];
    for (const query of queries) {
      try {
        const searchOut = await runYtdlp([`ytsearch1:${query}`, '--dump-json', '--no-download', '--no-warnings']);
        const line = searchOut.trim().split('\n').filter(l => l.trim())[0];
        if (!line) { results.push({ query, error: 'No encontrado' }); continue; }
        const info = JSON.parse(line);
        const url = info.webpage_url || `https://youtube.com/watch?v=${info.id}`;
        const result = await doDownload(url, fmt);
        results.push({ query, filename: result.filename, title: result.title, ok: true, url });
        trackDownload(result, fmt, user);
        console.log(`[OK] Multi: ${result.filename}`);
      } catch (e) { results.push({ query, error: e.message }); }
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ FILES ============
app.get('/api/files/:filename', (req, res) => {
  const fname = req.params.filename;
  const fpath = path.join(DownloadsDir, fname);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'No encontrado' });
  const ext = path.extname(fname).toLowerCase();
  const mime = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4' };
  res.set('Content-Type', mime[ext] || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${fname}"`);
  res.sendFile(fpath);
});

// ============ PREVIEW ============
app.get('/api/preview-audio', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const stdout = await runYtdlp(['-g', '-f', 'bestaudio[ext=m4a]/bestaudio', '--no-warnings', url]);
    const audioUrl = stdout.trim().split('\n')[0];
    if (!audioUrl) return res.status(500).json({ error: 'No se pudo obtener audio' });
    res.redirect(audioUrl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI ASSISTANT ============
const GEMINI_KEY = process.env.GEMINI_KEY;
const MODELS = {
  'flash-lite': { api: 'gemini-2.0-flash-lite', label: 'Flash Lite', desc: 'Rapido, respuestas inmediatas', temp: 0.7, tokens: 300 },
  'flash': { api: 'gemini-2.0-flash', label: 'Flash', desc: 'Balanceado, uso general', temp: 0.8, tokens: 500 },
  'pro': { api: 'gemini-2.5-pro', label: 'Pro (Razonamiento)', desc: 'Maxima precision con razonamiento', temp: 0.4, tokens: 1200 },
  'pro-code': { api: 'gemini-2.5-pro', label: 'Pro Code', desc: 'Programacion con razonamiento', temp: 0.15, tokens: 4096 }
};

app.post('/api/ai/chat', async (req, res) => {
  try {
    const message = req.body.message || ''; const history = req.body.history || []; const modelId = req.body.model || 'flash';
    if (!message.trim()) return res.json({ reply: 'Dime en que puedo ayudarte.' });
    const lower = message.toLowerCase();
    const dlPhrases = ['descarga', 'descargar', 'baja', 'download', 'downloadea', 'bajame'];
    const hasDlIntent = dlPhrases.some(p => lower.includes(p));
    const hasUrl = lower.includes('https://') || lower.includes('http://');
    if (hasDlIntent && !hasUrl) {
      let songQuery = message.replace(new RegExp(dlPhrases.join('|'), 'gi'), '').trim();
      songQuery = songQuery.replace(/^(la cancion|esta cancion|esta musica|la musica|las siguientes|esta playlist|esto)\s*/i, '').trim();
      if (songQuery.length > 2) return res.json({ reply: `Buscando y descargando "${songQuery}"...`, action: 'auto_download', query: songQuery });
    }
    if (hasDlIntent && hasUrl) { const u = message.match(/https?:\/\/[^\s]+/); if (u) return res.json({ reply: 'En MP3 o MP4?', action: 'confirm_download', url: u[0] }); }
    try {
      const geminiReply = await queryGemini(message, history, modelId);
      if (geminiReply.startsWith('SEARCH::')) { const q = geminiReply.replace('SEARCH::', '').trim(); if (q) return res.json({ reply: `Buscando "${q}"...`, action: 'search', query: q }); }
      if (geminiReply.startsWith('DOWNLOAD::')) { const q = geminiReply.replace('DOWNLOAD::', '').trim(); if (q) return res.json({ reply: `Descargando "${q}"...`, action: 'auto_download', query: q }); }
      if (geminiReply.startsWith('MULTI_DOWNLOAD::')) { const multi = geminiReply.replace('MULTI_DOWNLOAD::', '').trim().split(',').map(s => s.trim()).filter(s => s); if (multi.length > 0) return res.json({ reply: `Descargando ${multi.length} canciones...`, action: 'multi_download', queries: multi }); }
      return res.json({ reply: geminiReply, action: 'chat' });
    } catch (e) { console.error('[-] Gemini:', e.message); }
    const searchWords = ['busca', 'encuentra', 'recomienda', 'rock', 'pop', 'rap', 'reguet', 'bachata', 'salsa', 'electr', 'jazz', 'metal', 'trap', 'cumbia', 'punk', 'reggae', 'blues', 'hip hop'];
    if (searchWords.some(w => lower.includes(w))) { let q = message.replace(/^(busca|encuentra|recomienda|sugiere|quiero|pon|toca|ponme)\s*/i, '').trim(); q = q.replace(/^musica\s+(de|para)\s+/i, '').replace(/^canciones?\s+(de|para)\s+/i, '').trim(); if (q.length > 1) return res.json({ reply: `Buscando "${q}"...`, action: 'search', query: q }); }
    if (['hola', 'buenas', 'que tal', 'como estas', 'buenos dias', 'hey', 'hello'].some(g => lower.includes(g))) { const gs = ['Hola! Como estas? Soy tu asistente musical. En que puedo ayudarte?', 'Hey! Dime que musica te gusta y te ayudo a encontrar lo que buscas.', 'Hola! Listo para ayudarte con musica, busquedas o descargas.']; return res.json({ reply: gs[Math.floor(Math.random() * gs.length)], action: 'chat' }); }
    const fs = ['Puedo ayudarte con musica, busquedas y descargas. Que necesitas?', 'Dime un artista, cancion o genero y lo busco.', 'Quieres descargar musica? Di "descarga [nombre de la cancion]".', 'Estoy aqui para ayudarte con musica. Que se te ofrece?'];
    res.json({ reply: fs[Math.floor(Math.random() * fs.length)], action: 'chat' });
  } catch (e) { res.json({ reply: 'Disculpa, hubo un error.' }); }
});

app.get('/api/models', (req, res) => { res.json({ models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, desc: m.desc })) }); });

async function queryGemini(message, history, modelId = 'flash') {
  const modelCfg = MODELS[modelId] || MODELS.flash; const modelName = modelCfg.api;
  const systemInstruction = `Eres un asistente musical versatil e inteligente en español. Tu personalidad: amigable, entusiasta, conversacional. Puedes hablar de cualquier tema relacionado a musica.
REGLAS: 1. Si te PIDE BUSCAR musica → responde SOLO "SEARCH:: <termino>" 2. Si te PIDE DESCARGAR una cancion → "DOWNLOAD:: <nombre>" Varias → "MULTI_DOWNLOAD:: <can1>, <can2>" 3. Si SOLO QUIERE CONVERSAR → responde naturalmente, max 4 oraciones.`;
  const contents = history.slice(-10).map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content.replace(/^(SEARCH|DOWNLOAD|MULTI_DOWNLOAD)::/g, '') }] }));
  contents.push({ role: 'user', parts: [{ text: message }] });
  const body = { contents, systemInstruction: { parts: [{ text: systemInstruction }] }, generationConfig: { temperature: modelCfg.temp, maxOutputTokens: modelCfg.tokens, topP: 0.92 } };
  if (modelId === 'pro') body.thinkingConfig = { type: 'ENABLED' };
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); continue; }
      if (!response.ok) { if (attempt < 2 && response.status >= 500) { await new Promise(r => setTimeout(r, 1000)); continue; } throw new Error(`Gemini ${response.status}`); }
      const data = await response.json(); const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply && reply.trim().length > 1) return reply.trim();
    } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error('Respuesta vacia');
}

// ============ PROGRAMMING AI ============
app.post('/api/ai/program', async (req, res) => {
  try {
    const message = req.body.message || ''; const history = req.body.history || []; const lang = req.body.language || 'javascript';
    if (!message.trim()) return res.json({ reply: 'Describe que quieres programar.', code: '', language: lang });
    const systemPrompt = `Eres un ingeniero de software de clase mundial. RAZONAMIENTO: Piensa paso a paso. PRECISION: Codigo sin errores. FORMATO: Usa \`\`\`<lenguaje>...\`\`\`. LENGUAJES: JavaScript, Python, HTML, Java, C++, TypeScript, Go, Rust, SQL, bash. CODIGO: Funcional y listo para copiar.`;
    const contents = history.slice(-6).map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }));
    contents.push({ role: 'user', parts: [{ text: lang && lang !== 'auto' ? `Lenguaje: ${lang}\n\n${message}` : message }] });
    const body = { contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { temperature: 0.15, maxOutputTokens: 4096, topP: 0.95 } };
    const codeModels = ['gemini-2.5-pro', 'gemini-2.0-flash'];
    let reply = '', lastErr = '';
    for (const modelName of codeModels) {
      let ok = false;
      for (let attempt = 0; attempt <= 2; attempt++) {
        const controller = new AbortController(); const toId = setTimeout(() => controller.abort(), 45000);
        try {
          const body2 = { ...body }; if (modelName === 'gemini-2.5-pro') body2.thinkingConfig = { type: 'ENABLED' };
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body2), signal: controller.signal });
          clearTimeout(toId);
          if (response.status === 429) { lastErr = 'API limitado'; if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; } break; }
          if (!response.ok) { lastErr = 'API ' + response.status; if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; } break; }
          const data = await response.json(); const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim().length > 1) { reply = text.trim(); ok = true; break; }
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        } catch (e) { clearTimeout(toId); lastErr = e.name === 'AbortError' ? 'timeout' : e.message; if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; } }
      }
      if (ok) break;
    }
    if (!reply) return res.json({ reply: lastErr === 'API limitado' ? 'Limite de API alcanzado. Espera un momento.' : 'No se pudo generar codigo: ' + lastErr, code: '', language: lang });
    const codeBlocks = []; const codeRegex = /```(\w+)?\s*\n([\s\S]*?)```/g; let match;
    while ((match = codeRegex.exec(reply)) !== null) codeBlocks.push({ language: match[1] || lang, code: match[2].trim() });
    const extractedCode = codeBlocks.length > 0 ? codeBlocks.map(b => b.code).join('\n\n') : '';
    const detectedLang = codeBlocks.length > 0 ? (codeBlocks[0].language || lang) : lang;
    res.json({ reply, code: extractedCode || '', language: detectedLang, blocks: codeBlocks });
  } catch (e) { res.json({ reply: 'Error interno: ' + e.message, code: '', language: (req.body && req.body.language) || 'javascript' }); }
});

// ============ COOKIES UPLOAD ============
app.post('/api/cookies', express.text(), (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'string' || !req.body.trim()) return res.status(400).json({ error: 'Contenido requerido' });
    fs.writeFileSync(CookieFile, req.body, 'utf8');
    res.json({ ok: true, message: 'Cookies guardadas' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/cookies-status', (req, res) => {
  res.json({ hasCookies: fs.existsSync(CookieFile) });
});

// ============ STATIC FILES ============
app.get('*', (req, res) => { if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' }); res.sendFile(path.join(ScriptDir, 'index.html')); });

app.listen(PORT, () => {
  console.log('='.repeat(48));
  console.log('  YouTube Music Hub v5');
  console.log('='.repeat(48));
  console.log(`  http://localhost:${PORT}`);
  console.log('  Auth | Historial | Multi-descarga | IA | Programacion');
  console.log('='.repeat(48));
});
