'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;

const sessions = new Map();
const ipLoginAttempts = new Map();
const COOKIE_NAME = 'session';
const SESSION_HMAC_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const IS_HTTPS = process.env.NODE_ENV === 'production';

ensureDirectories();
initializeDb();

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/') {
    return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
  }
  if (req.method === 'GET' && pathname === '/admin/login') {
    return serveFile(path.join(PUBLIC_DIR, 'admin', 'login.html'), res);
  }
  if (req.method === 'GET' && pathname === '/admin') {
    const auth = requireAuth(req, res, true);
    if (!auth.ok) return;
    return serveFile(path.join(PUBLIC_DIR, 'admin', 'admin.html'), res);
  }

  if (pathname.startsWith('/uploads/')) {
    return serveStatic(path.join(ROOT, pathname), path.join(ROOT, 'uploads'), res);
  }
  if (pathname.startsWith('/public/')) {
    return serveStatic(path.join(ROOT, pathname), PUBLIC_DIR, res);
  }
  if (pathname.startsWith('/admin/')) {
    return serveStatic(path.join(PUBLIC_DIR, pathname.replace('/admin/', 'admin/')), path.join(PUBLIC_DIR, 'admin'), res);
  }

  if (pathname === '/styles.css' || pathname === '/app.js') {
    return serveFile(path.join(PUBLIC_DIR, pathname.slice(1)), res);
  }

  if (pathname === '/api/public' && req.method === 'GET') {
    return handlePublicState(res);
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return handleLogin(req, res);
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const auth = requireAuth(req, res, false);
    if (!auth.ok) return;
    if (!verifyCsrf(req, res, auth.session)) return;
    sessions.delete(auth.session.id);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/admin/state' && req.method === 'GET') {
    const auth = requireAuth(req, res, false);
    if (!auth.ok) return;
    refreshSession(auth.session, res);
    const db = readDb();
    return sendJson(res, 200, { profile: db.profile, links: db.links, csrfToken: auth.session.csrfToken });
  }
  if (pathname === '/api/admin/profile' && req.method === 'POST') {
    const auth = requireAuth(req, res, false);
    if (!auth.ok) return;
    if (!verifyCsrf(req, res, auth.session)) return;
    return handleUpdateProfile(req, res, auth.session);
  }
  if (pathname === '/api/admin/links' && req.method === 'POST') {
    const auth = requireAuth(req, res, false);
    if (!auth.ok) return;
    if (!verifyCsrf(req, res, auth.session)) return;
    return handleUpdateLinks(req, res, auth.session);
  }
  if (pathname === '/api/admin/upload' && req.method === 'POST') {
    const auth = requireAuth(req, res, false);
    if (!auth.ok) return;
    if (!verifyCsrf(req, res, auth.session)) return;
    return handleUpload(req, res, auth.session);
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

function ensureDirectories() {
  for (const dir of [PUBLIC_DIR, DATA_DIR, UPLOAD_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function initializeDb() {
  let db;
  if (!fs.existsSync(DB_PATH)) {
    db = defaultDb();
  } else {
    db = readDb();
  }

  if (!Array.isArray(db.adminUsers) || db.adminUsers.length === 0) {
    const username = sanitizeUsername(process.env.ADMIN_USER || 'admin');
    const generatedPass = crypto.randomBytes(12).toString('base64url');
    const password = process.env.ADMIN_PASS || generatedPass;
    const { salt, hash } = hashPasswordSync(password);

    db.adminUsers = [{
      id: crypto.randomUUID(),
      username,
      salt,
      hash,
      failedAttempts: 0,
      lockedUntil: 0,
      createdAt: Date.now()
    }];

    writeDb(db);
    if (!process.env.ADMIN_PASS) {
      console.log('Initial admin credentials generated (shown only once):');
      console.log(`ADMIN_USER=${username}`);
      console.log(`ADMIN_PASS=${password}`);
    } else {
      console.log(`Initial admin user created from environment: ${username}`);
    }
  } else {
    writeDb(normalizeDb(db));
  }
}

function defaultDb() {
  return {
    profile: {
      name: 'Meine Linkseite',
      bio: 'Willkommen auf meiner Seite.',
      avatarUrl: '',
      logoUrl: '',
      footerText: 'Danke fürs Vorbeischauen.',
      theme: {
        accent: '#3b82f6',
        background: 'navyGradient'
      }
    },
    links: [],
    adminUsers: []
  };
}

function normalizeDb(db) {
  const base = defaultDb();
  const safe = {
    profile: {
      ...base.profile,
      ...(db.profile || {}),
      theme: { ...base.profile.theme, ...((db.profile || {}).theme || {}) }
    },
    links: Array.isArray(db.links) ? db.links : [],
    adminUsers: Array.isArray(db.adminUsers) ? db.adminUsers : []
  };
  safe.links.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return safe;
}

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return normalizeDb(JSON.parse(raw));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(normalizeDb(db), null, 2));
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function serveStatic(filePath, rootDir, res) {
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(path.normalize(rootDir))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  return serveFile(normalized, res);
}

function serveFile(filePath, res) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return sendJson(res, 404, { error: 'Not found' });

    const ext = path.extname(filePath).toLowerCase();
    const contentType = getContentType(ext);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => sendJson(res, 500, { error: 'Read error' }));
    stream.pipe(res);
  });
}

function getContentType(ext) {
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return map[ext] || 'application/octet-stream';
}

function handlePublicState(res) {
  const db = readDb();
  const links = db.links
    .filter((link) => Boolean(link.isActive))
    .sort((a, b) => Number(a.order) - Number(b.order))
    .map((link) => ({
      id: link.id,
      title: link.title,
      subtitle: link.subtitle,
      url: link.url,
      isFeatured: Boolean(link.isFeatured)
    }));

  return sendJson(res, 200, { profile: db.profile, links });
}

async function handleLogin(req, res) {
  try {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      logAuth(`IP rate limited: ${ip}`);
      return sendJson(res, 429, { error: 'Invalid credentials' });
    }

    const body = await parseJsonBody(req, 1024 * 16);
    const username = sanitizeUsername(body.username || '');
    const password = String(body.password || '');

    if (!username || password.length < 8 || password.length > 128) {
      registerIpFailure(ip);
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    const db = readDb();
    const user = db.adminUsers.find((u) => u.username === username);

    if (!user) {
      registerIpFailure(ip);
      logAuth(`Invalid login for unknown user from ${ip}`);
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    if (Number(user.lockedUntil || 0) > Date.now()) {
      registerIpFailure(ip);
      logAuth(`Locked user login attempt: ${username} from ${ip}`);
      return sendJson(res, 423, { error: 'Invalid credentials' });
    }

    const ok = await verifyPassword(password, user.salt, user.hash);
    if (!ok) {
      user.failedAttempts = Number(user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= 5) {
        user.lockedUntil = Date.now() + 15 * 60 * 1000;
        user.failedAttempts = 0;
      }
      writeDb(db);
      registerIpFailure(ip);
      logAuth(`Invalid password for ${username} from ${ip}`);
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }

    user.failedAttempts = 0;
    user.lockedUntil = 0;
    writeDb(db);
    resetIpFailures(ip);

    const session = createSession(user.id, username);
    setSessionCookie(res, session.id);
    sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 400, { error: 'Invalid request' });
  }
}

function requireAuth(req, res, redirectToLogin) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) {
    if (redirectToLogin) {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/login');
      return res.end();
    }
    sendJson(res, 401, { error: 'Unauthorized' });
    return { ok: false };
  }

  const [sessionId, signature] = String(token).split('.');
  if (!sessionId || !signature || signSessionId(sessionId) !== signature) {
    clearSessionCookie(res);
    if (redirectToLogin) {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/login');
      return res.end();
    }
    sendJson(res, 401, { error: 'Unauthorized' });
    return { ok: false };
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    clearSessionCookie(res);
    if (redirectToLogin) {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/login');
      return res.end();
    }
    sendJson(res, 401, { error: 'Unauthorized' });
    return { ok: false };
  }

  refreshSession(session, res);
  return { ok: true, session };
}

function createSession(userId, username) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = {
    id,
    userId,
    username,
    csrfToken: crypto.randomBytes(24).toString('base64url'),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  };
  sessions.set(id, session);
  return session;
}

function refreshSession(session, res) {
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(session.id, session);
  setSessionCookie(res, session.id);
}

function setSessionCookie(res, sessionId) {
  const signature = signSessionId(sessionId);
  const cookieValue = `${COOKIE_NAME}=${sessionId}.${signature}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${IS_HTTPS ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookieValue);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${IS_HTTPS ? '; Secure' : ''}`);
}

function signSessionId(sessionId) {
  return crypto.createHmac('sha256', SESSION_HMAC_SECRET).update(sessionId).digest('base64url');
}

function parseCookies(cookieHeader) {
  const out = {};
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = val;
  });
  return out;
}

function verifyCsrf(req, res, session) {
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || csrf !== session.csrfToken) {
    sendJson(res, 403, { error: 'Invalid CSRF token' });
    return false;
  }
  return true;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function isRateLimited(ip) {
  const now = Date.now();
  cleanupIpRateLimit(now);
  const state = ipLoginAttempts.get(ip);
  return Boolean(state && state.lockedUntil > now);
}

function registerIpFailure(ip) {
  const now = Date.now();
  const state = ipLoginAttempts.get(ip) || { attempts: [], lockedUntil: 0 };
  state.attempts = state.attempts.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  state.attempts.push(now);
  if (state.attempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    state.lockedUntil = now + RATE_LIMIT_LOCK_MS;
    state.attempts = [];
  }
  ipLoginAttempts.set(ip, state);
}

function resetIpFailures(ip) {
  ipLoginAttempts.delete(ip);
}

function cleanupIpRateLimit(now) {
  for (const [ip, state] of ipLoginAttempts.entries()) {
    const attempts = state.attempts.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    const lockedUntil = state.lockedUntil > now ? state.lockedUntil : 0;
    if (!attempts.length && !lockedUntil) {
      ipLoginAttempts.delete(ip);
    } else {
      ipLoginAttempts.set(ip, { attempts, lockedUntil });
    }
  }
}

function parseJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleUpdateProfile(req, res) {
  try {
    const body = await parseJsonBody(req, 1024 * 64);
    const db = readDb();

    const name = sanitizeText(body.name, 80);
    const bio = sanitizeText(body.bio, 280);
    const footerText = sanitizeText(body.footerText, 140);
    const accent = sanitizeHexColor(body.theme && body.theme.accent);
    const background = body.theme && body.theme.background === 'navyGradient' ? 'navyGradient' : 'navyGradient';

    db.profile = {
      ...db.profile,
      name,
      bio,
      footerText,
      theme: { accent, background }
    };

    writeDb(db);
    sendJson(res, 200, { ok: true, profile: db.profile });
  } catch {
    sendJson(res, 400, { error: 'Invalid profile payload' });
  }
}

async function handleUpdateLinks(req, res) {
  try {
    const body = await parseJsonBody(req, 1024 * 256);
    if (!Array.isArray(body.links)) {
      return sendJson(res, 400, { error: 'Invalid links payload' });
    }

    const nextLinks = [];
    for (let i = 0; i < body.links.length; i += 1) {
      const item = body.links[i] || {};
      const id = typeof item.id === 'string' && item.id.length > 0 ? item.id.slice(0, 64) : crypto.randomUUID();
      const title = sanitizeText(item.title, 60);
      const subtitle = sanitizeText(item.subtitle, 120);
      const url = sanitizeUrl(item.url);
      if (!title || !url) continue;
      nextLinks.push({
        id,
        title,
        subtitle,
        url,
        order: i + 1,
        isActive: Boolean(item.isActive),
        isFeatured: Boolean(item.isFeatured)
      });
    }

    const db = readDb();
    db.links = nextLinks;
    writeDb(db);
    sendJson(res, 200, { ok: true, links: db.links });
  } catch {
    sendJson(res, 400, { error: 'Invalid links payload' });
  }
}

async function handleUpload(req, res) {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return sendJson(res, 400, { error: 'Expected multipart/form-data' });
    }

    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return sendJson(res, 400, { error: 'Missing multipart boundary' });
    const boundary = boundaryMatch[1];

    const bodyBuffer = await readRawBody(req, MAX_UPLOAD_BYTES + 1024 * 50);
    const parts = parseMultipart(bodyBuffer, boundary);

    const fieldPart = parts.find((p) => p.name === 'field');
    const filePart = parts.find((p) => p.name === 'file');
    if (!fieldPart || !filePart || !filePart.filename) {
      return sendJson(res, 400, { error: 'Missing upload fields' });
    }

    const targetField = String(fieldPart.data.toString('utf8')).trim();
    if (!['avatar', 'logo'].includes(targetField)) {
      return sendJson(res, 400, { error: 'Invalid target field' });
    }

    if (filePart.data.length === 0 || filePart.data.length > MAX_UPLOAD_BYTES) {
      return sendJson(res, 400, { error: 'Invalid file size' });
    }

    const detected = detectImageType(filePart.data, filePart.contentType || '');
    if (!detected) return sendJson(res, 400, { error: 'Unsupported image type' });

    const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${detected.ext}`;
    const savePath = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(savePath, filePart.data);

    const fileUrl = `/uploads/${fileName}`;
    const db = readDb();
    if (targetField === 'avatar') db.profile.avatarUrl = fileUrl;
    if (targetField === 'logo') db.profile.logoUrl = fileUrl;
    writeDb(db);

    return sendJson(res, 200, { ok: true, field: targetField, url: fileUrl });
  } catch {
    return sendJson(res, 400, { error: 'Upload failed' });
  }
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(bodyBuffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = bodyBuffer.indexOf(boundaryBuffer);

  while (start !== -1) {
    const next = bodyBuffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
    if (next === -1) break;

    let part = bodyBuffer.slice(start + boundaryBuffer.length, next);
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.length === 0 || part.equals(Buffer.from('--\r\n'))) {
      start = next;
      continue;
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      start = next;
      continue;
    }

    const rawHeaders = part.slice(0, headerEnd).toString('utf8');
    let data = part.slice(headerEnd + 4);
    if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);

    const headers = {};
    rawHeaders.split('\r\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    });

    const contentDisposition = headers['content-disposition'] || '';
    const nameMatch = contentDisposition.match(/name="([^"]+)"/);
    const filenameMatch = contentDisposition.match(/filename="([^"]*)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : '',
      contentType: headers['content-type'] || '',
      data
    });

    start = next;
  }

  return parts;
}

function detectImageType(buffer, declaredMime) {
  const mime = String(declaredMime).toLowerCase();

  const isPng = buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length > 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';

  if (isPng && (mime === 'image/png' || !mime)) return { ext: 'png' };
  if (isJpeg && (mime === 'image/jpeg' || mime === 'image/jpg' || !mime)) return { ext: 'jpg' };
  if (isWebp && (mime === 'image/webp' || !mime)) return { ext: 'webp' };

  if (isPng) return { ext: 'png' };
  if (isJpeg) return { ext: 'jpg' };
  if (isWebp) return { ext: 'webp' };
  return null;
}

function sanitizeText(value, maxLen) {
  const str = String(value || '').trim();
  const clean = str.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.slice(0, maxLen);
}

function sanitizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
}

function sanitizeHexColor(value) {
  const c = String(value || '').trim();
  return /^#([a-fA-F0-9]{6})$/.test(c) ? c : '#3b82f6';
}

function sanitizeUrl(value) {
  try {
    const input = String(value || '').trim();
    if (input.length > 300) return '';
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPassword(password, saltBase64, hashBase64) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(String(saltBase64), 'base64');
    const storedHash = Buffer.from(String(hashBase64), 'base64');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      if (derivedKey.length !== storedHash.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derivedKey, storedHash));
    });
  });
}

function logAuth(message) {
  console.log(`[auth] ${new Date().toISOString()} ${message}`);
}
