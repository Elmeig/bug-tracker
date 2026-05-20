// ===== SERVER SYNC LAYER =====
const Sync = {
    _serverAvailable: false,
    _baseUrl: '',

    async init() {
        // Detect server: if loaded via http, use same origin; if file://, try localhost
        if (location.protocol === 'http:' || location.protocol === 'https:') {
            this._baseUrl = location.origin;
        } else {
            this._baseUrl = 'http://localhost:3000';
        }
        // Try connecting - if page loaded via http, server is reachable
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                const res = await fetch(this._baseUrl + '/api/users', { method: 'GET', signal: controller.signal });
                clearTimeout(timer);
                this._serverAvailable = res.ok;
                if (this._serverAvailable) break;
            } catch (e) {
                console.log('[Sync] Attempt ' + attempt + ' failed:', e.message);
                this._serverAvailable = false;
            }
            if (!this._serverAvailable && attempt === 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
        console.log(`[Sync] Server ${this._serverAvailable ? '✅ conectado' : '⚠️ no disponible (modo local)'}: ${this._baseUrl}`);
    },

    get isOnline() { return this._serverAvailable; },

    // Pull data from server → localStorage
    async pull(key, localStorageKey) {
        if (!this._serverAvailable) return null;
        try {
            const headers = {};
            if (Auth._token) headers['Authorization'] = 'Bearer ' + Auth._token;
            const res = await fetch(this._baseUrl + '/api/' + key, { headers });
            if (!res.ok) return null;
            const data = await res.json();
            localStorage.setItem(localStorageKey, JSON.stringify(data));
            return data;
        } catch { return null; }
    },

    // Push data to server (fire-and-forget, non-blocking)
    push(key, data) {
        if (!this._serverAvailable) return;
        const token = localStorage.getItem('bugtracker_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        fetch(this._baseUrl + '/api/' + key, {
            method: 'POST',
            headers,
            body: JSON.stringify(data)
        }).catch(() => {});
    }
};

// ===== AUTH LAYER =====
const Auth = {
    _users: [],
    _currentUser: null,
    _token: null,

    // Simple offline hash using SubtleCrypto (SHA-256) — better than plain text
    async _simpleHash(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    load() {
        // Use server-injected data if available (instant, no fetch needed)
        if (window.__SERVER_DATA__ && window.__SERVER_DATA__.users) {
            this._users = window.__SERVER_DATA__.users;
            localStorage.setItem('bugtracker_users', JSON.stringify(this._users));
        } else {
            const saved = localStorage.getItem('bugtracker_users');
            if (saved) this._users = JSON.parse(saved);
        }
        const session = localStorage.getItem('bugtracker_session');
        if (session) {
            const data = JSON.parse(session);
            this._currentUser = data.user || data;  // handle old format (just user) and new format ({user, token})
            this._token = data.token || localStorage.getItem('bugtracker_token');
        }
        const token = localStorage.getItem('bugtracker_token');
        if (token) this._token = token;
    },
    async loadFromServer() {
        const data = await Sync.pull('users', 'bugtracker_users');
        if (data) {
            // Merge server-safe users with local password hashes so offline login still works
            this._users = data.map(serverUser => {
                const localUser = this._users.find(u => u.id === serverUser.id);
                if (localUser && localUser.passwordHash) {
                    return { ...serverUser, passwordHash: localUser.passwordHash };
                }
                return serverUser;
            });
            localStorage.setItem('bugtracker_users', JSON.stringify(this._users));
        }
    },
    saveUsers() {
        // Strip sensitive fields before syncing to server
        const safeUsers = this._users.map(u => {
            const clone = { ...u };
            delete clone.password;
            delete clone.passwordHash;
            return clone;
        });
        localStorage.setItem('bugtracker_users', JSON.stringify(this._users));
        Sync.push('users', safeUsers);
    },
    saveSession() {
        if (this._currentUser) {
            localStorage.setItem('bugtracker_session', JSON.stringify({ user: this._currentUser, token: this._token || null }));
        } else {
            localStorage.removeItem('bugtracker_session');
            localStorage.removeItem('bugtracker_token');
        }
        if (this._token) localStorage.setItem('bugtracker_token', this._token);
        else localStorage.removeItem('bugtracker_token');
    },

    get hasSuperUser() { return this._users.some(u => u.role === 'admin'); },

    async register(name, username, password, role = 'user') {
        if (!Sync.isOnline) {
            // Fallback offline: register locally with simple hash (not secure, but better than plain text)
            username = username.toLowerCase().trim();
            if (this._users.find(u => u.username === username)) return { error: 'El usuario ya existe' };
            if (password.length < 4) return { error: 'La contraseña debe tener al menos 4 caracteres' };
            const hash = await this._simpleHash(password);
            const user = { id: crypto.randomUUID(), name: name.trim(), username, passwordHash: 'local:' + hash, role, email: '', createdAt: Date.now() };
            this._users.push(user);
            this.saveUsers();
            this._currentUser = { id: user.id, name: user.name, username: user.username, role: user.role, email: user.email };
            this.saveSession();
            return { success: true };
        }
        try {
            const res = await fetch(Sync._baseUrl + '/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, username, password, role })
            });
            const data = await res.json();
            if (!res.ok) return { error: data.error || 'Error en el registro' };
            this._token = data.token;
            this._currentUser = data.user;
            this.saveSession();
            // Refresh users list from server
            await this.loadFromServer();
            return { success: true };
        } catch (e) {
            return { error: 'Error de conexión con el servidor' };
        }
    },
    async login(username, password) {
        if (!Sync.isOnline) {
            // Fallback offline: check locally
            username = username.toLowerCase().trim();
            const user = this._users.find(u => u.username === username);
            if (!user) return { error: 'Usuario o contraseña incorrectos' };
            // Offline fallback only works for legacy local users (local: prefix)
            if (user.passwordHash && user.passwordHash.startsWith('local:')) {
                const stored = user.passwordHash.slice(6);
                const inputHash = await this._simpleHash(password);
                if (stored !== inputHash) return { error: 'Usuario o contraseña incorrectos' };
            } else {
                return { error: 'Usuario o contraseña incorrectos' };
            }
            this._currentUser = { id: user.id, name: user.name, username: user.username, role: user.role || 'user', email: user.email || '' };
            this.saveSession();
            return { success: true };
        }
        try {
            const res = await fetch(Sync._baseUrl + '/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) return { error: data.error || 'Error en el login' };
            this._token = data.token;
            this._currentUser = data.user;
            this.saveSession();
            // Refresh users list from server
            await this.loadFromServer();
            return { success: true };
        } catch (e) {
            return { error: 'Error de conexión con el servidor' };
        }
    },
    logout() { this._currentUser = null; this._token = null; this.saveSession(); },
    get user() { return this._currentUser; },
    get isLoggedIn() { return !!this._currentUser; },
    get isAdmin() { return this._currentUser?.role === 'admin'; },
    get isManager() { return this._currentUser?.role === 'manager'; },

    getUsers() {
        // Never expose password hashes or raw passwords to the UI
        return this._users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role || 'user', createdAt: u.createdAt, email: u.email || '' }));
    },
    deleteUser(userId) {
        if (!this.isAdmin) return { error: 'Sin permisos' };
        if (userId === this._currentUser.id) return { error: 'No puedes eliminarte a ti mismo' };
        this._users = this._users.filter(u => u.id !== userId);
        this.saveUsers();
        return { success: true };
    },
    updateUser(userId, updates) {
        if (!this.isAdmin && userId !== this._currentUser.id) return { error: 'Sin permisos' };
        const user = this._users.find(u => u.id === userId);
        if (!user) return { error: 'Usuario no encontrado' };
        if (updates.name) user.name = updates.name.trim();
        if ('email' in updates) user.email = updates.email.trim();
        if ('notifications' in updates) user.notifications = updates.notifications;
        // Password updates are only handled server-side now; ignore offline
        this.saveUsers();
        if (userId === this._currentUser.id) {
            if (updates.name) this._currentUser.name = user.name;
            if ('email' in updates) this._currentUser.email = user.email;
            if ('notifications' in updates) this._currentUser.notifications = user.notifications;
            this.saveSession();
        }
        return { success: true };
    }
};

// ===== DATA LAYER =====
const Store = {
    _data: { versions: [], activeVersionId: null, activeListId: null },

    load() {
        // Use server-injected data if available (instant, no fetch needed)
        if (window.__SERVER_DATA__ && window.__SERVER_DATA__.store) {
            this._data = window.__SERVER_DATA__.store;
            localStorage.setItem('bugtracker_data', JSON.stringify(this._data));
        } else {
            const saved = localStorage.getItem('bugtracker_data');
            if (saved) this._data = JSON.parse(saved);
        }
    },
    async loadFromServer() {
        const data = await Sync.pull('store', 'bugtracker_data');
        if (data) {
            // Preserve local-only fields (activeVersionId, activeListId)
            data.activeVersionId = this._data.activeVersionId || data.activeVersionId;
            data.activeListId = this._data.activeListId || data.activeListId;
            this._data = data;
        }
    },
    save() {
        localStorage.setItem('bugtracker_data', JSON.stringify(this._data));
        // Push to server without activeVersionId/activeListId (those are per-session)
        const shared = { ...this._data };
        delete shared.activeVersionId;
        delete shared.activeListId;
        Sync.push('store', shared);
    },
    get data() { return this._data; },

    // Versions
    addVersion(name, desc) {
        const v = { id: crypto.randomUUID(), name, description: desc, lists: [], createdAt: Date.now() };
        this._data.versions.push(v);
        this.save();
        return v;
    },
    getVersion(id) { return this._data.versions.find(v => v.id === id); },
    deleteVersion(id) {
        this._data.versions = this._data.versions.filter(v => v.id !== id);
        if (this._data.activeVersionId === id) { this._data.activeVersionId = null; this._data.activeListId = null; }
        this.save();
    },

    // Lists
    addList(versionId, name, color) {
        const v = this.getVersion(versionId);
        if (!v) return null;
        const l = { id: crypto.randomUUID(), name, color, bugs: [], createdAt: Date.now() };
        (v.lists || []).push(l);
        this.save();
        return l;
    },
    getList(versionId, listId) {
        const v = this.getVersion(versionId);
        return v ? (v.lists || []).find(l => l.id === listId) : null;
    },
    deleteList(versionId, listId) {
        const v = this.getVersion(versionId);
        if (v) {
            v.lists = (v.lists || []).filter(l => l.id !== listId);
            if (this._data.activeListId === listId) this._data.activeListId = null;
            this.save();
        }
    },

    // Bugs
    addBug(versionId, listId, bug) {
        const l = this.getList(versionId, listId);
        if (!l) return null;
        const b = { id: crypto.randomUUID(), createdBy: Auth.user?.name || 'Anónimo', createdByUser: Auth.user?.username || '', ...bug, comments: [], createdAt: Date.now(), updatedAt: Date.now() };
        l.bugs.push(b);
        this.save();
        return b;
    },
    getBug(versionId, listId, bugId) {
        const l = this.getList(versionId, listId);
        return l ? l.bugs.find(b => b.id === bugId) : null;
    },
    updateBug(versionId, listId, bugId, updates) {
        const b = this.getBug(versionId, listId, bugId);
        if (b) { Object.assign(b, updates, { updatedAt: Date.now() }); this.save(); }
        return b;
    },
    deleteBug(versionId, listId, bugId) {
        const l = this.getList(versionId, listId);
        if (l) { l.bugs = l.bugs.filter(b => b.id !== bugId); this.save(); }
    },

    // Comments
    addComment(versionId, listId, bugId, text) {
        const b = this.getBug(versionId, listId, bugId);
        if (!b) return null;
        const c = { id: crypto.randomUUID(), text, author: Auth.user?.name || 'Anónimo', authorUser: Auth.user?.username || '', createdAt: Date.now() };
        b.comments.push(c);
        b.updatedAt = Date.now();
        this.save();
        return c;
    },

    setActive(versionId, listId) {
        this._data.activeVersionId = versionId;
        this._data.activeListId = listId;
        this.save();
        if (typeof closeSidebar === 'function') closeSidebar();
    },

    // Ensure a default version always exists (hidden from UI)
    ensureDefaultVersion() {
        if (this._data.versions.length === 0) {
            const v = { id: crypto.randomUUID(), name: '__default__', description: '', lists: [], createdAt: Date.now() };
            this._data.versions.push(v);
            this.save();
        }
        // Always auto-select the first version
        this._data.activeVersionId = this._data.versions[0].id;
    },

    get defaultVersionId() {
        return this._data.versions.length > 0 ? this._data.versions[0].id : null;
    }
};

// ===== THEME MANAGEMENT =====
const ThemeManager = {
    themes: ['dark', 'twilight', 'light'],
    icons: { dark: '🌙', twilight: '🌗', light: '☀️' },
    labels: { dark: 'Oscuro', twilight: 'Crepúsculo', light: 'Claro' },

    init() {
        const saved = localStorage.getItem('bugtracker_theme');
        if (saved && this.themes.includes(saved)) {
            this.apply(saved);
        }
    },
    current() {
        return document.documentElement.getAttribute('data-theme') || 'dark';
    },
    apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('bugtracker_theme', theme);
        const btn = document.getElementById('btn-theme');
        if (btn) {
            btn.textContent = this.icons[theme];
            btn.title = 'Tema: ' + this.labels[theme];
        }
    },
    toggle() {
        const idx = this.themes.indexOf(this.current());
        const next = this.themes[(idx + 1) % this.themes.length];
        this.apply(next);
    }
};
ThemeManager.init();

// ===== UI HELPERS =====
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

function formatFullDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Searchable date strings for matching user queries like "15 may", "2026", "09:15"
function getSearchableDateStrings(ts) {
    const d = new Date(ts);
    return [
        d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }),
        d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' }),
        d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        d.getFullYear().toString()
    ].join(' ');
}

const statusLabels = { 'new': 'Nuevo', 'in-progress': 'En curso', 'passed': 'Pasado', 'failed': 'Fallido' };
const priorityLabels = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };

// Search state
let currentSearchQuery = '';
let globalSearchQuery = '';

// Global filter state
let globalFilter = null;

// Collect ALL bugs across all versions/lists
function getAllBugs() {
    const all = [];
    Store.data.versions.forEach(v => {
        (v.lists || []).forEach(l => {
            l.bugs.forEach(b => all.push({ ...b, _versionId: v.id, _listId: l.id, _versionName: v.name, _listName: l.name }));
        });
    });
    return all;
}

// Match a bug against a search query
function matchesBugSearch(b, q) {
    // Text fields (case-insensitive substring match)
    const textFields = [
        b.title, b.description, b.client, b.swVersion,
        b.createdBy, b.assignee, b.resolvedBy, b.resolvedVersion,
        statusLabels[b.status], priorityLabels[b.priority],
        b._listName, b._versionName
    ];
    if (textFields.some(f => f && f.toLowerCase().includes(q))) return true;

    // Date matching: only createdAt, no updatedAt
    // Only try when query looks like a date (starts with number, contains month name, or has / separator)
    if (/^(\d|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/i.test(q)) {
        const d = new Date(b.createdAt);
        const dateStrs = [
            d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }),
            d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' }),
            d.toLocaleDateString('es-ES', { day: '2-digit', month: 'numeric', year: 'numeric' }),
            d.getFullYear().toString()
        ].join(' ');
        if (dateStrs.toLowerCase().includes(q.toLowerCase())) return true;
    }
    return false;
}
// ===== RENDER FUNCTIONS =====
function renderVersionList() {
    // Versions are now hidden – no UI to render
}

function renderListList() {
    const container = $('#list-list');
    container.innerHTML = '';
    const v = Store.getVersion(Store.defaultVersionId);
    if (!v) return;
    if ((v.lists || []).length === 0) {
        container.innerHTML = '<div style="padding:0.5rem;font-size:0.78rem;color:var(--text-muted)">Sin listas aún</div>';
        return;
    }
    (v.lists || []).forEach(l => {
        const el = document.createElement('div');
        el.className = `sidebar-item${l.id === Store.data.activeListId ? ' active' : ''}`;
        el.innerHTML = `
            <span class="item-dot" style="background:${l.color}"></span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.name}</span>
            <span class="item-count">${l.bugs.filter(b => !b.resolvedBy).length}</span>
            ${Auth.isAdmin ? `<div class="item-actions">
                <button class="item-action-btn delete" data-delete-list="${l.id}" title="Eliminar">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>` : ''}`;
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-delete-list]')) return;
            globalFilter = null;
            Store.setActive(Store.defaultVersionId, l.id);
            render();
        });
        container.appendChild(el);
    });

    container.querySelectorAll('[data-delete-list]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const list = Store.getList(Store.defaultVersionId, btn.dataset.deleteList);
            confirmAction(`¿Eliminar la lista "${list?.name}" y todas sus tareas?`, () => {
                Store.deleteList(Store.defaultVersionId, btn.dataset.deleteList);
                render();
            });
        });
    });
}

function renderBugList() {
    const emptyState = $('#empty-state');
    const bugArea = $('#bug-area');

    const isShowingList = globalFilter || Store.data.activeListId;
    document.body.classList.toggle('list-active', !!isShowingList);

    const searchInput = $('#global-search-input');
    if (Store.data.activeListId) {
        searchInput.placeholder = 'Buscar en esta lista...';
    } else {
        searchInput.placeholder = 'Buscar en todas las listas...';
    }

    // GLOBAL SEARCH MODE: search across ALL bugs
    if (globalSearchQuery) {
        emptyState.style.display = 'none';
        bugArea.style.display = 'block';

        const q = globalSearchQuery.toLowerCase();
        let results = getAllBugs().filter(b => matchesBugSearch(b, q));

        const activeFilter = $('.filter-btn.active')?.dataset.filter || 'all';
        if (activeFilter !== 'all') results = results.filter(b => b.status === activeFilter);

        $('#current-list-title').textContent = `Resultados: "${globalSearchQuery}"`;
        $('#current-list-count').textContent = results.length;
        renderSearchTags(results);
        renderBugCards(results, true);
        return;
    }

    // SIDEBAR FILTER MODE: show bugs from ALL lists matching a field
    if (globalFilter) {
        emptyState.style.display = 'none';
        bugArea.style.display = 'block';

        // Special mode: show all resolved tasks
        if (globalFilter.type === 'resolvedTasks') {
            $('#current-list-title').textContent = '✅ Tareas resueltas';
            let allBugs = getAllBugs().filter(b => b.resolvedBy);
            const activeFilter = $('.filter-btn.active')?.dataset.filter || 'all';
            if (activeFilter !== 'all') allBugs = allBugs.filter(b => b.status === activeFilter);
            if (currentSearchQuery) {
                const q = currentSearchQuery.toLowerCase();
                allBugs = allBugs.filter(b => matchesBugSearch(b, q));
            }
            $('#current-list-count').textContent = allBugs.length;
            renderSearchTags(allBugs);
            renderBugCards(allBugs, true);
            return;
        }

        const filterLabels = { swVersion: 'Versión SW', createdBy: 'Tester', assignee: 'Asignado', client: 'Cliente', status: 'Estado' };
        
        if (globalFilter.type === 'allTasks') {
            $('#current-list-title').textContent = 'Todas las tareas';
        } else {
            $('#current-list-title').textContent = `${filterLabels[globalFilter.type] || globalFilter.type}: ${globalFilter.value || 'Todas'}`;
        }

        // For assignee filter, match any of the comma-separated values
        let allBugs;
        if (globalFilter.type === 'allTasks') {
            allBugs = getAllBugs(); // Include all tasks to match the Total counter
        } else if (globalFilter.type === 'assignee') {
            allBugs = getAllBugs().filter(b => getAssignees(b).includes(globalFilter.value));
        } else if (globalFilter.type === 'status') {
            allBugs = getAllBugs().filter(b => b.status === globalFilter.value && !b.resolvedBy);
        } else {
            allBugs = getAllBugs().filter(b => b[globalFilter.type] === globalFilter.value);
        }
        const activeFilter = $('.filter-btn.active')?.dataset.filter || 'all';
        if (activeFilter !== 'all') allBugs = allBugs.filter(b => b.status === activeFilter);
        if (currentSearchQuery) {
            const q = currentSearchQuery.toLowerCase();
            allBugs = allBugs.filter(b => matchesBugSearch(b, q));
        }
        $('#current-list-count').textContent = allBugs.length;
        renderSearchTags(allBugs);
        renderBugCards(allBugs, true);
        return;
    }

    if (!Store.data.activeListId) {
        bugArea.style.display = 'none';
        emptyState.style.display = 'flex';
        const version = Store.getVersion(Store.defaultVersionId);
        if (version && version.lists.length > 0) {
            emptyState.querySelector('h2').textContent = 'Selecciona una lista';
            emptyState.querySelector('p').textContent = 'Elige una lista del panel lateral';
        } else {
            emptyState.querySelector('h2').textContent = 'Comienza creando una lista';
            emptyState.querySelector('p').innerHTML = 'Haz clic en el botón <strong>+</strong> junto a "Listas" para empezar';
        }
        return;
    }

    const list = Store.getList(Store.data.activeVersionId, Store.data.activeListId);
    if (!list) return;

    emptyState.style.display = 'none';
    bugArea.style.display = 'block';

    $('#current-list-title').textContent = list.name;
    $('#current-list-count').textContent = list.bugs.filter(b => !b.resolvedBy).length;

    const container = $('#bug-list');
    const activeFilter = $('.filter-btn.active')?.dataset.filter || 'all';
    let filteredBugs = activeFilter === 'all' ? [...list.bugs] : list.bugs.filter(b => b.status === activeFilter);

    // Hide resolved tasks from normal list view
    filteredBugs = filteredBugs.filter(b => !b.resolvedBy);

    // Apply local search
    if (currentSearchQuery) {
        const q = currentSearchQuery.toLowerCase();
        filteredBugs = filteredBugs.filter(b => matchesBugSearch(b, q));
    }

    // Render active search tags
    renderSearchTags(filteredBugs);

    if (filteredBugs.length === 0) {
        container.innerHTML = `<div class="empty-state" style="height:30vh">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <p>${activeFilter === 'all' ? 'No hay tareas. ¡Haz clic en "Nueva Tarea" para añadir una!' : 'No hay tareas con este filtro'}</p>
        </div>`;
        return;
    }

    renderBugCards(filteredBugs, false);
}

// ===== SORTING =====
const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
const statusOrder = { 'new': 0, 'in-progress': 1, 'failed': 2, 'passed': 3 };

function sortBugs(bugs) {
    const sortBy = document.getElementById('sort-select')?.value || 'newest';
    const sorted = [...bugs];
    switch (sortBy) {
        case 'newest':      sorted.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break;
        case 'oldest':      sorted.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); break;
        case 'priority-high': sorted.sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9)); break;
        case 'priority-low':  sorted.sort((a, b) => (priorityOrder[b.priority] ?? 9) - (priorityOrder[a.priority] ?? 9)); break;
        case 'status':      sorted.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)); break;
        case 'title':       sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
        case 'assignee':    sorted.sort((a, b) => (getAssignees(a)[0] || 'zzz').localeCompare(getAssignees(b)[0] || 'zzz')); break;
        case 'client':      sorted.sort((a, b) => (a.client || 'zzz').localeCompare(b.client || 'zzz')); break;
    }
    return sorted;
}

// Reusable card renderer
function renderBugCards(bugs, isCrossListView) {
    const container = $('#bug-list');
    bugs = sortBugs(bugs);

    container.innerHTML = bugs.map(b => `
        <div class="bug-card" data-bug-id="${b.id}" ${isCrossListView ? `data-version-id="${b._versionId}" data-list-id="${b._listId}"` : ''}>
            <div class="bug-status-indicator ${b.status}"></div>
            <div class="bug-info">
                <div class="bug-title-row">
                    <span class="bug-title">${escapeHtml(b.title)}</span>
                    <span class="bug-priority ${b.priority}">${priorityLabels[b.priority]}</span>
                </div>
                ${b.description ? `<div class="bug-desc">${escapeHtml(b.description)}</div>` : ''}
                <div class="bug-meta">
                    <span class="bug-meta-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        ${formatShortDate(b.createdAt)}
                    </span>
                    <span class="bug-meta-item">${statusLabels[b.status]}</span>
                    ${b.createdBy ? `<span class="bug-meta-item">✏️ ${escapeHtml(b.createdBy)}</span>` : ''}
                    ${getAssignees(b).map(a => `<span class="bug-meta-item">👤 ${escapeHtml(a)}</span>`).join('')}
                    ${b.comments.length > 0 ? `<span class="bug-meta-item">💬 ${b.comments.length}</span>` : ''}
                    ${isCrossListView && b._listName ? `<span class="bug-meta-item">📋 ${escapeHtml(b._listName)}</span>` : ''}
                </div>
                <div class="bug-tags">
                    <span class="bug-tag tag-date">📅 ${formatFullDate(b.createdAt)}</span>
                    ${b.client ? `<span class="bug-tag tag-client">🏢 ${escapeHtml(b.client)}</span>` : ''}
                    ${b.swVersion ? `<span class="bug-tag tag-version">📌 ${escapeHtml(b.swVersion)}</span>` : ''}
                </div>
                ${b.resolvedBy ? `<div class="bug-resolved-info">
                    <span>✅ Resuelta por: <strong>${escapeHtml(b.resolvedBy)}</strong></span>
                    ${b.resolvedVersion ? `<span>📌 En versión: <strong>${escapeHtml(b.resolvedVersion)}</strong></span>` : ''}
                    ${b.resolvedAt ? `<span>📅 ${formatShortDate(b.resolvedAt)}</span>` : ''}
                    ${b.resolvedByUser ? `<span>👤 Marcada por: ${escapeHtml(b.resolvedByUser)}</span>` : ''}
                </div>` : `<div class="bug-tags" style="margin-top:0.2rem"><button class="btn-resolve" data-resolve-bug="${b.id}" title="Marcar como resuelta">✅ Tarea resuelta</button></div>`}
            </div>
            <div class="bug-card-actions">
                <button class="item-action-btn" data-edit-bug="${b.id}" title="Editar">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                ${Auth.isAdmin ? `<button class="item-action-btn delete" data-delete-bug="${b.id}" title="Eliminar">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>` : ''}
            </div>
        </div>
    `).join('');

    // Click handlers
    container.querySelectorAll('.bug-card').forEach(card => {
        const bugId = card.dataset.bugId;
        const vId = isCrossListView ? card.dataset.versionId : Store.data.activeVersionId;
        const lId = isCrossListView ? card.dataset.listId : Store.data.activeListId;

        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-edit-bug]') || e.target.closest('[data-delete-bug]') || e.target.closest('[data-resolve-bug]')) return;
            openBugDetailWithContext(bugId, vId, lId);
        });
    });

    // Resolve button handlers
    container.querySelectorAll('[data-resolve-bug]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.bug-card');
            const vId = isCrossListView ? card.dataset.versionId : Store.data.activeVersionId;
            const lId = isCrossListView ? card.dataset.listId : Store.data.activeListId;
            openResolveModal(btn.dataset.resolveBug, vId, lId);
        });
    });

    container.querySelectorAll('[data-edit-bug]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.bug-card');
            const vId = isCrossListView ? card.dataset.versionId : Store.data.activeVersionId;
            const lId = isCrossListView ? card.dataset.listId : Store.data.activeListId;
            openBugModalWithContext(btn.dataset.editBug, vId, lId);
        });
    });

    container.querySelectorAll('[data-delete-bug]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.bug-card');
            const vId = isCrossListView ? card.dataset.versionId : Store.data.activeVersionId;
            const lId = isCrossListView ? card.dataset.listId : Store.data.activeListId;
            const bug = Store.getBug(vId, lId, btn.dataset.deleteBug);
            confirmAction(`¿Eliminar la tarea "${bug?.title}"?`, () => {
                Store.deleteBug(vId, lId, btn.dataset.deleteBug);
                render();
            });
        });
    });
}

function renderStats() {
    let total = 0, open = 0, progress = 0, resolved = 0;
    Store.data.versions.forEach(v => {
        (v.lists || []).forEach(l => {
            l.bugs.forEach(b => {
                total++;
                if (b.resolvedBy) { resolved++; }
                else if (b.status === 'new') open++;
                else if (b.status === 'in-progress') progress++;
                else if (b.status === 'passed' || b.status === 'failed') resolved++;
            });
        });
    });
    $('#stat-total .stat-value').textContent = total;
    $('#stat-open .stat-value').textContent = open;
    $('#stat-progress .stat-value').textContent = progress;
    $('#stat-resolved .stat-value').textContent = resolved;
}

function render() {
    renderVersionList();
    renderListList();
    renderSidebarFilters();
    renderBugList();
    renderStats();
}

// ===== SIDEBAR FILTER SECTIONS =====
function renderSidebarFilters() {
    const allBugs = getAllBugs();
    const sections = [
        { id: 'filter-sw-versions', field: 'swVersion', type: 'swVersion' },
        { id: 'filter-creators', field: 'createdBy', type: 'createdBy' },
        { id: 'filter-assignees', field: 'assignee', type: 'assignee' },
        { id: 'filter-clients', field: 'client', type: 'client' }
    ];

    sections.forEach(sec => {
        const container = document.getElementById(sec.id);
        if (!container) return;

        // Collect unique values with open/resolved counts
        const map = new Map();
        allBugs.forEach(b => {
            // For assignee field, split comma-separated values
            const vals = sec.field === 'assignee' ? getAssignees(b) : (b[sec.field] ? [b[sec.field]] : []);
            vals.forEach(val => {
                if (!val) return;
                if (!map.has(val)) map.set(val, { open: 0, resolved: 0 });
                const entry = map.get(val);
                if (b.resolvedBy || b.status === 'passed' || b.status === 'failed') entry.resolved++;
                else entry.open++;
            });
        });

        if (map.size === 0) {
            container.innerHTML = '<div class="filter-empty">—</div>';
            return;
        }

        container.innerHTML = Array.from(map.entries()).map(([val, counts]) => {
            const isActive = globalFilter && globalFilter.type === sec.type && globalFilter.value === val;
            return `<div class="filter-item${isActive ? ' active' : ''}" data-filter-type="${sec.type}" data-filter-value="${escapeHtml(val)}">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(val)}</span>
                <div class="filter-counts">
                    ${counts.open > 0 ? `<span class="filter-count-open">${counts.open}</span>` : ''}
                    ${counts.resolved > 0 ? `<span class="filter-count-resolved">${counts.resolved}</span>` : ''}
                </div>
            </div>`;
        }).join('');

        // Click handlers
        container.querySelectorAll('.filter-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.filterType;
                const value = item.dataset.filterValue;
                if (globalFilter && globalFilter.type === type && globalFilter.value === value) {
                    globalFilter = null; // Toggle off
                } else {
                    globalFilter = { type, value };
                    Store.setActive(null, null); // Deselect version/list
                }
                render();
                closeSidebar();
            });
        });
    });

    // Render "Tareas resueltas" as a single clickable item
    const resolvedContainer = document.getElementById('filter-resolvers');
    if (resolvedContainer) {
        const resolvedCount = allBugs.filter(b => b.resolvedBy).length;
        if (resolvedCount === 0) {
            resolvedContainer.innerHTML = '<div class="filter-empty">—</div>';
        } else {
            const isActive = globalFilter && globalFilter.type === 'resolvedTasks';
            resolvedContainer.innerHTML = `<div class="filter-item${isActive ? ' active' : ''}" id="sidebar-resolved-tasks">
                <span style="flex:1">📋 Ver todas</span>
                <div class="filter-counts">
                    <span class="filter-count-resolved">${resolvedCount}</span>
                </div>
            </div>`;
            resolvedContainer.querySelector('#sidebar-resolved-tasks').addEventListener('click', () => {
                if (globalFilter && globalFilter.type === 'resolvedTasks') {
                    globalFilter = null;
                } else {
                    globalFilter = { type: 'resolvedTasks' };
                    Store.setActive(null, null);
                }
                render();
            });
        }
    }
}

// Search tags rendering
function renderSearchTags(bugs) {
    const container = $('#search-tags');
    if (!container) return;
    if (!currentSearchQuery) { container.innerHTML = ''; return; }

    // Collect unique matching values
    const matches = new Map();
    const q = currentSearchQuery.toLowerCase();
    bugs.forEach(b => {
        if (b.client && b.client.toLowerCase().includes(q)) matches.set('cliente:' + b.client, { label: '🏢 ' + b.client, type: 'tag-client' });
        if (b.swVersion && b.swVersion.toLowerCase().includes(q)) matches.set('version:' + b.swVersion, { label: '📌 ' + b.swVersion, type: 'tag-version' });
        if (b.createdBy && b.createdBy.toLowerCase().includes(q)) matches.set('tester:' + b.createdBy, { label: '✏️ ' + b.createdBy, type: 'tag-creator' });
        getAssignees(b).forEach(a => { if (a.toLowerCase().includes(q)) matches.set('asignado:' + a, { label: '👤 ' + a, type: 'tag-assignee' }); });
        if (b.resolvedBy && b.resolvedBy.toLowerCase().includes(q)) matches.set('resuelto:' + b.resolvedBy, { label: '✅ ' + b.resolvedBy, type: 'tag-resolved' });
    });

    if (matches.size === 0) { container.innerHTML = ''; return; }
    container.innerHTML = Array.from(matches.values()).map(m =>
        `<span class="search-tag bug-tag ${m.type}">${m.label}</span>`
    ).join('');
}

// ===== DETAIL VIEW =====
let currentDetailBugId = null;
let currentDetailVersionId = null;
let currentDetailListId = null;

function openBugDetailWithContext(bugId, versionId, listId) {
    currentDetailBugId = bugId;
    currentDetailVersionId = versionId;
    currentDetailListId = listId;
    const bug = Store.getBug(versionId, listId, bugId);
    if (!bug) return;

    $('#detail-title').textContent = bug.title;
    $('#detail-meta').innerHTML = `
        <span class="detail-tag" style="border-color:${bug.status === 'new' ? 'var(--accent)' : bug.status === 'in-progress' ? 'var(--warning)' : bug.status === 'passed' ? 'var(--success)' : 'var(--danger)'}">${statusLabels[bug.status]}</span>
        <span class="detail-tag">${priorityLabels[bug.priority]} prioridad</span>
        ${getAssignees(bug).map(a => `<span class="detail-tag">👤 ${escapeHtml(a)}</span>`).join('')}
        ${bug.createdBy ? `<span class="detail-tag">✏️ Tester: ${escapeHtml(bug.createdBy)}</span>` : ''}
        ${bug.client ? `<span class="detail-tag">🏢 Cliente: ${escapeHtml(bug.client)}</span>` : ''}
        ${bug.swVersion ? `<span class="detail-tag">📌 Versión: ${escapeHtml(bug.swVersion)}</span>` : ''}
        <span class="detail-tag">Creado: ${formatDate(bug.createdAt)}</span>
        <span class="detail-tag">Actualizado: ${formatDate(bug.updatedAt)}</span>
        ${bug.resolvedBy ? `<span class="detail-tag" style="border-color:var(--success);color:var(--success)">✅ Resuelta por: ${escapeHtml(bug.resolvedBy)}</span>` : ''}
        ${bug.resolvedVersion ? `<span class="detail-tag" style="border-color:var(--success)">📌 Versión resolución: ${escapeHtml(bug.resolvedVersion)}</span>` : ''}
        ${bug.resolvedAt ? `<span class="detail-tag" style="border-color:var(--success)">📅 Resuelta: ${formatDate(bug.resolvedAt)}</span>` : ''}
        ${bug.resolvedByUser ? `<span class="detail-tag" style="border-color:var(--success)">👤 Marcada por: ${escapeHtml(bug.resolvedByUser)}</span>` : ''}
    `;
    $('#detail-description').textContent = bug.description || 'Sin descripción';
    renderComments(bug);
    renderFollowersSection(bug);
    openModal('modal-detail');
}

function openBugDetail(bugId) {
    openBugDetailWithContext(bugId, Store.data.activeVersionId, Store.data.activeListId);
}

function renderComments(bug) {
    const container = $('#comments-list');
    if (!bug.comments || bug.comments.length === 0) {
        container.innerHTML = '<div class="no-comments">Sin comentarios aún</div>';
        return;
    }
    const isAdmin = Auth.isAdmin;
    const currentUser = Auth.user?.username || '';
    container.innerHTML = bug.comments.map(c => {
        const canEdit = isAdmin || c.authorUser === currentUser;
        const editedInfo = c.editedAt
            ? ' (editado por ' + (c.editedBy || 'alguien') + ' ' + formatDate(c.editedAt) + ')'
            : '';
        return '<div class="comment-item" data-comment-id="' + c.id + '">' +
            '<div class="comment-header">' +
                '<span class="comment-author">' + escapeHtml(c.author || 'Anónimo') + '</span>' +
                '<span class="comment-date">' + formatDate(c.createdAt) + editedInfo + '</span>' +
                (canEdit ? '<button class="comment-edit-btn" onclick="startEditComment(\'' + c.id + '\')" title="Editar">✏️</button>' : '') +
                (canEdit ? '<button class="comment-delete-btn" onclick="deleteComment(\'' + c.id + '\')" title="Eliminar">🗑️</button>' : '') +
            '</div>' +
            '<div class="comment-text" id="comment-body-' + c.id + '">' + escapeHtml(c.text) + '</div>' +
        '</div>';
    }).join('');
    container.scrollTop = container.scrollHeight;
}

// ===== INLINE COMMENT EDITING =====
function startEditComment(commentId) {
    const body = document.getElementById('comment-body-' + commentId);
    if (!body || body.querySelector('textarea')) return;
    const oldText = body.textContent;
    body.setAttribute('data-original-text', oldText);
    body.innerHTML = '<textarea id="edit-textarea-' + commentId + '" class="comment-edit-textarea">' + escapeHtml(oldText) + '</textarea>' +
        '<div class="comment-edit-actions">' +
            '<button class="btn-sm btn-save" onclick="saveEditComment(\'' + commentId + '\')">💾 Guardar</button>' +
            '<button class="btn-sm btn-cancel-edit" onclick="cancelEditComment(\'' + commentId + '\')">✕ Cancelar</button>' +
        '</div>';
    const ta = document.getElementById('edit-textarea-' + commentId);
    if (ta) { ta.focus(); ta.selectionStart = ta.value.length; }
}

async function saveEditComment(commentId) {
    const ta = document.getElementById('edit-textarea-' + commentId);
    if (!ta) return;
    const newText = ta.value.trim();
    if (!newText) { alert('El comentario no puede estar vacío.'); return; }
    const token = localStorage.getItem('bugtracker_token');
    if (!token) { alert('No estás autenticado.'); return; }
    try {
        const res = await fetch('/api/comments', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ bugId: currentDetailBugId, commentId, text: newText })
        });
        const result = await res.json();
        if (result.ok) {
            await Store.loadFromServer();
            const refreshed = Store.getBug(
                currentDetailVersionId || Store.data.activeVersionId,
                currentDetailListId || Store.data.activeListId,
                currentDetailBugId
            );
            if (refreshed) renderComments(refreshed);
        } else {
            alert('❌ Error: ' + (result.error || 'No se pudo guardar'));
        }
    } catch (e) {
        alert('Error al guardar: ' + e.message);
    }
}

function cancelEditComment(commentId) {
    const body = document.getElementById('comment-body-' + commentId);
    if (!body) return;
    const originalText = body.getAttribute('data-original-text') || '';
    body.innerHTML = escapeHtml(originalText);
    body.removeAttribute('data-original-text');
}

// ===== DELETE COMMENT =====
function deleteComment(commentId) {
    confirmAction('¿Eliminar este comentario? Esta acción no se puede deshacer.', async () => {
        const token = localStorage.getItem('bugtracker_token');
        if (!token) { alert('No estás autenticado.'); return; }
        try {
            const res = await fetch('/api/comments', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ bugId: currentDetailBugId, commentId })
            });
            const result = await res.json();
            if (result.ok) {
                await Store.loadFromServer();
                const refreshed = Store.getBug(
                    currentDetailVersionId || Store.data.activeVersionId,
                    currentDetailListId || Store.data.activeListId,
                    currentDetailBugId
                );
                if (refreshed) renderComments(refreshed);
            } else {
                alert('❌ Error: ' + (result.error || 'No se pudo eliminar'));
            }
        } catch (e) {
            alert('Error al eliminar: ' + e.message);
        }
    });
}

// ===== BUG MODAL =====
let editingBugId = null;
let editingVersionId = null;
let editingListId = null;

// Resolve modal state
let resolvingBugId = null;
let resolvingVersionId = null;
let resolvingListId = null;

function openResolveModal(bugId, versionId, listId) {
    resolvingBugId = bugId;
    resolvingVersionId = versionId;
    resolvingListId = listId;
    $('#resolve-who').value = '';
    $('#resolve-version').value = '';
    openModal('modal-resolve');
    setTimeout(() => $('#resolve-who').focus(), 100);
}

function openBugModalWithContext(bugId, versionId, listId) {
    editingBugId = bugId;
    editingVersionId = versionId;
    editingListId = listId;
    if (bugId) {
        const bug = Store.getBug(versionId, listId, bugId);
        if (!bug) return;
        $('#modal-bug-title').textContent = 'Editar Tarea';
        $('#bug-title').value = bug.title;
        $('#bug-description').value = bug.description || '';
        $('#bug-priority').value = bug.priority;
        $('#bug-status').value = bug.status;
        $('#bug-assignee').value = bug.assignee || '';
        $('#bug-client').value = bug.client || '';
        $('#bug-sw-version').value = bug.swVersion || '';
        $('#bug-created-by').value = bug.createdBy || '';
    } else {
        $('#modal-bug-title').textContent = 'Nueva Tarea';
        $('#bug-title').value = '';
        $('#bug-description').value = '';
        $('#bug-priority').value = 'medium';
        $('#bug-status').value = 'new';
        $('#bug-assignee').value = '';
        $('#bug-client').value = '';
        $('#bug-sw-version').value = '';
        $('#bug-created-by').value = Auth.user?.name || '';
    }
    
    if (Auth.user?.role === 'admin') {
        $('#row-bug-created-by').style.display = 'flex';
    } else {
        $('#row-bug-created-by').style.display = 'none';
    }
    openModal('modal-bug');
    setTimeout(() => $('#bug-title').focus(), 100);
}

function openBugModal(bugId = null) {
    openBugModalWithContext(bugId, Store.data.activeVersionId, Store.data.activeListId);
}

// ===== CONFIRM DIALOG =====
let pendingConfirmAction = null;

function confirmAction(message, callback) {
    $('#confirm-message').textContent = message;
    pendingConfirmAction = callback;
    openModal('modal-confirm');
}

// ===== UTILITY =====
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Parse comma-separated assignees into an array
function getAssignees(bug) {
    if (!bug.assignee) return [];
    return bug.assignee.split(',').map(s => s.trim()).filter(Boolean);
}

// ===== REPORT GENERATOR =====
function openReportModal() {
    const allBugs = getAllBugs();

    // Populate client dropdown
    const clients = [...new Set(allBugs.map(b => b.client).filter(Boolean))].sort();
    const clientSel = $('#report-client');
    clientSel.innerHTML = '<option value="">— Todos —</option>' + clients.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    // Populate SW version dropdown
    const versions = [...new Set(allBugs.map(b => b.swVersion).filter(Boolean))].sort();
    const versionSel = $('#report-sw-version');
    versionSel.innerHTML = '<option value="">— Todas —</option>' + versions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');

    // Populate list dropdown
    const lists = [];
    Store.data.versions.forEach(v => (v.lists || []).forEach(l => lists.push({ id: l.id, name: l.name })));
    const listSel = $('#report-list');
    listSel.innerHTML = '<option value="">— Todas —</option>' + lists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');

    // Reset dates
    $('#report-date-from').value = '';
    $('#report-date-to').value = '';
    $('#report-status').value = '';
    $('#report-include-resolved').checked = true;
    $('#report-include-comments').checked = false;

    openModal('modal-report');
}

function generateReport() {
    let bugs = getAllBugs();

    // Apply filters
    const dateFrom = $('#report-date-from').value;
    const dateTo = $('#report-date-to').value;
    const client = $('#report-client').value;
    const swVersion = $('#report-sw-version').value;
    const listId = $('#report-list').value;
    const status = $('#report-status').value;
    const includeResolved = $('#report-include-resolved').checked;
    const includeComments = $('#report-include-comments').checked;

    if (dateFrom) {
        const from = new Date(dateFrom).setHours(0, 0, 0, 0);
        bugs = bugs.filter(b => b.createdAt >= from);
    }
    if (dateTo) {
        const to = new Date(dateTo).setHours(23, 59, 59, 999);
        bugs = bugs.filter(b => b.createdAt <= to);
    }
    if (client) bugs = bugs.filter(b => b.client === client);
    if (swVersion) bugs = bugs.filter(b => b.swVersion === swVersion);
    if (listId) bugs = bugs.filter(b => b._listId === listId);
    if (status) bugs = bugs.filter(b => b.status === status);
    if (!includeResolved) bugs = bugs.filter(b => !b.resolvedBy);

    // Sort order for reports:
    // 1) Status: new (0) → in-progress (1) → resolved/passed (2)
    // 2) Priority: critical (0) → high (1) → medium (2) → low (3)
    // 3) Date: oldest first
    const pOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    bugs.sort((a, b) => {
        const sa = a.resolvedBy ? 2 : a.status === 'new' ? 0 : 1;
        const sb = b.resolvedBy ? 2 : b.status === 'new' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const pa = pOrder[a.priority] ?? 9;
        const pb = pOrder[b.priority] ?? 9;
        if (pa !== pb) return pa - pb;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // Build filter description
    const filterParts = [];
    if (dateFrom || dateTo) filterParts.push(`Período: ${dateFrom || '...'} → ${dateTo || '...'}`);
    if (client) filterParts.push(`Cliente: ${client}`);
    if (swVersion) filterParts.push(`Versión SW: ${swVersion}`);
    if (listId) filterParts.push(`Lista: ${bugs[0]?._listName || listId}`);
    if (status) filterParts.push(`Estado: ${statusLabels[status]}`);
    if (!includeResolved) filterParts.push('Sin tareas resueltas');

    // Stats
    const totalOpen = bugs.filter(b => !b.resolvedBy && b.status === 'new').length;
    const totalProgress = bugs.filter(b => !b.resolvedBy && b.status === 'in-progress').length;
    const totalResolved = bugs.filter(b => b.resolvedBy).length;

    const now = new Date();
    const reportDate = now.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Reporte de Tareas — ${reportDate}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1a1a2e; padding: 1.5rem 2rem; max-width: 1200px; margin: 0 auto; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 1.4rem; color: #1a1a2e; display: inline; margin-right: 0.8rem; }
  .report-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.4rem; }
  .report-meta { color: #555; font-size: 0.75rem; font-weight: 500; }
  .report-filters { color: #666; font-size: 0.75rem; margin-bottom: 0.8rem; padding-bottom: 0.6rem; border-bottom: 1px solid #ddd; }
  .stats-bar { display: inline-flex; gap: 0.15rem; margin-bottom: 0.8rem; font-size: 0.7rem; }
  .stat-pill { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.25rem 0.6rem; border-radius: 20px; background: #f3f4f6; font-weight: 500; }
  .stat-pill .num { font-weight: 700; font-size: 0.85rem; }
  .stat-pill.total { background: #e8e5ff; color: #4f46e5; }
  .stat-pill.open { background: #ede9fe; color: #6366f1; }
  .stat-pill.progress { background: #fef3c7; color: #b45309; }
  .stat-pill.resolved { background: #d1fae5; color: #047857; }

  .task-list { display: block; }
  .task-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.7rem 0.9rem; background: #fff; page-break-inside: avoid; break-inside: avoid; margin-bottom: 0.8rem; }
  .task-header { display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 0.4rem; }
  .task-num { background: #4f46e5; color: white; font-size: 0.72rem; font-weight: 700; min-width: 1.45rem; height: 1.45rem; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; flex-shrink: 0; box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2); margin-top: 0.1rem; }
  .task-title { font-weight: 700; font-size: 0.95rem; color: #1a1a2e; flex: 1; padding-top: 0.15rem; }
  .task-badges { display: flex; gap: 0.3rem; flex-shrink: 0; }
  .badge { display: inline-block; padding: 0.12rem 0.5rem; border-radius: 10px; font-size: 0.62rem; font-weight: 600; white-space: nowrap; }
  .badge-new { background: #e8e5ff; color: #6366f1; }
  .badge-progress { background: #fef3c7; color: #d97706; }
  .badge-passed { background: #d1fae5; color: #059669; }
  .badge-failed { background: #fee2e2; color: #dc2626; }
  .priority-critical { background: #fee2e2; color: #dc2626; }
  .priority-high { background: #ffedd5; color: #c2410c; }
  .priority-medium { background: #fef9c3; color: #a16207; }
  .priority-low { background: #dcfce7; color: #15803d; }
  .task-desc { color: #444; font-size: 0.82rem; margin: 0.3rem 0 0.4rem 0; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
  .task-meta { display: flex; flex-wrap: wrap; gap: 0.4rem 0.5rem; font-size: 0.75rem; margin-top: 0.6rem; }
  .task-meta span { display: inline-flex; align-items: center; gap: 0.25rem; background: #f8fafc; color: #475569; padding: 0.2rem 0.5rem; border-radius: 6px; border: 1px solid #e2e8f0; font-weight: 500; }
  .resolution-box { margin-top: 0.6rem; padding: 0.5rem 0.8rem; background: #ecfdf5; border-left: 4px solid #10b981; border-radius: 0 6px 6px 0; font-size: 0.82rem; color: #065f46; }
  .comments-box { margin-top: 0.6rem; padding: 0.6rem 0.8rem; background: #f8fafc; border-left: 4px solid #6366f1; border-radius: 0 6px 6px 0; }
  .comments-title { font-size: 0.75rem; font-weight: 700; color: #4f46e5; margin-bottom: 0.4rem; }
  .comment { font-size: 0.82rem; color: #444; margin-bottom: 0.4rem; padding-bottom: 0.4rem; border-bottom: 1px solid #e8ecf0; line-height: 1.5; }
  .comment:last-child { margin-bottom: 0; border-bottom: none; padding-bottom: 0; }
  .comment-author { font-weight: 600; color: #334155; }
  .comment-date { color: #94a3b8; font-size: 0.68rem; }
  .footer { margin-top: 1.5rem; padding-top: 0.6rem; border-top: 1px solid #e0e0e0; text-align: center; color: #bbb; font-size: 0.65rem; }
  @media print {
    @page { margin: 0; }
    body { padding: 1.5cm; font-size: 11px; }
    .no-print { display: none !important; }
    .task-card { border: 1px solid #ccc; box-shadow: none; }
  }
</style>
</head>
<body>
  <div class="no-print" style="margin-bottom:0.8rem;display:flex;gap:0.5rem">
    <button onclick="window.print()" style="padding:0.4rem 1rem;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem">🖨️ Imprimir / PDF</button>
    <button id="btn-share" style="padding:0.4rem 1rem;background:#10b981;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;display:none;">📤 Compartir</button>
    <button onclick="window.close()" style="padding:0.4rem 1rem;background:#e5e5e5;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem">Cerrar</button>
  </div>

<script>
  if (navigator.share) {
      document.getElementById('btn-share').style.display = 'inline-block';
      document.getElementById('btn-share').onclick = async () => {
          try {
              const clone = document.documentElement.cloneNode(true);
              const noPrint = clone.querySelector('.no-print');
              if (noPrint) noPrint.remove();
              const htmlContent = '<!DOCTYPE html>\\n' + clone.outerHTML;
              const file = new File([htmlContent], 'Reporte_BugTracker.html', { type: 'text/html' });
              if (navigator.canShare && navigator.canShare({ files: [file] })) {
                  await navigator.share({
                      files: [file],
                      title: 'Reporte de Tareas',
                      text: 'Adjunto el reporte de tareas.'
                  });
              } else {
                  await navigator.share({
                      title: 'Reporte de Tareas',
                      text: 'Reporte generado con Bug Tracker. Abre este archivo en tu navegador.'
                  });
              }
          } catch (err) {
              console.log('Error al compartir:', err);
          }
      };
  }
</script>

<div class="report-header">
  <h1>📊 Reporte de Tareas</h1>
  <span class="report-meta">${reportDate} · ${Auth.user?.name || 'Sistema'}</span>
</div>
<div class="report-filters">${filterParts.length > 0 ? filterParts.join(' · ') : 'Todas las tareas'}</div>

<div class="stats-bar">
  <span class="stat-pill total"><span class="num">${bugs.length}</span> Total</span>
  <span class="stat-pill open"><span class="num">${totalOpen}</span> Abiertas</span>
  <span class="stat-pill progress"><span class="num">${totalProgress}</span> En curso</span>
  <span class="stat-pill resolved"><span class="num">${totalResolved}</span> Resueltas</span>
</div>

<div class="task-list">
${bugs.map((b, i) => {
    const statusClass = b.status === 'new' ? 'badge-new' : b.status === 'in-progress' ? 'badge-progress' : b.status === 'passed' ? 'badge-passed' : 'badge-failed';
    const priorityClass = 'priority-' + b.priority;
    const assignees = getAssignees(b).join(', ');
    const created = b.createdAt ? new Date(b.createdAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    let card = '<div class="task-card">';
    card += '<div class="task-header">';
    card += '<span class="task-num">' + (i + 1) + '</span>';
    card += '<span class="task-title">' + escapeHtml(b.title) + '</span>';
    card += '<div class="task-badges">';
    card += '<span class="badge ' + statusClass + '">' + (b.resolvedBy ? '✅ Resuelta' : statusLabels[b.status]) + '</span>';
    card += '<span class="badge ' + priorityClass + '">' + priorityLabels[b.priority] + '</span>';
    card += '</div></div>';
    if (b.description) card += '<div class="task-desc">' + escapeHtml(b.description) + '</div>';
    card += '<div class="task-meta">';
    if (b._listName) card += '<span>📋 ' + escapeHtml(b._listName) + '</span>';
    if (assignees) card += '<span>👤 ' + escapeHtml(assignees) + '</span>';
    if (b.client) card += '<span>🏢 ' + escapeHtml(b.client) + '</span>';
    if (b.swVersion) card += '<span>📌 ' + escapeHtml(b.swVersion) + '</span>';
    if (b.createdBy) card += '<span>✏️ ' + escapeHtml(b.createdBy) + '</span>';
    card += '<span>📅 ' + created + '</span></div>';
    if (b.resolvedBy) {
        card += '<div class="resolution-box">✅ Resuelta por: <strong>' + escapeHtml(b.resolvedBy) + '</strong>';
        if (b.resolvedVersion) card += ' · Versión: <strong>' + escapeHtml(b.resolvedVersion) + '</strong>';
        if (b.resolvedAt) card += ' · ' + new Date(b.resolvedAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
        if (b.resolvedByUser) card += ' · Marcada por: ' + escapeHtml(b.resolvedByUser);
        card += '</div>';
    }
    if (includeComments && b.comments && b.comments.length > 0) {
        card += '<div class="comments-box"><div class="comments-title">💬 Comentarios (' + b.comments.length + ')</div>';
        b.comments.forEach(c => {
            card += '<div class="comment"><span class="comment-author">' + escapeHtml(c.author || 'Anónimo') + '</span> <span class="comment-date">' + new Date(c.createdAt).toLocaleDateString('es-ES') + '</span><br>' + escapeHtml(c.text) + '</div>';
        });
        card += '</div>';
    }
    card += '</div>';
    return card;
}).join('')}
</div>

<div class="footer">Bug Tracker — Reporte generado automáticamente · ${reportDate}</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) alert('Por favor, permite las ventanas emergentes (pop-ups) para ver el reporte.');
    
    // Revoke the URL after a delay to free memory, but give the new window time to load
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    
    closeModal('modal-report');
}

// ===== MOBILE SIDEBAR =====
function toggleSidebar() {
    const sidebar = $('#sidebar');
    const backdrop = $('#sidebar-backdrop');
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('visible');
    document.body.classList.toggle('sidebar-open', sidebar.classList.contains('open'));
}
function closeSidebar() {
    setTimeout(() => {
        $('#sidebar').classList.remove('open');
        $('#sidebar-backdrop').classList.remove('visible');
        document.body.classList.remove('sidebar-open');
    }, 150);
}

// ===== EVENT LISTENERS =====
function initEvents() {
    // Mobile sidebar toggle
    $('#btn-sidebar-toggle').addEventListener('click', toggleSidebar);
    $('#sidebar-backdrop').addEventListener('click', closeSidebar);

    // Close modals
    document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
        if (el.classList.contains('modal-close') || el.classList.contains('btn-secondary')) {
            el.addEventListener('click', () => {
                const modalId = el.dataset.modal || el.closest('.modal-overlay')?.id;
                if (modalId) closeModal(modalId);
            });
        }
    });

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal(overlay.id);
        });
    });

    // Add list (no version selection needed)
    $('#btn-add-list').addEventListener('click', () => {
        $('#modal-list-title').textContent = 'Nueva Lista';
        $('#list-name').value = '';
        // Reset color picker
        $$('#list-color-picker .color-swatch').forEach((s, i) => s.classList.toggle('active', i === 0));
        openModal('modal-list');
        setTimeout(() => $('#list-name').focus(), 100);
    });

    // Color picker
    $('#list-color-picker').addEventListener('click', (e) => {
        const swatch = e.target.closest('.color-swatch');
        if (!swatch) return;
        $$('#list-color-picker .color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
    });

    // Save list (always uses default version)
    $('#btn-save-list').addEventListener('click', () => {
        const name = $('#list-name').value.trim();
        if (!name) { $('#list-name').focus(); return; }
        const color = $('#list-color-picker .color-swatch.active')?.dataset.color || '#6366f1';
        const l = Store.addList(Store.defaultVersionId, name, color);
        Store.setActive(Store.defaultVersionId, l.id);
        closeModal('modal-list');
        render();
    });

    // Add bug button
    $('#btn-add-bug').addEventListener('click', () => openBugModal());

    // Resolve task confirm
    $('#btn-confirm-resolve').addEventListener('click', () => {
        const who = $('#resolve-who').value.trim();
        if (!who) { $('#resolve-who').focus(); return; }
        const version = $('#resolve-version').value.trim();
        const vId = resolvingVersionId || Store.data.activeVersionId;
        const lId = resolvingListId || Store.data.activeListId;
        Store.updateBug(vId, lId, resolvingBugId, {
            resolvedBy: who,
            resolvedVersion: version,
            resolvedAt: Date.now(),
            resolvedByUser: Auth.user?.name || 'Desconocido',
            status: 'passed'
        });
        closeModal('modal-resolve');
        render();
    });
    // Enter key in resolve modal
    $('#resolve-who').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#resolve-version').focus(); });
    $('#resolve-version').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-confirm-resolve').click(); });

    // Edit from detail modal
    $('#btn-detail-edit').addEventListener('click', () => {
        closeModal('modal-detail');
        openBugModalWithContext(currentDetailBugId, currentDetailVersionId, currentDetailListId);
    });

    // Save bug
    $('#btn-save-bug').addEventListener('click', () => {
        const title = $('#bug-title').value.trim();
        if (!title) { $('#bug-title').focus(); return; }
        const bugData = {
            title,
            description: $('#bug-description').value.trim(),
            priority: $('#bug-priority').value,
            status: $('#bug-status').value,
            assignee: $('#bug-assignee').value.trim(),
            client: $('#bug-client').value.trim(),
            swVersion: $('#bug-sw-version').value.trim()
        };
        if (Auth.user?.role === 'admin') {
            const cb = $('#bug-created-by').value.trim();
            if (cb) bugData.createdBy = cb;
        }
        if (editingBugId) {
            Store.updateBug(editingVersionId || Store.data.activeVersionId, editingListId || Store.data.activeListId, editingBugId, bugData);
        } else {
            Store.addBug(editingVersionId || Store.data.activeVersionId, editingListId || Store.data.activeListId, bugData);
        }
        closeModal('modal-bug');
        render();
    });

    // Add comment
    $('#btn-add-comment').addEventListener('click', () => {
        const text = $('#comment-text').value.trim();
        if (!text || !currentDetailBugId) return;
        const vId = currentDetailVersionId || Store.data.activeVersionId;
        const lId = currentDetailListId || Store.data.activeListId;
        Store.addComment(vId, lId, currentDetailBugId, text);
        const bug = Store.getBug(vId, lId, currentDetailBugId);
        if (bug) renderComments(bug);
        $('#comment-text').value = '';
        render();
    });

    // Confirm action
    $('#btn-confirm-action').addEventListener('click', () => {
        if (pendingConfirmAction) { pendingConfirmAction(); pendingConfirmAction = null; }
        closeModal('modal-confirm');
    });

    // Filter buttons
    $$('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderBugList();
        });
    });

    // Sort dropdown
    $('#sort-select').addEventListener('change', () => render());

    // Keyboard: Enter in modals
    $('#list-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-save-list').click(); });
    $('#bug-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-save-bug').click(); });
    $('#comment-text').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btn-add-comment').click(); }
    });

    // Escape to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.show').forEach(m => closeModal(m.id));
        }
    });

    // Unified search input
    $('#global-search-input').addEventListener('input', (e) => {
        const val = e.target.value.trim();
        const clearBtn = $('#global-search-clear');
        clearBtn.style.display = val ? 'flex' : 'none';

        if (Store.data.activeListId) {
            currentSearchQuery = val;
            renderBugList();
        } else {
            globalSearchQuery = val;
            if (globalSearchQuery) {
                globalFilter = null;
                Store.setActive(null, null);
            }
            render();
        }
    });

    // Unified search clear
    $('#global-search-clear').addEventListener('click', () => {
        $('#global-search-input').value = '';
        $('#global-search-clear').style.display = 'none';
        
        if (Store.data.activeListId) {
            currentSearchQuery = '';
            renderBugList();
        } else {
            globalSearchQuery = '';
            render();
        }
    });

    // Escape also clears search
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.querySelector('.modal-overlay.show')) {
            const searchInput = $('#global-search-input');
            if (searchInput.value) {
                searchInput.value = '';
                $('#global-search-clear').style.display = 'none';
                if (Store.data.activeListId) {
                    currentSearchQuery = '';
                    renderBugList();
                } else {
                    globalSearchQuery = '';
                    render();
                }
            }
        }
    });

    // Stats click listeners
    $('#stat-total').addEventListener('click', () => {
        globalFilter = { type: 'allTasks' };
        Store.setActive(null, null);
        render();
    });
    $('#stat-open').addEventListener('click', () => {
        globalFilter = { type: 'status', value: 'new' };
        Store.setActive(null, null);
        render();
    });
    $('#stat-progress').addEventListener('click', () => {
        globalFilter = { type: 'status', value: 'in-progress' };
        Store.setActive(null, null);
        render();
    });
    $('#stat-resolved').addEventListener('click', () => {
        globalFilter = { type: 'resolvedTasks' };
        Store.setActive(null, null);
        render();
    });
}

// ===== AUTH UI =====
function updateAuthUI() {
    const authScreen = $('#auth-screen');
    if (Auth.isLoggedIn) {
        authScreen.classList.add('hidden');
        $('#user-avatar').textContent = Auth.user.name.charAt(0).toUpperCase();
        $('#user-name').textContent = Auth.user.name;
        // Admin UI
        $('#user-role-badge').style.display = Auth.isAdmin ? 'inline' : 'none';
        $('#btn-admin-panel').style.display = Auth.isAdmin ? 'flex' : 'none';
    } else {
        authScreen.classList.remove('hidden');
        // Decide which form to show
        if (!Auth.hasSuperUser) {
            // First time: show superuser setup
            $('#login-form').style.display = 'none';
            $('#register-form').style.display = 'none';
            $('#superuser-form').style.display = 'block';
        } else {
            $('#login-form').style.display = 'block';
            $('#register-form').style.display = 'none';
            $('#superuser-form').style.display = 'none';
        }
    }
}

// ===== FOLLOWERS SECTION =====
function renderFollowersSection(bug) {
    const commentsList = document.getElementById('comments-list');
    if (!commentsList) return;
    
    // Remove old followers section if exists
    const oldSec = document.querySelector('.followers-section');
    if (oldSec) oldSec.remove();

    const followers = bug.followers || [];
    const currentUser = Auth.user?.username || '';

    // Ensure datalist with all users exists (for follower autocompletion)
    let dl = document.getElementById("follower-users");
    if (!dl) {
        dl = document.createElement("datalist");
        dl.id = "follower-users";
        document.body.appendChild(dl);
    }
    const otherUsers = (Auth._users || []).filter(u => u.username !== currentUser);
    dl.innerHTML = otherUsers.map(u => '<option value="' + u.username + '">' + escapeHtml(u.name) + '</option>').join('');
    const isFollowing = followers.includes(currentUser);
    
    const section = document.createElement('div');
    section.className = 'followers-section';
    section.innerHTML = `
        <div class="followers-header">
            <span>👥 Seguidores (${followers.length})</span>
        </div>
        <div class="followers-list">
            ${followers.map(f => `<span class="follower-tag">${escapeHtml(f)} <button class="follower-remove" onclick="removeFollower('${escapeHtml(f)}')">×</button></span>`).join('')}
            ${followers.length === 0 ? '<span class="no-followers">Nadie sigue esta tarea aún</span>' : ''}
        </div>
        <div class="followers-actions">
            <button class="btn-sm ${isFollowing ? 'btn-unfollow' : 'btn-follow'}" id="btn-toggle-follow">
                ${isFollowing ? '🔕 Dejar de seguir' : '🔔 Seguir'}
            </button>
            <div class="add-follower-row">
                <select id="add-follower-select">
                    <option value="">-- Seleccionar usuario --</option>
                    ${otherUsers.map(u => '<option value="' + u.username + '">' + escapeHtml(u.name) + ' (' + u.username + ')</option>').join('')}
                </select>
                <button class="btn-sm btn-add-follower" id="btn-add-follower">+ Añadir</button>
            </div>
        </div>
    `;
    
    // Insert at the end of the detail sidebar, after the comment form
    const sidebar = document.querySelector('.detail-sidebar');
    if (sidebar) {
        sidebar.appendChild(section);
    } else if (commentsList.parentNode) {
        commentsList.parentNode.insertBefore(section, commentsList.nextSibling);
    }
    
    // Toggle follow button
    const toggleBtn = section.querySelector('#btn-toggle-follow');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
            const token = localStorage.getItem('bugtracker_token');
            const res = await fetch('/api/bugs/' + currentDetailBugId + '/followers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({})
            });
            const result = await res.json();
            if (result.ok) {
                // Update bug object and re-render
                bug.followers = result.followers;
                renderFollowersSection(bug);
            }
        });
    }
    
    // Add follower button
    const addBtn = section.querySelector('#btn-add-follower');
    const addSelect = section.querySelector('#add-follower-select');
    if (addBtn && addSelect) {
        addBtn.addEventListener('click', async () => {
            const username = addSelect.value.trim();
            if (!username) return;
            const token = localStorage.getItem('bugtracker_token');
            const res = await fetch('/api/bugs/' + currentDetailBugId + '/followers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ action: 'add', username })
            });
            const result = await res.json();
            if (result.ok) {
                bug.followers = result.followers;
                renderFollowersSection(bug);
            } else {
                alert('❌ ' + (result.error || 'No se pudo añadir'));
            }
        });
    }
}

// Remove follower (global function — called from onclick)
async function removeFollower(username) {
    const token = localStorage.getItem('bugtracker_token');
    const res = await fetch('/api/bugs/' + currentDetailBugId + '/followers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'remove', username })
    });
    const result = await res.json();
    if (result.ok) {
        const vId = currentDetailVersionId || Store.data.activeVersionId;
        const lId = currentDetailListId || Store.data.activeListId;
        const bug = Store.getBug(vId, lId, currentDetailBugId);
        if (bug) {
            bug.followers = result.followers;
            renderFollowersSection(bug);
        }
    }
}


// Admin panel: render user list
function renderAdminPanel() {
    const container = document.getElementById('admin-user-list');
    if (!container) return;
    const users = Auth.getUsers();
    container.innerHTML = users.map(u => `
        <div class="admin-user-row" data-user-id="${u.id}">
            <div class="admin-user-avatar">${u.name.charAt(0).toUpperCase()}</div>
            <div class="admin-user-info">
                <div class="admin-user-name">${escapeHtml(u.name)} ${u.role === 'admin' ? '<span class="user-role-badge">ADMIN</span>' : ''}${u.role === 'manager' ? '<span class="user-role-badge manager">MANAGER</span>' : ''}</div>
                <div class="admin-user-meta">@${escapeHtml(u.username)} · ${formatShortDate(u.createdAt)}</div>
            </div>
            <div class="admin-user-actions" data-mode="view">
                <button class="btn-sm btn-save" data-action="edit-user" data-uid="${u.id}" title="Editar">✏️ Editar</button>
                ${u.role !== 'admin' ? `<button class="btn-sm ${u.role === 'manager' ? 'btn-demote' : 'btn-promote'}" data-action="toggle-role" data-uid="${u.id}" data-role="${u.role}" title="${u.role === 'manager' ? 'Quitar Manager' : 'Hacer Manager'}">${u.role === 'manager' ? '👤' : '⭐'}</button><button class="btn-sm btn-del" data-action="delete-user" data-uid="${u.id}" title="Eliminar">🗑️</button>` : ''}
            </div>
        </div>
    `).join('');

    // Edit user
    container.querySelectorAll('[data-action="edit-user"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const row = btn.closest('.admin-user-row');
            const uid = btn.dataset.uid;
            const user = Auth.getUsers().find(u => u.id === uid);
            if (!user) return;
            const actionsDiv = row.querySelector('.admin-user-actions');
            actionsDiv.innerHTML = `
                <input type="text" placeholder="Nombre" value="${escapeHtml(user.name)}" data-field="name">
                <button class="btn-sm btn-save" data-action="save-user" data-uid="${uid}">💾</button>
                <button class="btn-sm btn-cancel-edit" data-action="cancel-edit">✕</button>
            `;
            actionsDiv.querySelector('[data-action="save-user"]').addEventListener('click', () => {
                const newName = actionsDiv.querySelector('[data-field="name"]').value.trim();
                const updates = {};
                if (newName && newName !== user.name) updates.name = newName;
                if (Object.keys(updates).length > 0) {
                    const result = Auth.updateUser(uid, updates);
                    if (result.error) { alert(result.error); return; }
                }
                renderAdminPanel();
                render();
            });
            actionsDiv.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => renderAdminPanel());
        });
    });

    // Toggle role (Manager promotion/demotion)
    container.querySelectorAll('[data-action="toggle-role"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const currentRole = btn.dataset.role;
            const newRole = currentRole === 'manager' ? 'user' : 'manager';
            const token = localStorage.getItem('bugtracker_token');
            try {
                const res = await fetch('/api/users/' + uid + '/role', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ role: newRole })
                });
                const result = await res.json();
                if (result.ok) {
                    renderAdminPanel();
                    render();
                } else {
                    alert('❌ Error: ' + (result.error || 'No se pudo cambiar el rol'));
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        });
    });

    // Delete user
    container.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const uid = btn.dataset.uid;
            const user = Auth.getUsers().find(u => u.id === uid);
            confirmAction(`¿Eliminar al usuario "${user?.name}"? Esta acción no se puede deshacer.`, () => {
                const result = Auth.deleteUser(uid);
                if (result.error) { alert(result.error); return; }
                renderAdminPanel();
            });
        });
    });
}

function initAuthEvents() {
    // Toggle forms
    $('#show-register').addEventListener('click', (e) => {
        e.preventDefault();
        $('#login-form').style.display = 'none';
        $('#register-form').style.display = 'block';
        $('#superuser-form').style.display = 'none';
        $('#register-error').textContent = '';
    });
    $('#show-login').addEventListener('click', (e) => {
        e.preventDefault();
        $('#register-form').style.display = 'none';
        $('#superuser-form').style.display = 'none';
        $('#login-form').style.display = 'block';
        $('#login-error').textContent = '';
    });

    // Login
    $('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('#login-username').value.trim();
        const password = $('#login-password').value;
        if (!username || !password) { $('#login-error').textContent = 'Rellena todos los campos'; return; }
        const result = await Auth.login(username, password);
        if (result.error) { $('#login-error').textContent = result.error; return; }
        $('#login-username').value = ''; $('#login-password').value = ''; $('#login-error').textContent = '';
        updateAuthUI();
        render();
    });

    // Register (normal user)
    $('#register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('#register-name').value.trim();
        const username = $('#register-username').value.trim();
        const password = $('#register-password').value;
        const password2 = $('#register-password2').value;
        if (!name || !username || !password) { $('#register-error').textContent = 'Rellena todos los campos'; return; }
        if (password !== password2) { $('#register-error').textContent = 'Las contraseñas no coinciden'; return; }
        const result = await Auth.register(name, username, password, 'user');
        if (result.error) { $('#register-error').textContent = result.error; return; }
        $('#register-name').value = ''; $('#register-username').value = ''; $('#register-password').value = ''; $('#register-password2').value = ''; $('#register-error').textContent = '';
        updateAuthUI();
        render();
    });

    // Superuser setup (first time)
    $('#superuser-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('#su-name').value.trim();
        const username = $('#su-username').value.trim();
        const password = $('#su-password').value;
        const password2 = $('#su-password2').value;
        if (!name || !username || !password) { $('#su-error').textContent = 'Rellena todos los campos'; return; }
        if (password !== password2) { $('#su-error').textContent = 'Las contraseñas no coinciden'; return; }
        const result = await Auth.register(name, username, password, 'admin');
        if (result.error) { $('#su-error').textContent = result.error; return; }
        updateAuthUI();
        render();
    });

    // Admin panel button
    $('#btn-admin-panel').addEventListener('click', () => {
        renderAdminPanel();
        openModal('modal-admin');
    });

    // Theme toggle
    $('#btn-theme').addEventListener('click', () => ThemeManager.toggle());

    // Report
    $('#btn-report').addEventListener('click', () => openReportModal());
    $('#btn-generate-report').addEventListener('click', () => generateReport());

    // Backup
    $('#btn-backup').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/backup');
            if (!res.ok) throw new Error('Server responded ' + res.status);
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const now = new Date();
            const ts = now.toISOString().slice(0, 10) + '_' + now.toTimeString().slice(0, 5).replace(':', '-');
            a.href = url;
            a.download = 'backup_bugtracker_' + ts + '.json';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        } catch (e) {
            alert('Error al crear backup: ' + e.message);
        }
    });

    // Send backup by email
    $('#btn-send-backup').addEventListener('click', async () => {
        const token = localStorage.getItem("bugtracker_token");
        if (!token) { alert('No estás autenticado.'); return; }
        try {
            const res = await fetch('/api/send-backup', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const result = await res.json();
            if (result.ok) {
                alert('✅ ' + result.message);
            } else {
                alert('❌ Error: ' + (result.error || 'No se pudo enviar el backup'));
            }
        } catch (e) {
            alert('Error al enviar backup: ' + e.message);
        }
    });

    // Restore
    $('#btn-restore').addEventListener('click', () => {
        if (!confirm('⚠️ Restaurar un backup reemplazará TODOS los datos actuales (listas, tareas, usuarios).\n\n¿Estás seguro?')) return;
        $('#restore-file-input').click();
    });
    $('#restore-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data._backup || !data.store || !data.users) {
                    alert('❌ El archivo no es un backup válido de Bug Tracker.');
                    return;
                }
                const res = await fetch('/api/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (result.ok) {
                    alert('✅ Backup restaurado correctamente.\nLa página se va a recargar.');
                    location.reload();
                } else {
                    alert('❌ Error: ' + (result.error || 'Desconocido'));
                }
            } catch (err) {
                alert('❌ Error al procesar el archivo: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = ''; // Reset input
    });

    // Profile
    $('#btn-profile-trigger').addEventListener('click', () => {
        $('#profile-name').value = Auth.user.name;
        $('#profile-email').value = Auth.user.email || '';
        $('#profile-password').value = '';
        $('#profile-notifications').checked = Auth.user?.notifications !== false;
        openModal('modal-profile');
    });

    $('#btn-save-profile').addEventListener('click', async () => {
        const newName = $('#profile-name').value.trim();
        const newEmail = $('#profile-email').value.trim();
        const newPass = $('#profile-password').value;
        if (!newName) { $('#profile-name').focus(); return; }

        const updates = {};
        if (newName !== Auth.user.name) updates.name = newName;
        if (newEmail !== (Auth.user.email || '')) updates.email = newEmail;
        const newNotifications = $('#profile-notifications').checked;
        if (newNotifications !== (Auth.user.notifications !== false)) updates.notifications = newNotifications;
        // Password updates are handled server-side only; ignore offline or send to server if needed in future
        if (newPass) {
            alert('El cambio de contraseña no está disponible en modo offline. Conecta al servidor para esta función.');
            return;
        }

        if (Object.keys(updates).length > 0) {
            const result = Auth.updateUser(Auth.user.id, updates);
            if (result.error) return alert(result.error);
            Auth._currentUser = Auth.getUsers().find(u => u.id === Auth.user.id);
            if ('notifications' in updates) Auth._currentUser.notifications = updates.notifications;
            Auth.saveSession();
            updateAuthUI();
            Auth.saveUsers(); // Force sync (strips passwords automatically)
        }
        closeModal('modal-profile');
    });

    // Logout
    $('#btn-logout').addEventListener('click', () => {
        Auth.logout();
        updateAuthUI();
    });
}

// ===== INIT =====
// Step 1: Load from localStorage immediately (fast, offline-first)
Auth.load();
Store.load();
Store.ensureDefaultVersion();

// Step 2: Init events
initAuthEvents();
initEvents();

// Step 3: Show loading state, then sync with server before showing auth UI
(async function serverSync() {
    // Show loading briefly while we check the server
    const authScreen = document.getElementById('auth-screen');
    if (!Auth.isLoggedIn) {
        authScreen.classList.remove('hidden');
        // Hide all forms during loading
        $('#login-form').style.display = 'none';
        $('#register-form').style.display = 'none';
        $('#superuser-form').style.display = 'none';
    }

    await Sync.init();
    if (Sync.isOnline) {
        await Auth.loadFromServer();
        await Store.loadFromServer();
        Store.ensureDefaultVersion();
        console.log('[Sync] Datos sincronizados con el servidor');

        // Periodic sync: pull from server every 30s
        setInterval(async () => {
            try {
                await Auth.loadFromServer();
                await Store.loadFromServer();
                Store.ensureDefaultVersion();
                render();
            } catch {}
        }, 30000);
    }

    // NOW show the correct auth UI with server data loaded
    updateAuthUI();
    render();
})();

// Migration: rename 'UI Tests' to 'Softlens Test'
(function migrateListNames() {
    let changed = false;
    Store.data.versions.forEach(v => {
        (v.lists || []).forEach(l => {
            if (l.name === 'UI Tests' || l.name === 'UI Test') {
                l.name = 'Softlens Test';
                changed = true;
            }
        });
    });
    if (changed) Store.save();
})();
