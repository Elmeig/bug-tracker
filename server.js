// ===== Bug Tracker Server =====
// Run: node server.js
// No dependencies needed — uses only Node.js built-in modules.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Ensure data directory and files exist
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

// ===== SESSION TOKENS (in-memory) =====
const sessions = new Map(); // token -> { userId, username, role, createdAt }

function createToken(user) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        userId: user.id,
        username: user.username,
        role: user.role,
        createdAt: Date.now()
    });
    return token;
}

function getSession(token) {
    if (!token) return null;
    return sessions.get(token) || null;
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

// Read JSON file safely
function readJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

// Write JSON file
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Parse request body
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

// Get local network IP
// ===== EMAIL (Resend API, no dependencies) =====
async function sendEmail(to, subject, text, attachmentStr) {
    const body = {
        from: 'onboarding@resend.dev',
        to,
        subject,
        text,
        attachments: [
            {
                filename: 'backup.json',
                content: Buffer.from(attachmentStr).toString('base64')
            }
        ]
    };

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Resend API error ${res.status}: ${err}`);
    }
    return res.json();
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

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ===== API ROUTES =====

    // POST /api/register — Register new user
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
            if (!username) { res.writeHead(400); res.end(JSON.stringify({ error: "Falta username" })); return; }
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

    // POST /api/login — Authenticate user
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
            if (!username) { res.writeHead(400); res.end(JSON.stringify({ error: "Falta username" })); return; }
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

    // GET /api/me — Get current session user
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

    // GET /api/users — Read users (public, but no password hashes)
    if (pathname === '/api/users' && req.method === 'GET') {
        const users = readJSON(USERS_FILE) || [];
        const safeUsers = users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.createdAt, email: u.email || '' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(safeUsers));
        return;
    }

    // POST /api/users — Save users (protected, requires auth)
    if (pathname === '/api/users' && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado: se requiere token de sesión' }));
            return;
        }
        try {
            const data = await parseBody(req);
            writeJSON(USERS_FILE, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/store — Read store data
    if (pathname === '/api/store' && req.method === 'GET') {
        const data = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // POST /api/store — Save store data (protected, requires auth)
    if (pathname === '/api/store' && req.method === 'POST') {
        const session = requireAuth(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No autorizado: se requiere token de sesión' }));
            return;
        }
        try {
            const data = await parseBody(req);
            writeJSON(STORE_FILE, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/send-backup — Send backup to user's email via Resend
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
            if (!RESEND_API_KEY) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'RESEND_API_KEY no configurada en el servidor' }));
                return;
            }
            await sendEmail(user.email, 'Backup Bug Tracker', 'Adjunto encontrarás tu backup de Bug Tracker.', backupStr);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Backup enviado correctamente a ' + user.email }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/backup — Download full backup (store + users)
    if (pathname === '/api/backup' && req.method === 'GET') {
        const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        const users = readJSON(USERS_FILE) || [];
        const backup = {
            _backup: true,
            _date: new Date().toISOString(),
            _app: 'Bug Tracker',
            store,
            users
        };
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="backup_${new Date().toISOString().slice(0,10)}.json"`
        });
        res.end(JSON.stringify(backup, null, 2));
        return;
    }

    // POST /api/restore — Restore from backup
    if (pathname === '/api/restore' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            if (!data._backup || !data.store || !data.users) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Formato de backup inválido' }));
                return;
            }
            writeJSON(STORE_FILE, data.store);
            writeJSON(USERS_FILE, data.users);
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

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME[ext] || 'application/octet-stream';
            let content = fs.readFileSync(filePath);

            // Inject server data into HTML so client has it immediately
            if (filePath.endsWith('.html')) {
                const usersRaw = readJSON(STORE_FILE.replace('store', 'users')) || [];
                const safeUsers = usersRaw.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.createdAt, email: u.email || '' }));
                const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
                const inject = `<script>window.__SERVER_DATA__=${JSON.stringify({ users: safeUsers, store })};</script>`;
                content = content.toString().replace('</head>', inject + '\n</head>');
            }

            res.writeHead(200, { 
                'Content-Type': contentType,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content);
        } else {
            res.writeHead(404); res.end('Not Found');
        }
    } catch {
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  ╔═══════════════════════════════════════════╗');
    console.log('  ║       🐛 Bug Tracker Server Running       ║');
    console.log('  ╠═══════════════════════════════════════════╣');
    console.log(`  ║  Local:   http://localhost:${PORT}           ║`);
    console.log(`  ║  Red:     http://${ip}:${PORT}      ║`);
    console.log('  ╠═══════════════════════════════════════════╣');
    console.log('  ║  Datos en: ./data/                        ║');
    console.log('  ║  Ctrl+C para detener                      ║');
    console.log('  ╚═══════════════════════════════════════════╝');
    console.log('');
});
