# 🤖 Bug Tracker — Guía para Agentes IA

> **Propósito:** Reconstruir este proyecto desde cero sin repetir los errores cometidos.
> **Versión:** 1.0 — Mayo 2026
> **Commit actual:** `505b2d7` (v5.0 — Manager + Followers + Comment Editing)

---

## ⚠️ REGLAS DE ORO (LEER PRIMERO)

Estas reglas se aprendieron rompiendo cosas. **No las ignores.**

### 🔴 REGLA #1: NUNCA uses sed/heredocs/echo para editar archivos remotos

**Síntoma del desastre:** `app.js` pasó de 1856 líneas a 0 líneas. El heredoc truncó el archivo.

**Haz esto SIEMPRE:**
```bash
# Opción A: Script Python transferido vía cat
cat /tmp/mi_script.py | ssh wilson@100.124.137.123 'cat > /tmp/mi_script.py && python3 /tmp/mi_script.py'

# Opción B: Si GitHub está configurado, usa git pull/push
# Opción C: Para cambios pequeños (< 5 líneas), usa el patch tool de Hermes
```

### 🔴 REGLA #2: Verifica integridad DESPUÉS de cada cambio

```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && node -c app.js && node -c server.js && echo "SINTAXIS OK" && wc -l app.js server.js'
```

Después de editar `app.js`, SIEMPRE verifica que las funciones críticas siguen existiendo:
```bash
grep -c 'function openBugModal\|function openReportModal\|function generateReport\|function confirmAction' app.js
# Debe devolver: 4
```

### 🔴 REGLA #3: Antes de borrar código, haz backup

```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && git stash && git checkout -- app.js'  # Restauración rápida
```

### 🟡 REGLA #4: Las variables de entorno van en PM2, NO en el código

```bash
pm2 restart bug-tracker --update-env  # Carga SMTP_USER, SMTP_PASS, etc.
```

Para ver las variables actuales:
```bash
pm2 env 0 | grep SMTP_
```

### 🟡 REGLA #5: Los selectores DOM deben existir en el HTML

Si creas una función JS que busca `.mi-clase`, asegúrate de que EXISTE en `BugTracker.html`. Si no existe, usa IDs (`#comentarios`) que son más seguros.

### 🟡 REGLA #6: Comparaciones de username SIEMPRE case-insensitive

```javascript
// ❌ MAL
users.find(u => u.username === targetUser)

// ✅ BIEN
users.find(u => u.username.toLowerCase() === targetUser.toLowerCase())
```

---

## 🖥️ DATOS DEL SERVIDOR

| Dato | Valor |
|------|-------|
| **Host** | `wilson@100.124.137.123` |
| **Acceso** | Tailscale SSH (NO IP pública directa) |
| **Clave SSH** | `~/.ssh/id_ed25519` |
| **Comando SSH** | `ssh -i ~/.ssh/id_ed25519 -o ConnectTimeout=10 wilson@100.124.137.123 '...'` |
| **Proyecto** | `/home/wilson/bug-tracker/` |
| **Node.js** | v22.22.2 |
| **PM2** | `/home/wilson/.npm-global/bin/pm2` |
| **URL pública** | `https://bugtracker.tail51f3b0.ts.net` (Tailscale Funnel) |
| **Puerto local** | `3000` |

### ⚠️ Tailscale puede pedir re-autenticación

Si SSH da timeout o pide visitar `https://login.tailscale.com/a/...`, avisa al humano para que re-autentique. Es normal — Tailscale rota las sesiones.

### PM2 comandos esenciales

```bash
# Siempre anteponer el PATH
PATH="$HOME/.npm-global/bin:$PATH"

# Status
pm2 status

# Reiniciar (sin recargar env)
pm2 restart bug-tracker

# Reiniciar CON variables de entorno
pm2 restart bug-tracker --update-env

# Logs
tail -50 ~/.pm2/logs/bug-tracker-out.log
tail -50 ~/.pm2/logs/bug-tracker-error.log

# Forzar recarga de variables
pm2 restart all --update-env
```

---

## 📁 ESTRUCTURA DEL PROYECTO

```
~/bug-tracker/
├── BugTracker.html    # HTML principal (SPA)
├── styles.css         # Temas oscuro/crepúsculo/claro + responsive + estilos
├── app.js             # ~2050 líneas — TODA la lógica del cliente
├── server.js          # ~870 líneas — API REST + email + notificaciones
├── data/
│   ├── store.json     # Versiones, listas, bugs, followers
│   └── users.json     # Usuarios con pbkdf2 hashes
├── DOCUMENTACION.md   # Documentación completa del proyecto
└── AGENT_GUIDE.md     # Este archivo
```

### Qué hace cada archivo

| Archivo | Rol | Líneas | NO TOCAR sin backup |
|---------|-----|--------|:---:|
| `app.js` | Frontend: Auth, Store, Sync, render(), modales, reportes, comentarios, followers | ~2050 | 🔴🔴🔴 |
| `server.js` | Backend: HTTP server, 12 endpoints, SMTP, notificaciones | ~870 | 🔴 |
| `BugTracker.html` | Estructura HTML de la SPA | ~684 | 🟡 |
| `styles.css` | 3 temas + responsive + componentes | ~700 | 🟢 |
| `data/store.json` | Datos de la app (NO editar a mano) | variable | 🔴 |
| `data/users.json` | Usuarios con hashes (NO editar a mano) | variable | 🔴 |

**Zona de máximo peligro:** `app.js` contiene ~30 funciones interdependientes. Borrar una puede romper todo. El diff de git es tu amigo: `git diff HEAD -- app.js | wc -l`.

---

## 🧠 ARQUITECTURA

### Flujo de datos
```
[Cliente] → Sync.pull() → GET /api/store → server.js → store.json
[Cliente] → Sync.push() → POST /api/store → server.js → store.json + notificaciones
[Cliente] → Auth.login() → POST /api/login → server.js → users.json → token JWT
```

### Sistema de autenticación
- **Hash:** `crypto.pbkdf2` (salt + 100k iteraciones + SHA-512)
- **Token:** JWT firmado con `crypto.randomBytes(32)` (generado en startup)
- **Roles:** `admin`, `manager`, `user`
- **Flujo:** Login → token en localStorage → Bearer en cada request

### Modelo de datos (store.json)
```json
{
  "versions": [
    {
      "id": "uuid",
      "name": "v1.0",
      "lists": [
        {
          "id": "uuid",
          "name": "UI Tests",
          "bugs": [
            {
              "id": "uuid",
              "title": "Bug title",
              "description": "...",
              "priority": "high",
              "status": "new",
              "assignee": "mehdi",
              "createdBy": "admin",
              "createdAt": 1234567890,
              "followers": ["kimi", "test"],
              "comments": [
                {
                  "id": "uuid",
                  "author": "Admin",
                  "authorUser": "admin",
                  "text": "comment",
                  "createdAt": 1234567890,
                  "editedAt": 1234567899,
                  "editedBy": "admin"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 📡 API ENDPOINTS (12 total)

| Método | Ruta | Auth | Descripción |
|--------|------|:---:|-------------|
| POST | `/api/login` | No | Login, devuelve token JWT |
| GET | `/api/auth` | Token | Verifica sesión activa |
| POST | `/api/register` | Token | Registro de nuevo usuario |
| GET | `/api/users` | Token | Lista usuarios (datos seguros) |
| POST | `/api/users` | Token | Sincronizar usuarios |
| PATCH | `/api/users/:id/role` | Admin | Cambiar rol (manager/user) |
| GET | `/api/store` | No | Obtener datos completos |
| POST | `/api/store` | Token | Guardar datos + notificaciones |
| PUT | `/api/comments` | Token | Editar comentario (autor/admin) |
| POST | `/api/bugs/:bugId/followers` | Token | Gestionar seguidores |
| POST | `/api/send-backup` | Token | Enviar backup por email |
| GET | `/api/send-backup` | Token | Enviar backup por email (GET) |

---

## 📧 CONFIGURACIÓN SMTP

| Parámetro | Valor |
|-----------|-------|
| **Host** | `smtp.hostinger.com` |
| **Puerto** | `465` (SSL) |
| **Usuario** | `admin@bugtracker.pro` |
| **Password** | `[REDACTED — en PM2 env]` |
| **Remitente** | `"Bug Tracker" <admin@bugtracker.pro>` |
| **Library** | `nodemailer` (única dependencia npm) |

### Historial de providers (NO REPETIR ESTOS ERRORES)

| Provider | Resultado | Por qué falló |
|----------|:---:|-------|
| Resend API | ❌ | Error 403 — solo emails verificados en sandbox |
| Gmail SMTP | ❌ | `535` — "Less secure apps" bloqueado |
| Outlook SMTP | ❌ | `535 5.7.139` — SMTP Auth deshabilitado |
| Brevo Relay | ❌ | Correos aceptados pero NUNCA entregados (0% deliverability) |
| **Hostinger** | ✅ | Dominio propio `bugtracker.pro`, entregabilidad perfecta |

**Lección:** Usa SIEMPRE el SMTP del hosting del dominio. Los relays gratuitos tienen mala reputación.

### Cómo configurar SMTP desde cero

```bash
# 1. Instalar nodemailer (única dependencia)
cd ~/bug-tracker && npm install nodemailer

# 2. Configurar variables de entorno en PM2
pm2 restart bug-tracker --update-env

# Las variables necesarias:
# SMTP_HOST=smtp.hostinger.com
# SMTP_PORT=465
# SMTP_USER=admin@bugtracker.pro
# SMTP_PASS=[REDACTED]
# SMTP_FROM="Bug Tracker" <admin@bugtracker.pro>
```

---

## 🔔 SISTEMA DE NOTIFICACIONES

### Matriz de destinatarios

| Perfil | ¿Qué recibe? | Condición |
|--------|-------------|-----------|
| **Admin** | Todo | Tiene email |
| **Manager** | Todo | Tiene email |
| **Seguidor** | Cambios en tarea seguida | Tiene email |
| **Asignado** | Cambios en sus tareas | Tiene email |
| **Subscriptor** | Todo | `notifications: true` + email |

### Lógica de notificaciones (server.js ~línea 509)

El flujo es:
1. `POST /api/store` recibe los datos
2. Compara `oldStore` vs `newStore` — detecta bugs nuevos, cambios de campos, comentarios nuevos
3. Clasifica cada cambio: `type: 'new'`, `type: 'updated'`, `type: 'new_list'`
4. Construye recipients (sin duplicados, usando Map con email como clave)
5. Envía emails en 3 formatos:
   - **Nueva tarea:** todos los detalles + comentarios iniciales
   - **Solo comentario:** autor + texto del comentario
   - **Actualización:** campos cambiados + asignado + prioridad

### Formato de emails

Se usa `toHtml()` para convertir texto a HTML:
- `
` → `<br>`
- URLs → `<a href>` clickeables
- `\n` literales → normalizados a `
` reales antes de procesar

---

## 🐛 CATÁLOGO DE ERRORES (16 errores documentados)

| # | Error | Síntoma | Causa | Solución | Fase |
|---|-------|---------|-------|----------|------|
| 1 | Migración hash rompió usuarios | No se podía hacer login | Contraseñas en texto plano vs pbkdf2 | Limpiar users.json, forzar re-registro | 1 |
| 2 | Resend sandbox restriction | Error 403 | API gratuita solo permite emails verificados | Cambiar a SMTP real | 2 |
| 3 | Gmail SMTP bloqueado | 535 auth failed | Google bloquea "less secure apps" | Probar otro provider | 2 |
| 4 | Outlook SMTP deshabilitado | 535 5.7.139 | Microsoft deshabilitó SMTP básico | Probar otro provider | 2 |
| 5 | Brevo 0% entregabilidad | Correos no llegan | Relay gratuito = mala reputación | Usar hosting propio | 2 |
| 6 | ReferenceError silencioso | Notificaciones no se enviaban | console.log usaba variables no declaradas | Mover logs dentro del bloque condicional | 3 |
| 7 | superUser indefinido | Admin sin notificaciones | Variable definida dentro de `if` | Declarar al inicio de la función | 3 |
| 8 | \n literales en emails | Saltos de línea no funcionaban | JSON escapa los `
` | `.replace(/\n/g, '
')` antes de toHtml() | 3 |
| 9 | Variable users no declarada | Crash en notificaciones | Se leía USERS_FILE bajo condición | Leer al inicio, siempre | 3 |
| 10 | **app.js truncado 400 líneas** | Usuario no podía acceder a tareas | sed/heredoc corrompió el archivo | `git checkout -- app.js` + parche Python | 4 |
| 11 | render() destruye ventana | Guardar comentario cerraba el modal | render() reconstruye todo el DOM | Solo llamar renderComments(), no render() | 4 |
| 12 | app.js vacío en Git | `git checkout` restauró 0 líneas | Archivo se corrompió sin notar | Verificar `wc -l` después de transferir | 4 |
| 13 | Followers no visibles | Sección no aparecía | Selector `.bug-detail-content` no existe | Usar `document.getElementById('comments-list')` | 6 |
| 14 | Username case-sensitive | "Kimi" ≠ "kimi" | Comparación `===` sin normalizar | `.toLowerCase()` en ambos lados | 6 |
| 15 | Manager sin notificaciones | Solo recibía new/resolved | Filtro `c.type === 'new'` muy restrictivo | Notificación incondicional para managers | 6 |
| 16 | Manager sin email | Nunca recibe nada | `email: ""` en users.json | El usuario debe configurar email | 6 |

---

## 🛠️ RECETA: CÓMO APLICAR CAMBIOS SIN ROMPER NADA

### Paso 1: Diagnóstico
```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && git status && git diff --stat HEAD'
```

### Paso 2: Backup
```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && cp app.js app.js.bak && cp server.js server.js.bak'
```

### Paso 3: Escribir el cambio como script Python LOCAL

Ejemplo para añadir un endpoint:
```python
# /tmp/add_endpoint.py
with open("/home/wilson/bug-tracker/server.js") as f:
    content = f.read()

old = "// === EXISTING CODE TO REPLACE ==="
new = "// === NEW CODE ==="

if old in content:
    content = content.replace(old, new)
    with open("/home/wilson/bug-tracker/server.js", "w") as f:
        f.write(content)
    print("OK")
else:
    print("FAIL — pattern not found!")
```

### Paso 4: Transferir y ejecutar
```bash
cat /tmp/add_endpoint.py | ssh wilson@100.124.137.123 'cat > /tmp/add_endpoint.py && python3 /tmp/add_endpoint.py'
```

### Paso 5: Verificar integridad
```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && node -c app.js && node -c server.js && echo "SINTAXIS OK" && wc -l app.js server.js'
```

### Paso 6: Reiniciar
```bash
ssh wilson@100.124.137.123 'PATH="$HOME/.npm-global/bin:$PATH" && pm2 restart bug-tracker'
```

### Paso 7: Verificar logs
```bash
ssh wilson@100.124.137.123 'tail -10 ~/.pm2/logs/bug-tracker-out.log && tail -5 ~/.pm2/logs/bug-tracker-error.log'
```

### Paso 8: Commit
```bash
ssh wilson@100.124.137.123 'cd ~/bug-tracker && git add -A && git commit -m "feat: descriptive message"'
```

---

## 📝 GUION DE RECONSTRUCCIÓN (Fase por Fase)

Si necesitas reconstruir el proyecto desde el commit inicial (`07cf7b9`):

### Fase 1: Seguridad (commit `1e05bd1`)
- Implementar `crypto.pbkdf2` para passwords
- Sistema de tokens JWT con `crypto.randomBytes`
- Endpoint `POST /api/register`
- ⚠️ **No olvidar:** limpiar `users.json` después de cambiar el hash

### Fase 2: Email — La Odisea SMTP
- `npm install nodemailer` (rompe regla zero-deps)
- **NO probar:** Resend, Gmail, Outlook, Brevo (todos fallan)
- **Usar directamente:** Hostinger SMTP (`smtp.hostinger.com:465`)
- Configurar `sendEmail()` con soporte HTML
- Endpoint `POST /api/send-backup`
- ⚠️ Variables de entorno en PM2, nunca hardcodeadas

### Fase 3: Notificaciones (commit `ff3aed6`)
- Función `sendNotificationEmail()`
- Detección de cambios comparando `oldStore` vs `newStore`
- Endpoint `PATCH /api/users/:id` para toggle `notifications`
- Checkbox en perfil de usuario
- ⚠️ **Peligro:** no usar variables antes de declararlas
- ⚠️ **Peligro:** normalizar `\n` antes de `toHtml()`

### Fase 4: Edición de Comentarios (commit `505b2d7`)
- Endpoint `PUT /api/comments` (solo autor o admin)
- Botón ✏️ en comentarios con textarea inline
- Campos `editedAt`, `editedBy` en comentarios
- ⚠️ **CRÍTICO:** nunca reemplazar `app.js` entero — solo parchear `renderComments`
- ⚠️ No llamar a `render()` después de guardar — destruye el modal

### Fase 5: Manager + Followers (commit `505b2d7`)
- Endpoint `PATCH /api/users/:id/role` (solo admin)
- Endpoint `POST /api/bugs/:bugId/followers`
- Campo `followers: []` en bugs
- `Auth.isManager` + badge MANAGER en panel admin
- `renderFollowersSection()` bajo `#comments-list`
- ⚠️ Username case-insensitive
- ⚠️ Selectores DOM: verificar que existen en HTML

---

## 🔧 TRUCOS Y COMANDOS ÚTILES

### Verificar qué funciones existen en app.js
```bash
grep -c 'function nombreFuncion' app.js
```

### Buscar un endpoint en server.js
```bash
grep -n "POST /api/bugs" server.js
```

### Ver si hay errores de sintaxis
```bash
node -c app.js && node -c server.js
```

### Ver cambios sin commitear
```bash
git diff --stat HEAD
```

### Restaurar un archivo específico
```bash
git checkout -- app.js
```

### Ver el historial completo
```bash
git log --oneline --all
```

### ssh + comando PM2 en una línea
```bash
ssh wilson@100.124.137.123 'PATH="$HOME/.npm-global/bin:$PATH" && cd ~/bug-tracker && pm2 status'
```

---

## 🚨 CUANDO TODO FALLA

### El servidor no responde
```bash
ssh wilson@100.124.137.123 'PATH="$HOME/.npm-global/bin:$PATH" && pm2 status && pm2 restart bug-tracker && tail -20 ~/.pm2/logs/bug-tracker-error.log'
```

### El frontend está roto (pantalla en blanco)
1. Abre DevTools (F12) → Console → busca errores JS
2. Verifica que `app.js` tiene ~2050 líneas: `wc -l app.js`
3. Si tiene menos de 1500 líneas, restaurar: `git checkout -- app.js`

### Las notificaciones no llegan
1. Verifica logs: `tail -30 ~/.pm2/logs/bug-tracker-out.log | grep Notify`
2. Verifica SMTP: `pm2 env 0 | grep SMTP_`
3. Verifica que el usuario tiene email: `grep email data/users.json`

### SSH no conecta (Tailscale)
- Posible causa: Tailscale pide re-autenticación
- Solución: pedir al humano que visite el link de Tailscale

---

## 📚 DOCUMENTOS RELACIONADOS

| Documento | Contenido |
|-----------|-----------|
| `DOCUMENTACION.md` | Documentación completa (76KB, 1768 líneas) |
| `AGENT_GUIDE.md` | Este archivo — guía para agentes IA |
| `GOOSE_ANALYSIS.md` | Análisis inicial del proyecto por Goose |

---

> *"El software no es solo código funcionando — es el conocimiento acumulado de por qué funciona de esa manera y no de otra."*
