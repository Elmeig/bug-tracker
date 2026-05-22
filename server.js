// ===== Bug Tracker Server =====
// Run: node server.js
// Dependencies: nodemailer

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{"versions":[],"activeVersionId":null,"activeListId":null}', 'utf8');

// ===== CRYPTO HELPERS =====
const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const ITERATIONS = 100000;
const DIGEST = 'sha512';

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
        crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(`${salt}:${derivedKey.toString('hex')}`);
        });
    });
}

function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        if (!storedHash) return resolve(false);
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return resolve(false);
        crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(derivedKey.toString('hex') === hash);
        });
    });
}

// ===== UNFOLLOW TOKEN HELPERS =====
const UNFOLLOW_SECRET = process.env.UNFOLLOW_SECRET || 'bugtracker-unfollow-secret-key-v1';

function generateUnsubscribeToken(userId, bugId) {
    return crypto.createHmac('sha256', UNFOLLOW_SECRET).update(userId + ':' + bugId).digest('hex');
}

function verifyUnsubscribeToken(userId, bugId, token) {
    const expected = generateUnsubscribeToken(userId, bugId);
    return expected === token;
}

// ===== SESSION TOKENS (persisted to disk so restarts don't kick everyone out) =====
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const sessions = new Map();
// Load existing sessions on startup
try {
    if (fs.existsSync(SESSIONS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        const now = Date.now();
        for (const [token, sess] of Object.entries(raw || {})) {
            if (sess && sess.createdAt && (now - sess.createdAt) < SESSION_MAX_AGE_MS) {
                sessions.set(token, sess);
            }
        }
        console.log('[sessions] loaded ' + sessions.size + ' active session(s) from disk');
    }
} catch (e) {
    console.error('[sessions] failed to load:', e.message);
}

let _sessionWriteTimer = null;
function persistSessions() {
    // Debounce writes so we don't hammer disk on each request
    if (_sessionWriteTimer) clearTimeout(_sessionWriteTimer);
    _sessionWriteTimer = setTimeout(() => {
        try {
            const obj = {};
            for (const [t, s] of sessions.entries()) obj[t] = s;
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
        } catch (e) {
            console.error('[sessions] failed to persist:', e.message);
        }
    }, 500);
}

function createToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        userId: user.id,
        username: user.username,
        role: user.role,
        createdAt: Date.now()
    });
    persistSessions();
    return token;
}

function getSession(token) {
    if (!token) return null;
    const sess = sessions.get(token);
    if (!sess) return null;
    // Expire stale sessions
    if (Date.now() - sess.createdAt > SESSION_MAX_AGE_MS) {
        sessions.delete(token);
        persistSessions();
        return null;
    }
    return sess;
}

function requireAuth(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    return getSession(token);
}

// MIME types for static files
const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function readJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// === WRITE MUTEX — prevents race conditions ===
let _writeQueue = Promise.resolve();
function atomicWrite(filePath, data) {
    _writeQueue = _writeQueue.then(() => {
        return new Promise((resolve, reject) => {
            try {
                backupBeforeWrite(filePath);
                writeJSON(filePath, data);
                resolve();
            } catch (e) { reject(e); }
        });
    });
    return _writeQueue;
}

// === AUTO-BACKUP — max 50 copies in data/backups/ ===
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
function backupBeforeWrite(filePath) {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        if (fs.existsSync(filePath)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const base = path.basename(filePath).replace('.json', '');
            const backupFile = path.join(BACKUP_DIR, base + '_' + ts + '.json');
            fs.copyFileSync(filePath, backupFile);
            const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
            while (files.length > 50) {
                fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
            }
        }
    } catch (_) { /* best-effort */ }
}

// === SPLIT STORE — one file per version ===
function getVersionFile(versionId) {
    return path.join(__dirname, 'data', 'v_' + versionId + '.json');
}

function readVersion(versionId) {
    return readJSON(getVersionFile(versionId)) || { lists: [] };
}

function writeVersionData(versionId, data) {
    atomicWrite(getVersionFile(versionId), data);
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

// ===== SCHEMA VALIDATION (Whitelisting & Typing) =====
// Drafted by @Seggisbot security audit, integrated with tree-walking sanitizer
// for the /api/store giant-tree-sync architecture.
function validateSchema(data, schema) {
    const result = {};
    const droppedKeys = [];
    for (const key of Object.keys(data || {})) {
        if (!schema[key]) droppedKeys.push(key);
    }
    if (droppedKeys.length > 0) {
        console.warn(`[SchemaWarn] Dropped unknown keys: ${droppedKeys.join(', ')}`);
    }

    const norm = (s) => (s !== undefined && s !== null ? String(s) : '').trim();

    for (const [key, rules] of Object.entries(schema)) {
        if (data && data[key] !== undefined) {
            let val = data[key];
            if (rules.type === 'string') {
                val = norm(val);
                if (rules.maxLength && val.length > rules.maxLength) {
                    val = val.substring(0, rules.maxLength);
                }
                if (rules.enum && !rules.enum.includes(val)) {
                    val = rules.default !== undefined ? rules.default : '';
                }
            } else if (rules.type === 'number') {
                val = Number(val);
                if (isNaN(val)) val = rules.default !== undefined ? rules.default : 0;
            } else if (rules.type === 'boolean') {
                val = Boolean(val);
            } else if (rules.type === 'array') {
                val = Array.isArray(val) ? val : [];
                if (rules.maxLength) val = val.slice(0, rules.maxLength);
            }
            result[key] = val;
        } else if (rules.required) {
            throw new Error(`Missing required field: ${key}`);
        } else if (rules.default !== undefined) {
            result[key] = rules.default;
        }
    }
    return result;
}

const SCHEMAS = {
    bug: {
        title: { type: 'string', maxLength: 200, required: true },
        description: { type: 'string', maxLength: 10000, default: '' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
        status: { type: 'string', enum: ['open', 'in-progress', 'resolved', 'passed', 'failed'], default: 'open' },
        tags: { type: 'array', maxLength: 50, default: [] },
        locked: { type: 'boolean', default: false },
        // Free-text business fields (Bug Tracker uses these heavily — keep generous caps)
        assignee: { type: 'string', maxLength: 500, default: '' },     // comma-separated names
        client: { type: 'string', maxLength: 200, default: '' },
        swVersion: { type: 'string', maxLength: 100, default: '' },
        // Audit / authorship
        createdBy: { type: 'string', maxLength: 100, default: '' },
        createdByUser: { type: 'string', maxLength: 100, default: '' },
        createdAt: { type: 'string', maxLength: 50, default: '' },
        updatedAt: { type: 'string', maxLength: 50, default: '' }
    },
    list: {
        name: { type: 'string', maxLength: 100, required: true },
        color: { type: 'string', maxLength: 20, default: '#6366f1' }
    },
    version: {
        name: { type: 'string', maxLength: 100, required: true },
        link: { type: 'string', maxLength: 500, default: '' }
    },
    comment_edit: {
        bugId: { type: 'string', maxLength: 64, required: true },
        commentId: { type: 'string', maxLength: 64, required: true },
        text: { type: 'string', maxLength: 5000, required: true }
    },
    follower_action: {
        action: { type: 'string', enum: ['add', 'remove', 'toggle'], required: true },
        username: { type: 'string', maxLength: 100, required: true }
    }
};

// Tree-walker for POST /api/store — the entire bug tree comes in one shot.
function sanitizeStore(data) {
    const out = { versions: [] };
    if (!data || !Array.isArray(data.versions)) return out;

    for (const v of data.versions) {
        const cleanV = validateSchema(v, SCHEMAS.version);
        cleanV.id = String(v.id || '').slice(0, 64);

        cleanV.lists = (Array.isArray(v.lists) ? v.lists : []).map(l => {
            const cleanL = validateSchema(l, SCHEMAS.list);
            cleanL.id = String(l.id || '').slice(0, 64);

            cleanL.bugs = (Array.isArray(l.bugs) ? l.bugs : []).map(b => {
                const cleanB = validateSchema(b, SCHEMAS.bug);
                cleanB.id = String(b.id || '').slice(0, 64);

                // Preserve server-handled resolution metadata (set by /resolve flow)
                ['resolvedBy', 'resolvedAt', 'resolvedVersion', 'resolvedByUser'].forEach(k => {
                    if (b[k]) cleanB[k] = String(b[k]).slice(0, 100);
                });

                cleanB.comments = (Array.isArray(b.comments) ? b.comments : []).slice(0, 500).map(c => {
                    const out = {
                        id: String(c.id || '').slice(0, 64),
                        author: String(c.author || '').slice(0, 100),
                        text: String(c.text || '').slice(0, 5000),
                        createdAt: String(c.createdAt || '').slice(0, 50),
                    };
                    if (c.editedAt) out.editedAt = String(c.editedAt).slice(0, 50);
                    return out;
                });

                cleanB.followers = (Array.isArray(b.followers) ? b.followers : [])
                    .slice(0, 100)
                    .map(f => String(f).slice(0, 100));

                return cleanB;
            });
            return cleanL;
        });
        out.versions.push(cleanV);
    }
    return out;
}

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '127.0.0.1';
}

// ===== EMAIL (Nodemailer + Hostinger) =====
function toHtml(text) {
    // Convert literal \\n to real newlines, then to HTML
    const normalized = text.replace(/\\n/g, '\n');
    const escaped = normalized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const withBreaks = escaped
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    const withLinks = withBreaks.replace(
        /(https?:\/\/[^\s<>]+)/g,
        '<a href="$1" style="color:#6366f1">$1</a>'
    );
    return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px"><p>' + withLinks + '</p></div>';
}

async function sendEmail(to, subject, text, attachmentStr, html) {
    const transporter = nodemailer.createTransport({
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    const mailOptions = {
        from: '"Bug Tracker" <admin@bugtracker.pro>',
        to,
        subject,
        text
    };
    if (html) {
        mailOptions.html = html;
    }
    if (attachmentStr) {
        mailOptions.attachments = [{
            filename: 'backup.json',
            content: Buffer.from(attachmentStr)
        }];
    }

    const info = await transporter.sendMail(mailOptions);

    console.log('[Email] Sent to', to, 'MessageId:', info.messageId);
    return info;
}

// ===== MENTION DETECTION =====
// Returns array of user objects that are @mentioned in text and have email
function extractMentionedUsers(text, users, excludeUserId) {
    const matches = (text || '').match(/@([\w]+)/g) || [];
    const found = new Map();
    for (const m of matches) {
        const username = m.slice(1).toLowerCase();
        const user = users.find(u => u.username.toLowerCase() === username && u.email && u.email.trim() && u.id !== excludeUserId);
        if (user && !found.has(user.email)) found.set(user.email, user);
    }
    return [...found.values()];
}

async function sendMentionNotifications(mentionedUsers, mentionerName, bugTitle, listName, contextText, bugId) {
    for (const user of mentionedUsers) {
        try {
            const unfollowToken = generateUnsubscribeToken(user.id, bugId || '');
            const unfollowLink = 'https://bugtracker.tail51f3b0.ts.net/api/bugs/' + encodeURIComponent(bugId || '') + '/unsubscribe?userId=' + encodeURIComponent(user.id) + '&token=' + unfollowToken;
            const text = '🔔 ' + mentionerName + ' te mencionó en: ' + bugTitle + '\n' +
                '   📋 Lista: ' + listName + '\n' +
                '   💬 "' + contextText.slice(0, 300) + '"\n\n' +
                '🔗 Revisa en: https://bugtracker.tail51f3b0.ts.net';
            const html = toHtml(text) + '<br><hr style="border:none;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:12px;color:#999;font-family:Arial,sans-serif;"><a href="' + unfollowLink + '" style="color:#6366f1;">Dejar de recibir notificaciones sobre esta tarea</a></p>';
            await sendEmail(user.email,
                '[Bug Tracker] ' + mentionerName + ' te mencionó en "' + bugTitle + '"',
                text, null, html
            );
            console.log('[Mention] Sent to', user.email, '(' + user.name + ')');
        } catch (e) {
            console.error('[Mention] Failed for', user.email, ':', e.message);
        }
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // POST /api/register
    if (pathname === '/api/register' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { name, username, password, role = 'user' } = data;
            if (!name || !username || !password) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Faltan campos requeridos' }));
                return;
            }
            if (password.length < 4) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'La contraseña debe tener al menos 4 caracteres' }));
                return;
            }
            const users = readJSON(USERS_FILE) || [];
            const normalizedUsername = username.toLowerCase().trim();
            if (users.find(u => u.username === normalizedUsername)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'El usuario ya existe' }));
                return;
            }
            const passwordHash = await hashPassword(password);
            const newUser = {
                id: crypto.randomUUID(),
                name: name.trim(),
                username: normalizedUsername,
                passwordHash,
                role,
                email: '',
                notifications: false,
                createdAt: Date.now()
            };
            users.push(newUser);
            writeJSON(USERS_FILE, users);
            const token = createToken(newUser);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                token,
                user: { id: newUser.id, name: newUser.name, username: newUser.username, role: newUser.role, email: newUser.email }
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/login
    if (pathname === '/api/login' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { username, password } = data;
            if (!username || !password) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Faltan campos requeridos' }));
                return;
            }
            const users = readJSON(USERS_FILE) || [];
            const normalizedUsername = username.toLowerCase().trim();
            const user = users.find(u => u.username === normalizedUsername);
            if (!user) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Usuario o contraseña incorrectos' }));
                return;
            }
            const valid = await verifyPassword(password, user.passwordHash);
            if (!valid) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Usuario o contraseña incorrectos' }));
                return;
            }
            const token = createToken(user);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                token,
                user: { id: user.id, name: user.name, username: user.username, role: user.role, email: user.email || '' }
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/me
    if (pathname === '/api/me' && req.method === 'GET') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: session }));
        return;
    }

    // GET /api/users
    if (pathname === '/api/users' && req.method === 'GET') {
        const users = readJSON(USERS_FILE) || [];
        const safeUsers = users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.createdAt, email: u.email || '', notifications: u.notifications !== false }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(safeUsers));
        return;
    }

    // POST /api/users
    if (pathname === '/api/users' && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        try {
            const incomingUsers = await parseBody(req);
            const existingUsers = readJSON(USERS_FILE) || [];
            const mergedUsers = incomingUsers.map(incoming => {
                const existing = existingUsers.find(u => u.id === incoming.id);
                if (existing && existing.passwordHash) incoming.passwordHash = existing.passwordHash;
                if (existing && existing.notifications !== undefined) incoming.notifications = existing.notifications;
                return incoming;
            });
            writeJSON(USERS_FILE, mergedUsers);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // PATCH /api/users/:id/role — Change user role (admin only)
    if (pathname.startsWith('/api/users/') && pathname.endsWith('/role') && req.method === 'PATCH') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        const userId = pathname.split('/')[3];
        const users = readJSON(USERS_FILE) || [];
        const currentUser = users.find(u => u.id === session.userId);
        if (!currentUser || currentUser.role !== 'admin') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Solo el admin puede cambiar roles' }));
            return;
        }
        const { role } = await parseBody(req);
        if (!['manager', 'user'].includes(role)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rol inválido. Debe ser "manager" o "user"' }));
            return;
        }
        const target = users.find(u => u.id === userId);
        if (!target) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Usuario no encontrado' }));
            return;
        }
        if (target.role === 'admin') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No se puede cambiar el rol de un admin' }));
            return;
        }
        target.role = role;
        writeJSON(USERS_FILE, users);
        // Update session role if targeting the same user
        if (target.id === session.userId) {
            session.role = role;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // GET /api/store — reassemble from split files
    if (pathname === '/api/store' && req.method === 'GET') {
        const meta = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        // Load each version's data from its own file
        for (const v of meta.versions) {
            const vData = readVersion(v.id);
            v.lists = vData.lists || [];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
        return;
    }

    // POST /api/store (with notification support)
    if (pathname === '/api/store' && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        try {
            console.log('[Notify] POST /api/store recibido de', session.username);
            const rawData = await parseBody(req);
            let data;
            try {
                data = sanitizeStore(rawData);
            } catch (schemaErr) {
                console.warn('[Schema] /api/store rejected:', schemaErr.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: schemaErr.message }));
                return;
            }
            const oldStore = readJSON(STORE_FILE);
            // (split save happens after notifications below)
            console.log('[Notify] oldStore:', !!oldStore, '| versions:', !!(data && data.versions));
            // Detect changes and send notifications
            if (oldStore && data.versions && Array.isArray(oldStore.versions)) {
                // Load lists from individual v_*.json files for oldStore (split store)
                if (oldStore.versions) {
                    for (const ov of oldStore.versions) {
                        const ovData = readVersion(ov.id);
                        ov.lists = ovData.lists || [];
                    }
                }
                const oldBugs = {};     // key -> { bug, listName, versionName }
                const newBugs = {};     // key -> { bug, listName, versionName }
                // Detect new lists
                const newLists = [];
                data.versions.forEach(v => {
                    v.lists.forEach(l => {
                        let found = false;
                        if (oldStore.versions) {
                            oldStore.versions.forEach(ov => {
                                (ov.lists || []).forEach(ol => {
                                    if (ol.id === l.id) found = true;
                                });
                            });
                        }
                        if (!found) newLists.push({ name: l.name, color: l.color, bugCount: (l.bugs || []).length });
                    });
                });
                console.log('[Notify] New lists:', newLists.length);
                console.log('[Notify] Indexing old bugs...');

                // Index old bugs with their list/version names
                oldStore.versions.forEach(v => {
                    v.lists.forEach(l => {
                        l.bugs.forEach(b => {
                            oldBugs[v.id + ':' + l.id + ':' + b.id] = {
                                bug: b, listName: l.name, versionName: v.name
                            };
                        });
                    });
                });

                // Index new bugs with their list/version names
                data.versions.forEach(v => {
                    v.lists.forEach(l => {
                        l.bugs.forEach(b => {
                            const key = v.id + ':' + l.id + ':' + b.id;
                            newBugs[key] = {
                                bug: b, listName: l.name, versionName: v.name
                            };
                        });
                    });
                });

                // Find new and modified bugs
                const changed = [];
                for (const [key, newEntry] of Object.entries(newBugs)) {
                    const oldEntry = oldBugs[key];
                    const nb = newEntry.bug;
                    if (!oldEntry) {
                        changed.push({ type: 'new', entry: newEntry });
                    } else {
                        const ob = oldEntry.bug;
                        const changedFields = [];
                        if (ob.title !== nb.title) changedFields.push('título');
                        if (ob.description !== nb.description) changedFields.push('descripción');
                        if (ob.priority !== nb.priority) changedFields.push('prioridad');
                        if (ob.status !== nb.status) changedFields.push('estado');
                        if (ob.assignee !== nb.assignee) changedFields.push('asignado a');
                        if (ob.client !== nb.client) changedFields.push('cliente');
                        if (ob.swVersion !== nb.swVersion) changedFields.push('versión');
                        if (ob.resolvedBy !== nb.resolvedBy) changedFields.push('resuelto por');
                        // Detect comment changes
                        const oldComments = ob.comments || [];
                        const newComments = nb.comments || [];
                        if (newComments.length > oldComments.length) {
                            changedFields.push('comentarios');
                        } else if (newComments.length === oldComments.length && newComments.length > 0) {
                            for (let i = 0; i < newComments.length; i++) {
                                if ((oldComments[i]||{}).text !== (newComments[i]||{}).text) {
                                    changedFields.push('comentarios');
                                    break;
                                }
                            }
                        }
                        if (changedFields.length > 0) {
                            changed.push({ type: 'updated', entry: newEntry, fields: changedFields, oldBug: ob });
                        }
                    }
                }

                // Also notify about new lists
                if (newLists.length > 0) {
                    const su = (readJSON(USERS_FILE) || []).find(u => u.role === 'admin' && u.email && u.email.trim());
                    if (su && su.id !== session.userId) {
                        newLists.forEach(l => {
                            changed.push({
                                type: 'new_list',
                                entry: { bug: { title: l.name + ' (' + l.bugCount + ' tareas)', description: '', priority: '', status: '', assignee: '', createdBy: session.username, comments: [] }, listName: l.name }
                            });
                        });
                    }
                }

                // Send notifications if there are changes
                console.log('[Notify] Cambios detectados:', changed.length);
                if (changed.length > 0) {
                    changed.forEach(c => console.log('  -', c.type, c.entry.bug.title, '| fields:', (c.fields||[]).join(',')));
                    const users = readJSON(USERS_FILE) || [];
                    const authorName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
                    const priorityLabels = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
                    const statusLabels = { 'new': 'Nuevo', 'in-progress': 'En curso', 'passed': 'Pasado', 'failed': 'Fallido' };

                    // Build change descriptions (3 formats: new, updated, comment-only)
                    const changeDescriptions = changed.map(c => {
                        const bug = c.entry.bug;
                        const listName = c.entry.listName;
                        const priority = priorityLabels[bug.priority] || bug.priority || '—';
                        const assignee = bug.assignee || 'Sin asignar';
                        const status = statusLabels[bug.status] || bug.status || '—';
                        const desc = bug.description || '';
                        const createdBy = bug.createdBy || '';

                        // Extract new comments if any
                        let newCommentText = '';
                        const oldC = (c.oldBug && c.oldBug.comments) || [];
                        const newC = bug.comments || [];
                        if (newC.length > oldC.length) {
                            const added = newC.slice(oldC.length);
                            newCommentText = added.map(cm => '      \ud83d\udcac ' + (cm.author || 'An\ufffdnimo') + ': ' + (cm.text || '').slice(0, 120)).join('\\n');
                        }

                        // TYPE 1: New task - show ALL details including description and comments
                        if (c.type === 'new_list') {
                            return 'New list: ' + bug.title + ' - Created by ' + (bug.createdBy || '');
                        }

                        if (c.type === 'new') {
                            let msg = '\ud83d\udd06 Nueva tarea: ' + bug.title + '\\n' +
                                '   \ud83d\udccb Lista: ' + listName + '\\n';
                            if (desc) msg += '   \ud83d\udcdd Descripci\ufffdn: ' + desc.slice(0, 200) + '\\n';
                            msg += '   \ud83d\udd34 Prioridad: ' + priority + '\\n' +
                                '   \ud83d\udc64 Asignada a: ' + assignee + '\\n' +
                                '   \ud83d\udccc Estado: ' + status + '\\n' +
                                '   \u270f\ufe0f Creada por: ' + createdBy;
                            if (newC.length > 0) {
                                msg += '\\n   \ud83d\udcac Comentarios iniciales (' + newC.length + '):\\n' +
                                    newC.map(cm => '      ' + (cm.author || 'An\ufffdnimo') + ': ' + (cm.text || '').slice(0, 120)).join('\\n');
                            }
                            return msg;
                        }

                        // TYPE 2: Comment only change
                        const nonCommentFields = (c.fields || []).filter(f => f !== 'comentarios');
                        if (nonCommentFields.length === 0 && newCommentText) {
                            return '\ud83d\udcac Nuevo(s) comentario(s) en: ' + bug.title + '\\n' +
                                '   \ud83d\udccb Lista: ' + listName + '\\n' +
                                newCommentText;
                        }

                        // TYPE 3: Other updates (fields changed, with or without comments)
                        let msg = '\u270f\ufe0f Tarea actualizada: ' + bug.title + '\\n' +
                            '   \ud83d\udccb Lista: ' + listName + '\\n' +
                            '   \ud83d\udd27 Cambios: ' + c.fields.join(', ') + '\\n' +
                            '   \ud83d\udc64 Asignada a: ' + assignee + '\\n' +
                            '   \ud83d\udd34 Prioridad: ' + priority;
                        if (newCommentText) {
                            msg += '\\n' + newCommentText;
                        }
                        return msg;
                    }).join('\\n\\n');

                    const text = authorName + ' ha realizado ' + changed.length + ' cambio(s):\\n\\n' +
                        changeDescriptions + '\\n\\n\ud83d\udd17 Revisa en: https://bugtracker.tail51f3b0.ts.net';
                    const html = toHtml(text);

                                        // Determine bugId for unsubscribe link (use first changed bug)
                    let bugIdForEmail = null;
                    for (const c of changed) {
                        if (c.entry && c.entry.bug && c.entry.bug.id) {
                            bugIdForEmail = c.entry.bug.id;
                            break;
                        }
                    }
                    if (!bugIdForEmail) bugIdForEmail = '';

                    // Collect recipients: super user + subscribers + assignees + managers + followers
                    const recipients = new Map(); // email -> user object

                    // Super user ALWAYS gets notifications
                    const superUser = users.find(u => u.role === 'admin' && u.email && u.email.trim());
                    if (superUser && superUser.id !== session.userId) {
                        recipients.set(superUser.email, superUser);
                    }

                    // Subscribers (users who opted in)
                    users.forEach(u => {
                        if (u.notifications !== false && u.email && u.email.trim() && u.id !== session.userId) {
                            recipients.set(u.email, u);
                        }
                    });

                    // Direct assignees (notify on any change to their tasks)
                    changed.forEach(c => {
                        const assignee = c.entry.bug.assignee;
                        if (assignee) {
                            const user = users.find(u =>
                                u.name === assignee && u.email && u.email.trim() && u.id !== session.userId
                            );
                            if (user) recipients.set(user.email, user);
                        }
                    });

                    // === NEW: Managers — reciben notificaciones de CUALQUIER cambio (como el admin) ===
                    const managers = users.filter(u => u.role === 'manager' && u.email && u.email.trim() && u.id !== session.userId);
                    managers.forEach(m => {
                        // Skip if this manager has muted any of the changed bugs
                        const isMuted = changed.some(c => {
                            const b = c.type === 'new_list' ? null : c.entry?.bug;
                            return b && b.mutedManagers && b.mutedManagers.includes(m.id);
                        });
                        if (!isMuted) recipients.set(m.email, m);
                    });

                    // === NEW: Followers — reciben notificaciones de cualquier cambio en ESA tarea ===
                    changed.forEach(c => {
                        const bug = c.type === 'new_list' ? null : c.entry?.bug;
                        if (bug && bug.followers && bug.followers.length > 0) {
                            bug.followers.forEach(followerUsername => {
                                const follower = users.find(u => u.username === followerUsername && u.email && u.email.trim() && u.id !== session.userId);
                                if (follower) recipients.set(follower.email, follower);
                            });
                        }
                        // Also check oldBug followers (for updated tasks)
                        if (c.oldBug && c.oldBug.followers && c.oldBug.followers.length > 0) {
                            c.oldBug.followers.forEach(followerUsername => {
                                const follower = users.find(u => u.username === followerUsername && u.email && u.email.trim() && u.id !== session.userId);
                                if (follower) recipients.set(follower.email, follower);
                            });
                        }
                    });

                    let sentCount = 0;
                    for (const [email, user] of recipients) {
                        try {
                            // Build personalized unsubscribe link for this recipient and this bug
                            const unfollowToken = generateUnsubscribeToken(user.id, bugIdForEmail);
                            const unfollowLink = 'https://bugtracker.tail51f3b0.ts.net/api/bugs/' + encodeURIComponent(bugIdForEmail) + '/unsubscribe?userId=' + encodeURIComponent(user.id) + '&token=' + unfollowToken;
                            // Augment HTML with unsubscribe footer
                            let emailHtml = html + '<br><hr style="border:none;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:12px;color:#999;font-family:Arial,sans-serif;"><a href="' + unfollowLink + '" style="color:#6366f1;">Dejar de recibir notificaciones sobre esta tarea</a></p>';
                            await sendEmail(email,
                                '[Bug Tracker] ' + changed.length + ' cambio(s) de ' + authorName,
                                text, null, emailHtml
                            );
                            sentCount++;
                            console.log('[Notify] Sent to', email, '(' + user.name + ')');
                        } catch (e) {
                            console.error('[Notify] Failed for', email, ':', e.message);
                        }
                    }
                    if (sentCount > 0) console.log('[Notify] Total sent:', sentCount);
                }
            } else {
                console.log('[Notify] Skipping - oldStore:', !!oldStore, 'data.versions:', !!(data && data.versions), 'isArray:', !!(oldStore && Array.isArray(oldStore.versions)));
            }

            // ===== MENTION NOTIFICATIONS (new/updated descriptions + new comments) =====
            if (oldStore && data.versions && Array.isArray(oldStore.versions)) {
                const allUsers = readJSON(USERS_FILE) || [];
                const mentionerName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
                for (const v of data.versions) {
                    const oldV = (oldStore.versions || []).find(ov => ov.id === v.id);
                    for (const l of (v.lists || [])) {
                        const oldL = oldV ? (oldV.lists || []).find(ol => ol.id === l.id) : null;
                        for (const b of (l.bugs || [])) {
                            const oldB = oldL ? (oldL.bugs || []).find(ob => ob.id === b.id) : null;
                            const mentionsToSend = new Map(); // email -> user (dedup across sources)

                            // Check description changes for new @mentions
                            const oldDesc = oldB ? (oldB.description || '') : '';
                            const newDesc = b.description || '';
                            if (newDesc !== oldDesc) {
                                // Find mentions that are NEW (not in old description)
                                const oldMentioned = extractMentionedUsers(oldDesc, allUsers, session.userId).map(u => u.email);
                                for (const u of extractMentionedUsers(newDesc, allUsers, session.userId)) {
                                    if (!oldMentioned.includes(u.email)) mentionsToSend.set(u.email, { user: u, text: newDesc });
                                }
                            }

                            // Check for new comments with @mentions
                            const oldComments = oldB ? (oldB.comments || []) : [];
                            const newComments = b.comments || [];
                            if (newComments.length > oldComments.length) {
                                const addedComments = newComments.slice(oldComments.length);
                                for (const cm of addedComments) {
                                    for (const u of extractMentionedUsers(cm.text, allUsers, session.userId)) {
                                        if (!mentionsToSend.has(u.email)) mentionsToSend.set(u.email, { user: u, text: cm.text });
                                    }
                                }
                            }

                            if (mentionsToSend.size > 0) {
                                const mentionedUsers = [...mentionsToSend.values()].map(m => m.user);
                                // Use the first mention's context text (each user gets the text where they appear)
                                for (const [email, { user, text }] of mentionsToSend) {
                                    await sendMentionNotifications([user], mentionerName, b.title, l.name, text, b.id);
                                }
                            }
                        }
                    }
                }
            }

            // Save split version files (scalability)
            if (data.versions) {
                const meta = { versions: [], activeVersionId: data.activeVersionId, activeListId: data.activeListId };
                for (const v of data.versions) {
                    writeVersionData(v.id, { lists: v.lists });
                    meta.versions.push({ id: v.id, name: v.name });
                }
                atomicWrite(STORE_FILE, meta);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/bugs/:bugId/followers — Add/remove/toggle followers
    if (pathname.startsWith('/api/bugs/') && pathname.endsWith('/followers') && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        try {
            const bugId = pathname.split('/')[3];
            const cleaned = await (async () => {
                try {
                    return validateSchema(await parseBody(req), SCHEMAS.follower_action);
                } catch (schemaErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: schemaErr.message }));
                    return null;
                }
            })();
            if (cleaned === null) return; // schema threw, response already sent
            const { action, username } = cleaned;
            if (!action) {
                // action was present in body but failed enum validation (reset to '')
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid action; expected one of: add, remove, toggle' }));
                return;
            }

            // Find the bug in store.json
            const store = readJSON(STORE_FILE);
            if (!store || !store.versions) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }
            // Load each version's lists from its individual v_*.json file
            for (const v of store.versions) {
                const vData = readVersion(v.id);
                v.lists = vData.lists || [];
            }
            let bug = null;
            let bugVersion = null;
            for (const v of store.versions) {
                for (const l of v.lists) {
                    bug = l.bugs.find(b => b.id === bugId);
                    if (bug) { bugVersion = v; break; }
                }
                if (bug) break;
            }
            if (!bug) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }

            if (!bug.followers) bug.followers = [];

            const targetUser = (username || session.username).toLowerCase();
            const users = readJSON(USERS_FILE) || [];
            const targetUserObj = users.find(u => u.username.toLowerCase() === targetUser.toLowerCase());

            // Allow admins to remove ghost followers (deleted users) — skip existence check for remove action
            const sessionUser = users.find(u => u.id === session.userId);
            const isAdmin = sessionUser && sessionUser.role === 'admin';
            const isRemove = action === 'remove' || (action == null && bug.followers.includes(targetUser));
            if (!targetUserObj && !isRemove) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'El usuario "' + targetUser + '" no existe' }));
                return;
            }
            // Only admin can remove someone else's follower entry
            if (targetUser !== session.username.toLowerCase() && !isAdmin) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Solo el admin puede quitar seguidores de otros usuarios' }));
                return;
            }

            if (action === 'add' || (!action && !bug.followers.includes(targetUser))) {
                if (!bug.followers.includes(targetUser)) {
                    bug.followers.push(targetUser);
                }
            } else if (action === 'remove' || (!action && bug.followers.includes(targetUser))) {
                bug.followers = bug.followers.filter(f => f !== targetUser);
            }

            // Persist the bug's version file (lists live in v_<id>.json, not store.json)
            writeVersionData(bugVersion.id, { lists: bugVersion.lists });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, followers: bug.followers }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/bugs/:bugId/unsubscribe — Unfollow from email link (no auth required)
    if (pathname.startsWith('/api/bugs/') && pathname.endsWith('/unsubscribe') && req.method === 'GET') {
        const bugId = pathname.split('/')[3];
        const userId = url.searchParams.get('userId');
        const token = url.searchParams.get('token');

        if (!userId || !token) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>❌ Error: Faltan parámetros (userId y token)</h2></body></html>');
            return;
        }

        const store = readJSON(STORE_FILE);
        if (!store || !store.versions) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>❌ Error: No se encontró la base de datos</h2></body></html>');
            return;
        }

        // Load versions
        for (const v of store.versions) {
            const vData = readVersion(v.id);
            v.lists = vData.lists || [];
        }

        let bug = null;
        let bugTitle = 'esta tarea';
        let bugVersionId = null;
        for (const v of store.versions) {
            for (const l of v.lists) {
                const foundBug = l.bugs.find(b => b.id === bugId);
                if (foundBug) {
                    bug = foundBug;
                    bugTitle = bug.title || 'esta tarea';
                    bugVersionId = v.id;
                    break;
                }
            }
            if (bug) break;
        }

        if (!bug) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>❌ Error: Tarea no encontrada</h2></body></html>');
            return;
        }

        // Verify token
        if (!verifyUnsubscribeToken(userId, bugId, token)) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>❌ Error: Token inválido o expirado</h2></body></html>');
            return;
        }

        // Find user
        const users = readJSON(USERS_FILE) || [];
        const user = users.find(u => u.id === userId);
        if (!user) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>❌ Error: Usuario no encontrado</h2></body></html>');
            return;
        }

        // Remove user from followers OR mute manager
        let wasAffected = false;

        if (user.role === 'manager') {
            // Manager: add to mutedManagers so they won't get notifications for this bug
            if (!bug.mutedManagers) bug.mutedManagers = [];
            if (!bug.mutedManagers.includes(userId)) {
                bug.mutedManagers.push(userId);
                wasAffected = true;
            }
        } else {
            // Regular user: remove followers
            if (!bug.followers) bug.followers = [];
            const username = user.username.toLowerCase();
            if (bug.followers.includes(username)) {
                bug.followers = bug.followers.filter(f => f !== username);
                wasAffected = true;
            }
        }

        if (wasAffected) {
            // Persist to the version file (split store), NOT store.json
            if (bugVersionId) {
                const bugVersion = store.versions.find(v => v.id === bugVersionId);
                if (bugVersion && bugVersion.lists) {
                    writeVersionData(bugVersionId, { lists: bugVersion.lists });
                }
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
                '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>Suscripción cancelada</title>' +
                '<style>body{font-family:Arial,sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center;background:#f9f9f9;}' +
                '.card{background:#fff;border-radius:12px;padding:40px 30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}' +
                '.icon{font-size:64px;margin-bottom:16px;}' +
                'h1{color:#333;font-size:22px;margin:0 0 8px;}' +
                'p{color:#666;font-size:16px;margin:0;}</style></head><body>' +
                '<div class="card">' +
                '<div class="icon">✅</div>' +
                '<h1>Has dejado de recibir notificaciones</h1>' +
                '<p>No recibirás más alertas sobre: <strong>' + bugTitle.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</strong></p>' +
                '<p style="margin-top:16px;font-size:14px;color:#999;">Puedes volver a seguir esta tarea desde la aplicación.</p>' +
                '</div></body></html>'
            );
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
                '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>Ya no sigues esta tarea</title>' +
                '<style>body{font-family:Arial,sans-serif;max-width:600px;margin:60px auto;padding:20px;text-align:center;background:#f9f9f9;}' +
                '.card{background:#fff;border-radius:12px;padding:40px 30px;box-shadow:0 2px 8px rgba(0,0,0,0.08);}' +
                '.icon{font-size:64px;margin-bottom:16px;}' +
                'h1{color:#333;font-size:22px;margin:0 0 8px;}' +
                'p{color:#666;font-size:16px;margin:0;}</style></head><body>' +
                '<div class="card">' +
                '<div class="icon">ℹ️</div>' +
                '<h1>Ya no sigues esta tarea</h1>' +
                '<p><strong>' + user.name.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</strong> no estaba siguiendo <strong>' + bugTitle.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</strong>.</p>' +
                '<p style="margin-top:16px;font-size:14px;color:#999;">No se ha realizado ningún cambio.</p>' +
                '</div></body></html>'
            );
        }
        return;
    }

    // POST /api/send-backup
    if (pathname === '/api/send-backup' && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        const users = readJSON(USERS_FILE) || [];
        const user = users.find(u => u.id === session.userId);
        if (!user || !user.email) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No tienes un email configurado. Actualiza tu perfil primero.' }));
            return;
        }
        const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        const backup = {
            _backup: true,
            _date: new Date().toISOString(),
            _app: 'Bug Tracker',
            store,
            users
        };
        const backupStr = JSON.stringify(backup, null, 2);
        try {
            if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Credenciales SMTP no configuradas en el servidor' }));
                return;
            }
            const backupHtml = toHtml('Adjunto encontrarás tu backup de Bug Tracker.\\n\\n\ud83d\udcc5 Fecha: ' + new Date().toLocaleString() + '\\n\ud83d\udd17 Accede a la app: https://bugtracker.tail51f3b0.ts.net');
            await sendEmail(user.email, 'Backup Bug Tracker', 'Adjunto encontrarás tu backup de Bug Tracker.', backupStr, backupHtml);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Backup enviado correctamente a ' + user.email }));
        } catch (e) {
            console.error('[Email Error]', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/backup
    if (pathname === '/api/backup' && req.method === 'GET') {
        const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        const users = readJSON(USERS_FILE) || [];
        const backup = { _backup: true, _date: new Date().toISOString(), _app: 'Bug Tracker', store, users };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="backup.json"' });
        res.end(JSON.stringify(backup, null, 2));
        return;
    }

    // POST /api/restore
    if (pathname === '/api/restore' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            if (!data._backup || !data.store || !data.users) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Formato de backup inválido' }));
                return;
            }
            // Save store atomically via split files
            if (data.store && data.store.versions) {
                const meta = { versions: [], activeVersionId: data.store.activeVersionId, activeListId: data.store.activeListId };
                for (const v of data.store.versions) {
                    writeVersionData(v.id, { lists: v.lists });
                    meta.versions.push({ id: v.id, name: v.name });
                }
                atomicWrite(STORE_FILE, meta);
            }
            writeJSON(USERS_FILE, data.users);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // PUT /api/comments — Edit comment (author or admin only; managers CANNOT edit others' comments)
    if (pathname === '/api/comments' && req.method === 'PUT') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        try {
            let bugId, commentId, text;
            try {
                const cleaned = validateSchema(await parseBody(req), SCHEMAS.comment_edit);
                ({ bugId, commentId, text } = cleaned);
            } catch (schemaErr) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: schemaErr.message }));
                return;
            }
            if (!bugId || !commentId || !text || !text.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Faltan campos requeridos' }));
                return;
            }
            const store = readJSON(STORE_FILE);
            if (!store || !store.versions) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }
            // Load each version's lists from its individual v_*.json file
            for (const v of store.versions) {
                const vData = readVersion(v.id);
                v.lists = vData.lists || [];
            }
            // Find the comment AND track version
            let found = false;
            let commentVersionId = null;
            for (const v of store.versions) {
                for (const l of v.lists) {
                    for (const b of l.bugs) {
                        if (b.id === bugId) {
                            const comment = (b.comments || []).find(c => c.id === commentId);
                            if (!comment) {
                                res.writeHead(404, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Comentario no encontrado' }));
                                return;
                            }
                            // Check permissions: author or admin ONLY (managers cannot edit others' comments)
                            const users = readJSON(USERS_FILE) || [];
                            const currentUser = users.find(u => u.id === session.userId);
                            const isAdmin = currentUser && currentUser.role === 'admin';
                            const isAuthor = comment.authorUser === session.username;
                            if (!isAuthor && !isAdmin) {
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Solo el autor o el admin pueden editar este comentario' }));
                                return;
                            }
                            const oldCommentText = comment.text || '';
                            comment.text = text.trim();
                            comment.editedAt = Date.now();
                            comment.editedBy = session.username;
                            commentVersionId = v.id;
                            // Detect new @mentions introduced by edit
                            const allUsers = users;
                            const oldMentioned = extractMentionedUsers(oldCommentText, allUsers, session.userId).map(u => u.email);
                            const newMentioned = extractMentionedUsers(comment.text, allUsers, session.userId).filter(u => !oldMentioned.includes(u.email));
                            if (newMentioned.length > 0) {
                                const mentionerName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
                                sendMentionNotifications(newMentioned, mentionerName, b.title, l.name, comment.text, b.id).catch(e => console.error('[Mention] Edit error:', e.message));
                            }
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
                if (found) break;
            }
            if (!found) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }
            // Persist to the version file (split store), NOT store.json
            if (commentVersionId) {
                const cv = store.versions.find(v2 => v2.id === commentVersionId);
                if (cv && cv.lists) {
                    writeVersionData(commentVersionId, { lists: cv.lists });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // DELETE /api/comments — Delete comment (author or admin only; managers CANNOT delete others' comments)
    if (pathname === '/api/comments' && req.method === 'DELETE') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado' }));
            return;
        }
        try {
            const { bugId, commentId } = await parseBody(req);
            if (!bugId || !commentId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Faltan campos requeridos' }));
                return;
            }
            const store = readJSON(STORE_FILE);
            if (!store || !store.versions) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }
            // Load each version's lists from its individual v_*.json file
            for (const v of store.versions) {
                const vData = readVersion(v.id);
                v.lists = vData.lists || [];
            }
            // Find the comment AND track version
            let found = false;
            let commentVersionId = null;
            for (const v of store.versions) {
                for (const l of v.lists) {
                    for (const b of l.bugs) {
                        if (b.id === bugId) {
                            const comments = b.comments || [];
                            const comment = comments.find(c => c.id === commentId);
                            if (!comment) {
                                res.writeHead(404, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Comentario no encontrado' }));
                                return;
                            }
                            // Permission check: author or admin only (same as edit)
                            const users = readJSON(USERS_FILE) || [];
                            const currentUser = users.find(u => u.id === session.userId);
                            const isAdmin = currentUser && currentUser.role === 'admin';
                            const isAuthor = comment.authorUser === session.username;
                            if (!isAuthor && !isAdmin) {
                                res.writeHead(403, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'Solo el autor o el admin pueden eliminar este comentario' }));
                                return;
                            }
                            b.comments = comments.filter(c => c.id !== commentId);
                            commentVersionId = v.id;
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
                if (found) break;
            }
            if (!found) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bug no encontrado' }));
                return;
            }
            // Persist to the version file (split store), NOT store.json
            if (commentVersionId) {
                const cv = store.versions.find(v2 => v2.id === commentVersionId);
                if (cv && cv.lists) {
                    writeVersionData(commentVersionId, { lists: cv.lists });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ===== STATIC FILES =====
    let filePath = pathname === '/' ? '/BugTracker.html' : pathname;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

    try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME[ext] || 'application/octet-stream';
            let content = fs.readFileSync(filePath);
            if (filePath.endsWith('.html')) {
                const usersRaw = readJSON(USERS_FILE) || [];
                const safeUsers = usersRaw.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.createdAt, email: u.email || '', notifications: u.notifications !== false }));
                const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
                const inject = '<script>window.__SERVER_DATA__=' + JSON.stringify({ users: safeUsers, store }) + ';</script>';
                content = content.toString().replace('</head>', inject + '\n</head>');
            }
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
            res.end(content);
        } else {
            res.writeHead(404); res.end('Not Found');
        }
    } catch {
        res.writeHead(404); res.end('Not Found');
    }
});

// === MIGRATION: Split store.json into per-version files on startup ===
(async function migrateStore() {
    const store = readJSON(STORE_FILE) || {};
    if (store.versions && store.versions.length > 0 && store.versions[0].lists && store.versions[0].lists[0] && store.versions[0].lists[0].bugs) {
        console.log('[Migrate] Splitting store.json into per-version files...');
        const migrated = { versions: [], activeVersionId: store.activeVersionId, activeListId: store.activeListId };
        for (const v of store.versions) {
            await atomicWrite(getVersionFile(v.id), { lists: v.lists });
            migrated.versions.push({ id: v.id, name: v.name });
        }
        writeJSON(STORE_FILE, migrated);
        console.log('[Migrate] OK — ' + migrated.versions.length + ' version(s) migrated to data/v_*.json');
    }
})();

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  Bug Tracker Server Running on port ' + PORT);
    console.log('  Local: http://localhost:' + PORT);
    console.log('  Red: http://' + ip + ':' + PORT);
    console.log('');
});
