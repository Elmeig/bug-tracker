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

// ===== SESSION TOKENS (in-memory) =====
const sessions = new Map();

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

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    // GET /api/store
    if (pathname === '/api/store' && req.method === 'GET') {
        const data = readJSON(STORE_FILE) || { versions: [], activeVersionId: null, activeListId: null };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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
            const data = await parseBody(req);
            const oldStore = readJSON(STORE_FILE);
            writeJSON(STORE_FILE, data);
            console.log('[Notify] oldStore:', !!oldStore, '| versions:', !!(data && data.versions));
            // Detect changes and send notifications
            if (oldStore && data.versions && Array.isArray(oldStore.versions)) {
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
                            newCommentText = added.map(cm => '      \ud83d\udcac ' + (cm.author || 'An\u00f3nimo') + ': ' + (cm.text || '').slice(0, 120)).join('\\n');
                        }
                        
                        // TYPE 1: New task - show ALL details including description and comments
                        if (c.type === 'new_list') {
                            return 'New list: ' + bug.title + ' - Created by ' + (bug.createdBy || '');
                        }
                        
                        if (c.type === 'new') {
                            let msg = '\ud83d\udd06 Nueva tarea: ' + bug.title + '\\n' +
                                '   \ud83d\udccb Lista: ' + listName + '\\n';
                            if (desc) msg += '   \ud83d\udcdd Descripci\u00f3n: ' + desc.slice(0, 200) + '\\n';
                            msg += '   \ud83d\udd34 Prioridad: ' + priority + '\\n' +
                                '   \ud83d\udc64 Asignada a: ' + assignee + '\\n' +
                                '   \ud83d\udccc Estado: ' + status + '\\n' +
                                '   \u270f\ufe0f Creada por: ' + createdBy;
                            if (newC.length > 0) {
                                msg += '\\n   \ud83d\udcac Comentarios iniciales (' + newC.length + '):\\n' +
                                    newC.map(cm => '      ' + (cm.author || 'An\u00f3nimo') + ': ' + (cm.text || '').slice(0, 120)).join('\\n');
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
                        changeDescriptions + '\\n\\n🔗 Revisa en: https://bugtracker.tail51f3b0.ts.net';
                    const html = toHtml(text);
                    
                    // Collect recipients: subscribers + assignees
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
                    
                    let sentCount = 0;
                    for (const [email, user] of recipients) {
                        try {
                            await sendEmail(email,
                                '[Bug Tracker] ' + changed.length + ' cambio(s) de ' + authorName,
                                text, null, html
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
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
            const backupHtml = toHtml('Adjunto encontrarás tu backup de Bug Tracker.\\n\\n📅 Fecha: ' + new Date().toLocaleString() + '\\n🔗 Accede a la app: https://bugtracker.tail51f3b0.ts.net');
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

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  Bug Tracker Server Running on port ' + PORT);
    console.log('  Local: http://localhost:' + PORT);
    console.log('  Red: http://' + ip + ':' + PORT);
    console.log('');
});
