# 🐛 Bug Tracker — Resumen Técnico

> Análisis generado por Goose el 2026-05-16.

---

## 1. Stack Tecnológico

| Capa | Tecnología | Dependencias |
|------|-----------|--------------|
| **Runtime** | Node.js (módulos nativos) | Ninguna |
| **Servidor** | `http.createServer` nativo | Ninguna |
| **Frontend** | Vanilla HTML / CSS / JavaScript | Ninguna |
| **Persistencia** | JSON plano en disco (`fs`) | Ninguna |
| **Estilos** | CSS Variables + Media Queries | Ninguna |

**Sin `package.json`, sin `node_modules`, sin bundlers.** El proyecto corre directamente con:

```bash
node server.js
```

---

## 2. Arquitectura General

```
┌─────────────────┐      HTTP/JSON      ┌─────────────────┐
│   Navegador     │ ◄─────────────────► │  Node.js Server │
│  (Vanilla JS)   │                     │   (server.js)   │
└─────────────────┘                     └────────┬────────┘
         │                                       │
         │ localStorage (offline)                │ fs.writeFileSync
         ▼                                       ▼
┌─────────────────┐                     ┌─────────────────┐
│  bugtracker_*   │                     │   data/*.json   │
│  (localStorage) │                     │  store.json     │
└─────────────────┘                     │  users.json     │
                                        └─────────────────┘
```

### Flujo de datos
1. El servidor inyecta datos iniciales en el HTML (`window.__SERVER_DATA__`).
2. El cliente opera principalmente sobre `localStorage` (modo offline-first).
3. Si detecta servidor (`http://`), sincroniza vía `fetch` (fire-and-forget `POST`s).
4. El servidor persiste todo en archivos JSON planos.

---

## 3. Estructura de Archivos

```
bug-tracker/
├── server.js           # Servidor HTTP nativo (217 líneas)
├── app.js              # Lógica frontend completa (1745 líneas)
├── BugTracker.html     # UI principal (676 líneas)
├── styles.css          # Temas dark/twilight/light + responsive (873 líneas)
├── data/
│   ├── store.json      # Versiones, listas, bugs, comentarios
│   └── users.json      # Usuarios con contraseñas en base64
├── DOCUMENTACION.md
├── GUIA_ACTUALIZACION_SERVIDOR.md
└── GOOSE_ANALYSIS.md   # Este archivo
```

**Total: ~3.500 líneas de código, cero dependencias externas.**

---

## 4. Backend (`server.js`)

### Módulos nativos usados
- `http` — servidor web
- `fs` — lectura/escritura de JSON
- `path` — rutas seguras
- `os` — detección de IP local

### Endpoints API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/users` | Leer usuarios |
| `POST` | `/api/users` | Guardar usuarios |
| `GET` | `/api/store` | Leer datos (versiones/listas/bugs) |
| `POST` | `/api/store` | Guardar datos |
| `GET` | `/api/backup` | Descargar backup completo (JSON) |
| `POST` | `/api/restore` | Restaurar desde backup |

### Características
- **CORS habilitado** para desarrollo local.
- **Anti directory traversal** en archivos estáticos.
- **Inyección SSR**: inserta `window.__SERVER_DATA__` en el HTML para carga instantánea.
- **Auto-creación** de `data/` y archivos JSON si no existen.

---

## 5. Frontend (`app.js` + `BugTracker.html`)

### Capas de abstracción

| Objeto | Responsabilidad |
|--------|-----------------|
| `Sync` | Detección de servidor, pull/push vía `fetch`, fallback a localStorage |
| `Auth` | Registro, login, sesión, roles (`admin` / `user`), gestión de usuarios |
| `Store` | CRUD de versiones, listas, bugs, comentarios. Persistencia local + servidor |
| `ThemeManager` | Temas: `dark`, `twilight`, `light` |

### Modelo de datos (en JSON)

```json
{
  "versions": [
    {
      "id": "uuid",
      "name": "__default__",
      "lists": [
        {
          "id": "uuid",
          "name": "Sprint 1",
          "color": "#hex",
          "bugs": [
            {
              "id": "uuid",
              "title": "...",
              "status": "new|in-progress|passed|failed",
              "priority": "low|medium|high|critical",
              "assignee": "persona1, persona2",
              "comments": [...],
              "resolvedBy": "...",
              "resolvedVersion": "...",
              "createdAt": 1234567890
            }
          ]
        }
      ]
    }
  ],
  "activeVersionId": "uuid",
  "activeListId": "uuid"
}
```

### Funcionalidades principales
- **Gestión de bugs**: crear, editar, eliminar, resolver, comentar.
- **Listas**: agrupan bugs (visibles en sidebar).
- **Versiones**: abstracción oculta al usuario (solo existe `__default__` en UI).
- **Filtros globales**: por versión SW, tester, asignado, cliente, estado, tareas resueltas.
- **Búsqueda**: local y global, busca en todos los campos incluyendo fechas.
- **Ordenamiento**: por fecha, prioridad, estado, título, asignado, cliente.
- **Estadísticas**: total, abiertas, en progreso, resueltas.
- **Backup/Restore**: exportar/importar JSON completo.
- **Responsive**: sidebar colapsable, touch-friendly, mobile-first CSS.

### Seguridad frontend (notas)
- Contraseñas almacenadas en `btoa()` (base64), **no es encriptación**.
- Sin JWT, sin cookies de sesión: la sesión vive en `localStorage`.
- Sin sanitización de HTML en inputs (usa `escapeHtml()` para render).

---

## 6. CSS (`styles.css`)

### Temas
Tres temas controlados por `data-theme` en `<html>`:
- `dark` (default): fondo `#0d1117`, acento azul
- `twilight`: tonos púrpura/gris
- `light`: fondo claro, texto oscuro

### Responsive
- Breakpoint en `768px` para móviles.
- Sidebar se convierte en drawer deslizable.
- Tarjetas y modales se adaptan al ancho de pantalla.
- Touch targets mínimos de `32px–40px`.

---

## 7. Puntos de Atención / Deuda Técnica

| # | Issue | Severidad |
|---|-------|-----------|
| 1 | Contraseñas en base64 (`btoa`) | 🔴 Alta — no es hash seguro |
| 2 | Sin autenticación de servidor (cualquiera puede POST a /api/*) | 🔴 Alta |
| 3 | Sin validación de datos en servidor | 🟡 Media |
| 4 | Sin rate limiting | 🟡 Media |
| 5 | `localStorage` tiene límite de ~5MB | 🟢 Baja — datos JSON suelen ser pequeños |
| 6 | Sin tests automatizados | 🟢 Baja |
| 7 | Todo el frontend en un solo archivo (`app.js` ~1750 líneas) | 🟢 Baja — mantenibilidad |

---

## 8. Cómo ejecutar

```bash
# 1. Clonar / entrar al directorio
cd bug-tracker

# 2. Iniciar servidor (Node.js nativo, sin instalar nada)
node server.js

# 3. Abrir en navegador
#    Local:  http://localhost:3000
#    Red:    http://<IP-local>:3000
```

---

## 9. Conclusión

Bug Tracker es una **aplicación fullstack completa construida con cero dependencias**, ideal para entornos sin acceso a npm o donde la simplicidad es prioridad. Usa un patrón **offline-first** con sincronización opcional a servidor, y demuestra que es posible crear CRUDs funcionales con autenticación, temas, responsive design y backup/restore usando únicamente APIs nativas del navegador y Node.js.

Para producción se recomendaría: migrar contraseñas a bcrypt, agregar autenticación JWT en servidor, validar payloads, y eventualmente separar `app.js` en módulos.
