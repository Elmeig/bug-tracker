// ===== Bug Tracker Server =====
// Run: node server.js
// No dependencies needed — uses only Node.js built-in modules.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{"versions":[],"activeVersionId":null,"activeListId":null}', 'utf8');

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ===== API ROUTES =====

    // GET /api/users — Read users
    if (pathname === '/api/users' && req.method === 'GET') {
        const data = readJSON(USERS_FILE) || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // POST /api/users — Save users
    if (pathname === '/api/users' && req.method === 'POST') {
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

    // POST /api/store — Save store data
    if (pathname === '/api/store' && req.method === 'POST') {
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
                const users = readJSON(STORE_FILE.replace('store', 'users')) || [];
                const store = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
                const inject = `<script>window.__SERVER_DATA__=${JSON.stringify({ users, store })};</script>`;
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
