# 🐛 Bug Tracker — Documentación Completa del Proyecto

> **Versión:** 1.7 · **Fecha:** Mayo 2026  
> **Stack:** HTML + CSS + Vanilla JS + Node.js (sin dependencias externas)  
> **Despliegue:** Ubuntu Server + PM2 + Tailscale Funnel

---

## 📑 Índice

1. [Visión General](#1-visión-general)
2. [Arquitectura y Archivos](#2-arquitectura-y-archivos)
3. [Modelo de Datos](#3-modelo-de-datos)
4. [Sistema de Autenticación](#4-sistema-de-autenticación)
5. [API del Servidor](#5-api-del-servidor)
6. [Inyección de Datos (SSR Lite)](#6-inyección-de-datos-ssr-lite)
7. [Sistema de Temas (3 colores)](#7-sistema-de-temas)
8. [Diseño Responsive y Mobile](#8-diseño-responsive-y-mobile)
9. [Sistema de Backup/Restore](#9-sistema-de-backuprestore)
10. [Despliegue en Servidor Remoto](#10-despliegue-en-servidor-remoto)
11. [Acceso Remoto (Tailscale + Funnel)](#11-acceso-remoto)
12. [Lecciones Aprendidas](#12-lecciones-aprendidas)
13. [Guía para Recrear con Agentes IA](#13-guía-para-recrear-con-agentes-ia)

---

## 1. Visión General

### ¿Qué es?
Una aplicación web para gestión de bugs/tareas de testeo de software. Permite crear listas de pruebas, registrar bugs con prioridades, asignar testers, marcar resoluciones y generar reportes.

### Características principales
- **Multi-usuario** con roles (admin/user)
- **Listas de tareas** organizadas por color
- **Buscador Inteligente**: Búsqueda global (todas las listas) o local (lista actual) con la misma barra unificada
- **Filtrado rápido e interactivo** pulsando en los contadores (Total, Abiertos, En curso, Resueltos)
- **Filtrado avanzado** por estado, prioridad, cliente, tester, versión SW
- **3 temas de color**: Oscuro, Crepúsculo, Claro
- **Backup/Restore** completo en JSON
- **Responsive** — funciona en PC, tablet y móvil con layout optimizado en un sola línea para cabeceras
- **Gestión avanzada (Admin)** — Los superusuarios pueden modificar libremente la autoría ("Creador") de cualquier tarea
- **Sin dependencias npm** — solo Node.js built-in modules
- **Acceso remoto** vía Tailscale Funnel (HTTPS público)

---

## 2. Arquitectura y Archivos

### Estructura del proyecto

```
bug-tracker/
├── BugTracker.html     # 32KB - HTML completo (SPA)
├── styles.css          # 31KB - Estilos con 3 temas + responsive
├── app.js              # 72KB - Toda la lógica del cliente
├── server.js           # 8KB  - Servidor Node.js (API + static)
└── data/
    ├── users.json      # Usuarios registrados
    └── store.json      # Datos de la aplicación (versiones, listas, bugs)
```

### Principios de diseño
- **Sin frameworks** — HTML/CSS/JS puro
- **Sin npm install** — el servidor usa solo módulos built-in de Node.js
- **SPA con hash routing** — toda la UI en un solo HTML
- **Persistencia dual** — localStorage (offline) + API REST (servidor)
- **Zero-config** — `node server.js` y funciona

---

## 3. Modelo de Datos

### `users.json`
```json
[
  {
    "id": "uuid",
    "name": "Admin",
    "username": "admin",
    "password": "base64_encoded_password",
    "role": "admin",        // "admin" | "user"
    "createdAt": 1778838227939
  }
]
```

> [!IMPORTANT]
> Las contraseñas se almacenan en Base64 (no es seguro para producción real, pero suficiente para uso interno).

### `store.json`
```json
{
  "versions": [
    {
      "id": "uuid",
      "name": "__default__",
      "description": "",
      "lists": [
        {
          "id": "uuid",
          "name": "Lista de Pruebas",
          "color": "#6366f1",
          "bugs": [
            {
              "id": "uuid",
              "title": "Bug encontrado",
              "description": "Detalle del bug",
              "status": "new",          // new | in-progress | passed | failed
              "priority": "high",       // critical | high | medium | low
              "client": "Cliente X",
              "swVersion": "v2.1",
              "createdBy": "tester1",
              "assignees": ["dev1"],
              "comments": [
                {
                  "id": "uuid",
                  "text": "Comentario",
                  "author": "admin",
                  "createdAt": 1778838227939
                }
              ],
              "resolvedBy": null,
              "resolvedVersion": null,
              "resolvedAt": null,
              "resolvedByUser": null,
              "createdAt": 1778838227939
            }
          ],
          "createdAt": 1778838227939
        }
      ],
      "createdAt": 1778838227939
    }
  ],
  "activeVersionId": "uuid",
  "activeListId": "uuid"
}
```

### Jerarquía
```
Store
└── Versions (ocultas, solo se usa __default__)
    └── Lists (las "carpetas" de bugs)
        └── Bugs (las tareas/incidencias)
            └── Comments (historial de comentarios)
```

---

## 4. Sistema de Autenticación

### Flujo de autenticación
1. El servidor inyecta los datos de usuarios en el HTML al servirlo
2. `Auth.load()` lee `window.__SERVER_DATA__.users` (prioridad) o `localStorage`
3. Si no hay usuarios → muestra formulario de "Super Usuario" (primera vez)
4. Login compara username + password (Base64) en memoria
5. La sesión se guarda en `localStorage.bugtracker_session`

### Roles
| Rol | Permisos |
|---|---|
| **admin** | Todo: crear/editar/borrar listas y bugs, gestionar usuarios, backup/restore, cambiar el nombre del creador original de una tarea |
| **user** | Crear/editar bugs, añadir comentarios, marcar como resuelto (autoría asignada automáticamente, no modificable) |

### Pantallas de auth (en BugTracker.html)
- **Login** → `#login-form` (visible por defecto)
- **Registro** → `#register-form` (oculto, toggle con enlace)
- **Super Usuario** → `#superuser-form` (solo si no hay usuarios)

> [!WARNING]
> Los enlaces de toggle entre login/registro deben estar **dentro** de sus respectivos formularios pero con `onclick` inline que muestra/oculta ambos formularios. No usar `href="#"` (causa submit accidental).

### Código clave (app.js)
```javascript
const Auth = {
    _users: [],
    _current: null,
    
    load() {
        // Prioridad: datos inyectados del servidor > localStorage
        if (window.__SERVER_DATA__?.users) {
            this._users = window.__SERVER_DATA__.users;
        } else {
            this._users = JSON.parse(localStorage.getItem('bugtracker_users') || '[]');
        }
    },
    
    login(username, password) {
        const encoded = btoa(password);
        return this._users.find(u => u.username === username && u.password === encoded);
    }
};
```

---

## 5. API del Servidor

### Endpoints REST

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/users` | Obtener todos los usuarios |
| `POST` | `/api/users` | Guardar array de usuarios |
| `GET` | `/api/store` | Obtener datos de la app |
| `POST` | `/api/store` | Guardar datos de la app |
| `GET` | `/api/backup` | Descargar backup completo |
| `POST` | `/api/restore` | Restaurar desde backup |

### Archivos estáticos
- `GET /` → sirve `BugTracker.html`
- Cualquier otro path → busca el archivo en el directorio del proyecto

### Seguridad
- Validación de path para prevenir directory traversal
- CORS habilitado para desarrollo (`Access-Control-Allow-Origin: *`)
- Headers `Cache-Control: no-cache` para evitar versiones cacheadas

---

## 6. Inyección de Datos (SSR Lite)

### El Problema
Cuando un cliente accede por VPN/Tailscale, las llamadas `fetch('/api/users')` fallaban por timeout debido a la latencia. El usuario no podía hacer login.

### La Solución
El servidor inyecta los datos directamente en el HTML antes de enviarlo:

```javascript
// server.js — al servir .html
if (filePath.endsWith('.html')) {
    const users = readJSON(USERS_FILE);
    const store = readJSON(STORE_FILE);
    const inject = `<script>window.__SERVER_DATA__=${JSON.stringify({ users, store })};</script>`;
    content = content.toString().replace('</head>', inject + '\n</head>');
}
```

El cliente los lee de forma **síncrona** al cargar:
```javascript
// app.js — Auth.load() y Store.load()
if (window.__SERVER_DATA__?.users) {
    this._users = window.__SERVER_DATA__.users;
}
```

> [!TIP]
> Esta técnica elimina la dependencia de `fetch` asíncrono al inicio. Es crítica para conexiones con latencia alta (VPN, Tailscale, redes móviles).

---

## 7. Sistema de Temas

### 3 temas definidos con CSS Variables

```css
/* Oscuro (por defecto) */
:root, [data-theme="dark"] {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-card: #1a1a2e;
    --text-primary: #e8e8f0;
    --accent: #6366f1;
    /* ... */
}

/* Crepúsculo (intermedio) */
[data-theme="twilight"] {
    --bg-primary: #1b2240;
    --bg-secondary: #222a4e;
    --text-primary: #e8eaf4;
    --accent: #818af8;
    /* ... */
}

/* Claro */
[data-theme="light"] {
    --bg-primary: #e8ecf4;
    --bg-secondary: #ffffff;
    --text-primary: #111128;
    --accent: #4f52d9;
    /* ... */
}
```

### Variables clave por tema

| Variable | Uso |
|---|---|
| `--bg-primary` | Fondo general de la app |
| `--bg-secondary` | Fondo de sidebar, modales |
| `--bg-card` | Fondo de tarjetas |
| `--bg-input` | Fondo de inputs |
| `--text-primary` | Texto principal |
| `--text-secondary` | Texto secundario |
| `--text-muted` | Texto apagado |
| `--accent` | Color principal (botones, enlaces) |
| `--border` | Bordes |
| `--orb-opacity` | Opacidad del fondo ambient |
| `--scrollbar-thumb` | Color del scrollbar |

### Lógica de cambio (app.js)

```javascript
const ThemeManager = {
    themes: ['dark', 'twilight', 'light'],
    icons: { dark: '🌙', twilight: '🌗', light: '☀️' },
    
    apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('bugtracker_theme', theme);
    },
    toggle() {
        const idx = this.themes.indexOf(this.current());
        const next = this.themes[(idx + 1) % this.themes.length];
        this.apply(next);
    }
};
```

> [!CAUTION]
> **No hardcodear colores** en el CSS. Todo debe usar `var(--nombre)`. Los colores rgba hardcodeados como `rgba(18,18,26,0.6)` no cambian con el tema y causan inconsistencias visuales.

---

## 8. Diseño Responsive y Mobile

### Breakpoints

| Breakpoint | Dispositivo | Cambios principales |
|---|---|---|
| `> 900px` | Desktop | Sidebar fija, todos los stats visibles |
| `≤ 900px` | Tablet | Sidebar 220px, stats reducidos |
| `≤ 640px` | Mobile | Sidebar como overlay, búsqueda en línea completa |

### Problemas resueltos en móvil

#### 1. Sidebar como overlay
```css
@media (max-width: 640px) {
    .sidebar {
        position: fixed; top: 0; left: 0; bottom: 0;
        width: 280px; max-width: 85vw;
        z-index: 300;
        transform: translateX(-100%);
        padding-top: 120px;  /* ← Librar la barra del header */
    }
    .sidebar.open { transform: translateX(0); }
}
```

#### 2. Backdrop que NO intercepta toques del sidebar
```css
.sidebar-backdrop {
    /* left: 280px — NO cubre la zona del sidebar */
    position: fixed; top: 0; right: 0; bottom: 0; left: 280px;
    z-index: 299;  /* menor que sidebar (300) */
}
```

#### 3. Bloqueo de scroll del fondo
```javascript
function toggleSidebar() {
    sidebar.classList.toggle('open');
    document.body.classList.toggle('sidebar-open', sidebar.classList.contains('open'));
}
// CSS: body.sidebar-open { overflow: hidden; }
```

#### 4. Botones siempre visibles (no hover)
```css
@media (max-width: 640px) {
    .bug-card-actions { opacity: 1 !important; }
    .sidebar-item .item-actions { opacity: 1 !important; }
    .btn-icon { min-width: 36px; min-height: 36px; }
}
```

#### 5. closeSidebar con delay
```javascript
function closeSidebar() {
    setTimeout(() => {  // ← 150ms para que el click se procese primero
        $('#sidebar').classList.remove('open');
        document.body.classList.remove('sidebar-open');
    }, 150);
}
```

> [!WARNING]
> **En móvil NO hay `:hover`**. Cualquier UI que dependa de hover (mostrar botones, tooltips) necesita alternativa táctil. Usar `opacity: 1 !important` en media query mobile.

> [!WARNING]
> **El backdrop NO debe cubrir el sidebar.** Si usas `inset: 0` (toda la pantalla), el backdrop captura los toques antes que el sidebar. Usar `left: 280px` para empezar después del sidebar.

---

## 9. Sistema de Backup/Restore

### Backup (descarga)
```javascript
// Cliente (app.js)
const res = await fetch('/api/backup');
const blob = await res.blob();
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = `backup_${new Date().toISOString().slice(0,10)}.json`;
document.body.appendChild(a);  // ← NECESARIO en algunos navegadores
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(a.href);
```

> [!TIP]
> El `document.body.appendChild(a)` es **obligatorio** en navegadores que no permiten click en elementos no añadidos al DOM.

### Restore (subida)
```javascript
const input = document.createElement('input');
input.type = 'file';
input.accept = '.json';
input.onchange = async (e) => {
    const text = await e.target.files[0].text();
    const data = JSON.parse(text);
    await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text
    });
    location.reload();
};
input.click();
```

---

## 10. Despliegue en Servidor Remoto

### Requisitos
- Ubuntu Server con Node.js (v18+)
- Acceso SSH (vía Tailscale si no hay acceso directo)
- PM2 para gestión de procesos

### Pasos de despliegue

```bash
# 1. Copiar archivos al servidor
scp -r ./bug-tracker wilson@100.124.137.123:~/

# 2. En el servidor: instalar PM2
npm install -g pm2

# 3. Iniciar con PM2
cd ~/bug-tracker
pm2 start server.js --name bug-tracker
pm2 save
pm2 startup  # Para auto-inicio con el sistema
```

### Comandos de mantenimiento

| Comando | Uso |
|---|---|
| `pm2 restart bug-tracker` | Reiniciar tras cambios |
| `pm2 logs bug-tracker` | Ver logs |
| `pm2 status` | Estado del proceso |
| `scp archivo wilson@IP:~/bug-tracker/` | Subir archivo actualizado |

### Nginx como reverse proxy (opcional)

```nginx
# /etc/nginx/sites-available/bugtracker
server {
    listen 8082;
    server_name bugs.home;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> [!NOTE]
> Si Pi-hole ocupa el puerto 80, usar otro puerto (8082) para nginx.

---

## 11. Acceso Remoto

### Opciones de acceso

| Método | URL | Requisito en el cliente |
|---|---|---|
| **Red local** | `http://192.168.1.115:3000` | Misma red |
| **Pi-hole DNS** | `http://bugs.home:8082` | Pi-hole como DNS |
| **Tailscale** | `http://ertceps:8082` | App Tailscale instalada |
| **Tailscale Funnel** | `https://ertceps.tail51f3b0.ts.net` | **Nada** (público) |

### Configurar Tailscale Funnel

```bash
# 1. Activar permisos (una vez)
sudo tailscale set --operator=$USER

# 2. Habilitar Funnel (visitando el enlace que da)
tailscale funnel 3000

# 3. Ejecutar en background (permanente)
tailscale funnel --bg 3000
```

> [!IMPORTANT]
> Tailscale Funnel proporciona HTTPS automático. No requiere certificados ni configuración DNS.

---

## 12. Lecciones Aprendidas

### 🔴 Errores Críticos y Sus Soluciones

#### 1. Login fallaba por red lenta (VPN/Tailscale)
- **Causa:** `fetch('/api/users')` hacía timeout antes de cargar los usuarios
- **Solución:** Inyectar datos en el HTML desde el servidor (`window.__SERVER_DATA__`)
- **Lección:** Para apps con acceso remoto, nunca depender de fetch asíncrono para el dato inicial

#### 2. Botones no funcionaban en móvil
- **Causa:** Los botones se mostraban con `:hover` que no existe en touch screens
- **Solución:** `opacity: 1 !important` en media query `≤640px`
- **Lección:** Nunca usar `:hover` como único mecanismo de mostrar/ocultar

#### 3. Sidebar no respondía a toques en móvil
- **Causa:** El backdrop (`inset: 0`) cubría toda la pantalla, interceptando toques
- **Solución:** Backdrop empieza en `left: 280px`, no cubre el área del sidebar
- **Lección:** Los overlays transparentes interceptan eventos aunque no se vean

#### 4. Sidebar tapada por el header en móvil
- **Causa:** `top: 0` hacía que el contenido empezara detrás del header sticky
- **Solución:** `padding-top: 120px` en la sidebar móvil
- **Lección:** Los elementos fixed no respetan el espacio de elementos sticky

#### 5. Scroll del fondo al hacer scroll en sidebar
- **Causa:** El body seguía scrolleable cuando el sidebar estaba abierto
- **Solución:** `body.sidebar-open { overflow: hidden; }`
- **Lección:** Siempre bloquear scroll del fondo en overlays móviles

#### 6. Temas no se aplicaban a todos los elementos
- **Causa:** Colores hardcodeados como `rgba(18,18,26,0.6)` no usan variables CSS
- **Solución:** Reemplazar todos los colores hardcodeados por `var(--nombre)`
- **Lección:** Establecer variables CSS desde el inicio y NO usar colores directos

#### 7. Caché del móvil servía versiones antiguas
- **Causa:** Sin headers de cache-control, el navegador cacheaba los archivos
- **Solución:** `Cache-Control: no-cache, no-store, must-revalidate` en las respuestas
- **Lección:** En desarrollo, siempre desactivar caché del servidor

#### 8. Modal de confirmación aparecía detrás del panel admin
- **Causa:** Ambos modales tenían el mismo `z-index: 1000`
- **Solución:** `#modal-confirm { z-index: 1500; }`
- **Lección:** Los modales de confirmación siempre deben tener z-index mayor

#### 9. Enlaces de registro hacían submit del formulario
- **Causa:** `<a href="#">` dentro de `<form>` era interceptado por el navegador
- **Solución:** `href="javascript:void(0)"` con `onclick` inline
- **Lección:** Nunca poner enlaces interactivos dentro de `<form>` sin prevenir submit

#### 10. Cabecera móvil se apilaba (logo encima de botones)
- **Causa:** El ancho sumado de logo + botones superaba el viewport (ej. 320px), haciendo que `flex-wrap` saltara de línea.
- **Solución:** Micro-spacing (`gap: 0.3rem`, padding reducido, fuente menor) y `flex-wrap: nowrap` en los bloques internos.
- **Lección:** En headers móviles con `justify-content: space-between`, vigila milimétricamente la suma de anchos.

#### 11. Interfaz sobrecargada de buscadores
- **Causa:** Un buscador general en la cabecera y otro local dentro de las listas ocupaban espacio redundante.
- **Solución:** Unificar en una barra de búsqueda "inteligente" en el header que cambia de placeholder y modo (global/local) dependiendo del contexto.
- **Lección:** Minimizar controles duplicados en pantalla; reutilizar inputs modificando su contexto y placeholder en JS.

---

## 13. Guía para Recrear con Agentes IA

### Prompt Maestro (paso a paso)

Si quieres recrear este proyecto desde cero con un agente IA, usa estos prompts en orden:

---

### Fase 1: Fundación

**Prompt 1 — Servidor:**
> "Crea un servidor Node.js SIN dependencias externas (solo módulos built-in: http, fs, path, os) en un archivo `server.js` que:
> - Escuche en puerto 3000 en todas las interfaces
> - Sirva archivos estáticos con MIME types correctos
> - Tenga API REST: GET/POST `/api/users` y `/api/store` que lean/escriban JSON en `./data/`
> - GET `/api/backup` que descargue un JSON combinando users + store
> - POST `/api/restore` que restaure un backup
> - Al servir HTML, inyecte los datos de users y store como `window.__SERVER_DATA__` en un `<script>` antes de `</head>`
> - Envíe headers `Cache-Control: no-cache` en todas las respuestas
> - Cree el directorio `data/` y los archivos JSON si no existen"

**Prompt 2 — HTML estructura:**
> "Crea `BugTracker.html` como SPA con estas secciones:
> - Pantalla de auth con formularios de login, registro y super-usuario (primera vez)
> - Header con: logo, barra de búsqueda global, stats (total/abiertos/progreso/resueltos), menú de usuario con botones de admin/tema/reporte/logout
> - Sidebar con: sección de listas, y secciones de filtros (versión SW, clientes, testers, asignados, tareas resueltas)
> - Área de contenido para las tarjetas de bugs
> - Modales: crear/editar lista, crear/editar bug, detalle de bug, resolver bug, confirmar acción, admin panel, reportes
> - Los enlaces de toggle entre login/registro deben usar `onclick` inline y `href='javascript:void(0)'`, NUNCA dentro de un `<form>`"

---

### Fase 2: Estilos

**Prompt 3 — CSS con temas:**
> "Crea `styles.css` con un sistema de diseño basado en variables CSS. Define 3 temas (dark, twilight, light) usando `[data-theme='nombre']`. Variables necesarias: bg-primary, bg-secondary, bg-card, bg-card-hover, bg-input, border, border-hover, text-primary, text-secondary, text-muted, accent, accent-hover, accent-glow, danger, success, warning, shadow, orb-opacity, scrollbar-thumb.
> 
> REGLA ABSOLUTA: NO usar colores hardcodeados. TODO debe ser `var(--nombre)`.
> 
> Incluir responsive para mobile (≤640px): sidebar como overlay fixed con padding-top de 120px, backdrop que NO cubra el área del sidebar (usar left: 280px), botones siempre visibles (no depender de hover), áreas de toque mínimo 36px, body.sidebar-open { overflow: hidden }"

---

### Fase 3: Lógica

**Prompt 4 — App.js:**
> "Crea `app.js` con:
> - `Auth` object: load (desde __SERVER_DATA__ primero, luego localStorage), login, register, logout, isAdmin
> - `Store` object: load, save, CRUD de versiones/listas/bugs/comentarios, sync con servidor via fetch
> - `ThemeManager`: 3 temas, toggle cíclico, guardar en localStorage
> - `Sync` object: sincronización periódica con el servidor (retry con backoff)
> - Renderizado: renderLists, renderBugs, renderSidebarFilters, renderAdminPanel
> - Mobile sidebar: toggleSidebar/closeSidebar con delay de 150ms y body scroll lock
> - Todos los botones de acción visibles por CSS (no depender de hover en móvil)"

---

### Fase 4: Despliegue

**Prompt 5 — Despliegue:**
> "Ayúdame a desplegar la app en mi servidor Ubuntu accesible por SSH vía Tailscale:
> 1. Copiar archivos con scp
> 2. Instalar PM2 globalmente
> 3. Iniciar con PM2
> 4. Configurar Tailscale Funnel para acceso público HTTPS
> 5. (Opcional) Nginx como reverse proxy
> 6. (Opcional) Pi-hole DNS local"

---

### Reglas para el Agente

> [!CAUTION]
> **Reglas que el agente DEBE seguir:**
> 1. **NUNCA hardcodear colores** — usar variables CSS
> 2. **NUNCA depender de `:hover`** para funcionalidad — en móvil no existe
> 3. **NUNCA hacer `inset: 0`** en backdrops de sidebar — dejar libre la zona del sidebar
> 4. **SIEMPRE inyectar datos en HTML** para acceso remoto — no depender de fetch inicial
> 5. **SIEMPRE enviar `Cache-Control: no-cache`** durante desarrollo
> 6. **SIEMPRE probar en viewport móvil** (390x844) antes de dar por terminado
> 7. **SIEMPRE usar `setTimeout` de 150ms** al cerrar sidebar en móvil
> 8. **SIEMPRE hacer `pm2 restart`** después de subir archivos al servidor
> 9. **Los modales de confirmación** necesitan z-index mayor que otros modales
> 10. **Los enlaces dentro de formularios** deben usar `javascript:void(0)` + `onclick`
> 11. **Al hacer headers móviles**, sumar anchos máximos y usar micro-spacing para evitar el efecto "stacking" involuntario.
> 12. **Caché persistente**: Usa versionado estático (`app.js?v=2.x`) en el HTML para forzar el invalidado de caché en navegadores móviles.

---

## Apéndice: Credenciales

| Entorno | Usuario | Contraseña |
|---|---|---|
| Local (PC) | admin | BugAdmin13 |
| Servidor remoto | admin | BugAdmin13 |

### Acceso SSH al servidor
```
ssh wilson@100.124.137.123   # vía Tailscale
```

### Rutas del servidor
```
App:    /home/wilson/bug-tracker/
Datos:  /home/wilson/bug-tracker/data/
PM2:    ~/.npm-global/bin/pm2
```

### URLs de acceso
```
Local:          http://localhost:3000
Red local:      http://192.168.1.115:3000
Tailscale:      http://ertceps:8082
Funnel (HTTPS): https://ertceps.tail51f3b0.ts.net
```
