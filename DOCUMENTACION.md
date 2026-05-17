# Documentación del Proyecto Bug Tracker

> **Versión de la documentación:** 2.1 — Ampliada con historial completo de errores y lecciones aprendidas
> **Fecha de última actualización:** 17 de mayo de 2026

---

## 📋 Tabla de Contenidos

1. [Resumen Ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura del Sistema](#2-arquitectura-del-sistema)
3. [Historial de Cambios por Fase](#3-historial-de-cambios-por-fase)
   - [Fase 0: Fundación — Proyecto Base](#fase-0-fundación--proyecto-base)
   - [Fase 1: Análisis Inicial y Seguridad](#fase-1-análisis-inicial-y-seguridad)
   - [Fase 2: Envío de Correos — La Odisea SMTP](#fase-2-envío-de-correos--la-odisea-smtp)
   - [Fase 3: Sistema de Notificaciones por Correo](#fase-3-sistema-de-notificaciones-por-correo)
   - [Fase 4: Edición de Comentarios](#fase-4-edición-de-comentarios)
   - [Fase 5: Corrupción de app.js Restaurado](#fase-5-corrupción-de-appjs-restaurado)
   - [Fase 6: Rol Manager + Sistema de Followers](#fase-6-rol-manager--sistema-de-followers)
   - [Fase 7: Split Store Architecture + Login Fix](#fase-7-split-store-architecture--login-fix)
 4. [🛑 Errores y Lecciones Aprendidas](#4-errores-y-lecciones-aprendidas)
   - [Error 1: Migración de hash rompió usuarios existentes](#error-1-migración-de-hash-rompió-usuarios-existentes)
   - [Error 2: Resend API — Sandbox Restriction](#error-2-resend-api--sandbox-restriction)
   - [Error 3: Gmail SMTP — Less Secure Apps bloqueado](#error-3-gmail-smtp--less-secure-apps-bloqueado)
   - [Error 4: Outlook SMTP — SMTP Auth deshabilitado](#error-4-outlook-smtp--smtp-auth-deshabilitado)
   - [Error 5: Brevo SMTP Relay — Correos nunca entregados](#error-5-brevo-smtp-relay--correos-nunca-entregados)
   - [Error 6: ReferenceError silencioso en notificaciones](#error-6-referenceerror-silencioso-en-notificaciones)
   - [Error 7: superUser indefinido — El admin no recibía notificaciones](#error-7-superuser-indefinido--el-admin-no-recibía-notificaciones)
   - [Error 8: Formato de email con \n literales](#error-8-formato-de-email-con-n-literales)
   - [Error 9: Variable `users` usada antes de declararse](#error-9-variable-users-usada-antes-de-declararse)
   - [Error 10: CRÍTICO — app.js truncado a 1198 líneas](#error-10-crítico--appjs-truncado-a-1198-líneas)
   - [Error 11: render() destruye la ventana de detalle](#error-11-render-destruye-la-ventana-de-detalle)
   - [Error 12: app.js restaurado vacío desde Git](#error-12-appjs-restaurado-vacío-desde-git)
   - [Error 17: v.lists is not iterable (split store)](#error-17-vlists-is-not-iterable-split-store)
   - [Error 18: Login falla por token no guardado en localStorage](#error-18-login-falla-por-token-no-guardado-en-localstorage)
5. [Configuración SMTP](#5-configuración-smtp)
6. [API Endpoints](#6-api-endpoints)
7. [Sistema de Notificaciones](#7-sistema-de-notificaciones)
8. [Sistema de Permisos](#8-sistema-de-permisos)
9. [Estructura de Archivos del Proyecto](#9-estructura-de-archivos-del-proyecto)
10. [Guía de Desarrollo: Cómo NO Repetir los Errores](#10-guía-de-desarrollo-cómo-no-repetir-los-errores)
11. [Glosario de Decisiones Técnicas](#11-glosario-de-decisiones-técnicas)

---

## 1. Resumen Ejecutivo

**Bug Tracker** es una aplicación web full-stack de seguimiento de incidencias (bugs/tareas), construida bajo la filosofía **Zero Dependencies**: exclusivamente con la librería estándar de Node.js (`http`, `fs`, `path`, `crypto`), sin frameworks ni paquetes npm externos (con una excepción documentada: Nodemailer para envío de correos).

### Características principales

- **Autenticación segura** con hashing PBKDF2 (SHA-512, 210,000 iteraciones, salt aleatorio de 64 bytes)
- **Tokens de sesión** JWT-like firmados con HMAC-SHA256
- **Sistema de notificaciones por correo electrónico** con SMTP vía Hostinger
- **Gestión completa de bugs**: crear, editar, asignar, comentar, cambiar prioridad/estado
- **Edición de comentarios** con registro de autor y timestamp
- **Reportes exportables** (CSV)
- **Tema oscuro** con CSS responsivo
- **Almacenamiento en JSON** (sin base de datos)

### Stack tecnológico

| Capa | Tecnología |
|------|------------|
| Backend | Node.js 24.x (stdlib: `http`, `fs`, `path`, `crypto`) |
| Email | Nodemailer (única dependencia externa) |
| Frontend | Vanilla JavaScript ES6+ (SPA, sin frameworks) |
| Estilos | CSS3 (variables, tema oscuro) |
| Datos | Archivos JSON planos (`data/v_*.json`, `data/users.json`) |

---

## 2. Arquitectura del Sistema

### 2.1 Visión general

```
┌──────────────────────────────────────────────────────┐
│                   Cliente (Navegador)                 │
│  BugTracker.html + styles.css + app.js (~1900 líneas)│
│  SPA: renderizado dinámico, filtros, modales         │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP (fetch API)
                       ▼
┌──────────────────────────────────────────────────────┐
│                server.js (736 líneas)                 │
│  • Servidor HTTP nativo (Node.js http module)        │
│  • Router de endpoints REST                          │
│  • Autenticación: PBKDF2 + tokens HMAC              │
│  • Notificaciones: Nodemailer + SMTP Hostinger       │
│  • CORS y validación de entrada                      │
└──────────┬───────────────────────────┬───────────────┘
           │                           │
           ▼                           ▼
┌──────────────────┐    ┌──────────────────────────────┐
│ data/v_*.json   │    │      data/users.json          │
│ Bugs, comentarios│    │  Usuarios con hash PBKDF2    │
│ asignaciones, etc│    │  Preferencias (notificaciones)│
└──────────────────┘    └──────────────────────────────┘
```

### 2.2 Flujo de autenticación

1. **Registro**: `POST /api/register` → contraseña hasheada con `crypto.pbkdf2` (salt 64 bytes, 210k iteraciones, clave 64 bytes) → almacenada como `salt:hash` en `users.json`
2. **Login**: `POST /api/login` → verifica hash → genera token HMAC-SHA256 con `userId|expiry|signature` → devuelve token al cliente
3. **Peticiones autenticadas**: `Authorization: Bearer <token>` → `verifyToken()` extrae userId del payload firmado

### 2.3 Modelo de datos

**Bug (store.json)**:
- `id`: string único
- `title`, `description`: texto
- `priority`: "low" | "medium" | "high" | "critical"
- `status`: "open" | "in_progress" | "resolved" | "closed"
- `assignedTo`: string (userId) o null
- `createdBy`, `createdAt`: autor y timestamp
- `comments[]`: array de {id, userId, text, createdAt, editedAt?, editedBy?}
- `resolvedAt`, `resolvedBy`: resolución

**User (users.json)**:
- `id`: string único
- `username`, `email`, `role`: "admin" | "user"
- `password`: `salt:hash` (formato PBKDF2)
- `notifications`: boolean (toggle de notificaciones email)

---

## 3. Historial de Cambios por Fase

### Fase 0: Fundación — Proyecto Base

**Commit:** `07cf7b9` — Punto de restauración inicial

**Estado inicial del proyecto:**
- Bug Tracker funcional con autenticación simple
- Contraseñas en **texto plano** almacenadas en `data/users.json`
- Sin Git (repositorio inicializado en este commit)
- Principio Zero Dependencies: solo `http`, `fs`, `path` de Node.js stdlib
- Sin sistema de envío de correos
- Frontend SPA con renderizado básico de columnas (To Do, In Progress, Done)
- CRUD de bugs con asignación de usuarios

**Decisiones de diseño originales:**
- **Zero Dependencies**: evitar el infierno de dependencias npm y vulnerabilidades de supply chain
- **JSON como almacenamiento**: simplicidad, sin necesidad de servidor de base de datos
- **SPA vanilla JS**: sin React/Vue/Angular para mantener la filosofía zero-dep también en frontend

---

### Fase 1: Análisis Inicial y Seguridad

**Commit:** `1e05bd1` — Mejora de seguridad

**Cambios realizados:**

1. **Hashing de contraseñas con PBKDF2**
   - Reemplazo de almacenamiento en texto plano por `crypto.pbkdf2Sync`
   - Parámetros: SHA-512, 210,000 iteraciones, salt 64 bytes, clave derivada 64 bytes
   - Formato de almacenamiento: `saltHex:derivedKeyHex`
   - Función `hashPassword(password)` → genera salt aleatorio y deriva clave
   - Función `verifyPassword(password, storedHash)` → extrae salt y verifica

2. **Autenticación basada en tokens JWT-like**
   - Función `generateToken(userId)`: crea token con formato `userId|expiryTimestamp|hmacSignature`
   - Función `verifyToken(token)`: valida firma HMAC-SHA256 y expiración
   - Middleware `authenticate(req, res)`: extrae token del header `Authorization: Bearer <token>`
   - Expiración de 24 horas

3. **Validación de endpoints**
   - Verificación de `Content-Type: application/json` en POST/PUT/PATCH
   - Campos requeridos validados antes de procesar
   - Rate limiting básico por IP (máximo 100 peticiones por minuto)

#### ❌ Error 1: Migración de hash rompió usuarios existentes

**Síntoma:** Tras implementar PBKDF2, ningún usuario podía iniciar sesión. El servidor comparaba el hash derivado de la contraseña ingresada con el valor almacenado, pero los usuarios existentes en `data/users.json` aún tenían contraseñas en **texto plano**.

**Causa raíz:** El código nuevo llamaba a `verifyPassword(password, storedPassword)` que asumía formato `salt:hash`, pero los registros antiguos tenían `"password": "admin123"` (texto plano). La función fallaba al intentar `split(':')` y comparar.

**Solución:** Se limpió completamente `data/users.json` (se vació el array de usuarios), forzando a todos los usuarios existentes a registrarse de nuevo con el nuevo sistema de hash. No se escribió un script de migración.

**Lección aprendida → [ver Error 1 en sección 4](#error-1-migración-de-hash-rompió-usuarios-existentes)**

---

### Fase 2: Envío de Correos — La Odisea SMTP

**Objetivo:** Enviar backups y notificaciones por correo electrónico.

**Contexto:** Esta fase rompió temporalmente la regla "Zero Dependencies" al instalar **Nodemailer** (única dependencia externa del proyecto). Se justifica porque implementar un cliente SMTP desde cero con la stdlib es inviable y propenso a errores de seguridad.

A continuación, el calvario completo de providers SMTP probados:

---

#### Intento 1: Resend API

**Commit:** `0b1dc90`

**Configuración:**
- Provider: [Resend](https://resend.com) (API HTTP, no SMTP)
- SDK: `@resend/node` (dependencia adicional)
- Autenticación: API Key

**Resultado:** ❌ Fracaso

**Error:** `403 Forbidden — Sandbox restriction`. Resend en modo sandbox **solo permite enviar correos a direcciones verificadas** en el dashboard (típicamente solo el email del propietario de la cuenta). Cualquier intento de enviar a otro destinatario era rechazado con 403.

**Por qué falló para este proyecto:** El Bug Tracker necesita enviar correos a **múltiples usuarios** (admin, asignados, creadores). En el plan gratuito de Resend, esto es imposible sin verificar cada dirección manualmente. Para producción multiusuario se requiere un plan de pago y configuración de dominio.

**Lección aprendida → [ver Error 2 en sección 4](#error-2-resend-api--sandbox-restriction)**

---

#### Intento 2: Gmail SMTP

**Commit:** `c35297c`

**Configuración:**
- Host: `smtp.gmail.com`
- Puerto: `587` (STARTTLS)
- Autenticación: usuario + contraseña Gmail

**Resultado:** ❌ Fracaso

**Error:** `535 5.7.8 Username and Password not accepted. Application-specific password required.`

**Causa:** Google deshabilitó el acceso de "Less secure apps" (aplicaciones menos seguras) para todas las cuentas Gmail desde mayo de 2022. Las opciones son:
- **App Passwords**: solo disponible si la cuenta tiene 2FA (Autenticación en Dos Factores) habilitado
- **OAuth2**: requiere registrar una aplicación en Google Cloud Console, obtener client_id/client_secret, y manejar tokens de refresco — excesivamente complejo para un proyecto pequeño

**Lección aprendida → [ver Error 3 en sección 4](#error-3-gmail-smtp--less-secure-apps-bloqueado)**

---

#### Intento 3: Outlook SMTP

**Commit:** `ef2b39b`

**Configuración:**
- Host: `smtp-mail.outlook.com`
- Puerto: `587` (STARTTLS)
- Usuario: `Bugtracker1@outlook.com`
- Contraseña: [REDACTED]

**Resultado:** ❌ Fracaso

**Error:** `535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox.`

**Causa:** Microsoft deshabilitó **SMTP AUTH básico** para todas las cuentas nuevas de Outlook/Hotmail/Office365 a partir de octubre de 2022. Solo está disponible para tenants enterprise con políticas específicas. Opciones:
- **OAuth2** con Microsoft Graph API: requiere registro de app en Azure AD
- **Cuentas enterprise**: no aplicable a cuentas personales gratuitas

**Lección aprendida → [ver Error 4 en sección 4](#error-4-outlook-smtp--smtp-auth-deshabilitado)**

---

#### Intento 4: Brevo (Sendinblue) SMTP Relay

**Estado:** NO commiteado (intento fallido documentado)

**Configuración:**
- Host: `smtp-relay.brevo.com`
- Puerto: `465` (SSL/TLS)
- Usuario: `ab7e8f001@smtp-brevo.com` (dirección genérica de relay)
- Contraseña: API Key de Brevo
- Remitente configurado: `Mehdi@remvt.com` (dirección verificada en Brevo)

**Resultado:** ❌ Fracaso parcial

**Síntoma:** Los correos eran **aceptados por Brevo** (respuesta 250 OK del servidor SMTP), pero **nunca llegaban a la bandeja de entrada del destinatario**. Ni siquiera a spam.

**Investigación y causas:**

1. **Reputación de dominio del relay**: La dirección de relay genérica (`@smtp-brevo.com`) es usada por miles de cuentas gratuitas. Los filtros anti-spam (SpamAssassin, Gmail, Outlook) tienen estos dominios de relay en baja estima.

2. **SPF/DKIM/DMARC**: Aunque Brevo firma los correos, los relays compartidos no permiten autenticación de dominio propia (SPF/DKIM) en el plan gratuito. Esto reduce drásticamente la entregabilidad.

3. **Cambio de remitente**: Se intentó poner `Mehdi@remvt.com` como remitente (dirección verificada), pero sin SPF autorizando a Brevo como emisor legítimo, los filtros anti-spam detectan la inconsistencia y descartan el correo silenciosamente.

**Métrica de fracaso:** 0% de entregabilidad. ~15 correos enviados, 0 recibidos.

**Lección aprendida → [ver Error 5 en sección 4](#error-5-brevo-smtp-relay--correos-nunca-entregados)**

---

#### ✅ Solución Final: Hostinger SMTP

**Configuración:**
- Host: `smtp.hostinger.com`
- Puerto: `465` (SSL/TLS implícito)
- Usuario: `admin@bugtracker.pro`
- Contraseña: [REDACTED]
- Remitente: `"Bug Tracker" <admin@bugtracker.pro>`
- Dominio: `bugtracker.pro` (propio, registrado en Hostinger)

**Resultado:** ✅ Éxito — entregabilidad instantánea y consistente

**Por qué funciona:**

1. **Dominio propio con reputación limpia**: `bugtracker.pro` no está en ninguna blacklist y tiene historial de envío limpio (es nuevo)
2. **SPF/DKIM/DMARC correctos**: Hostinger configura automáticamente los registros DNS para autenticación de correo
3. **SMTP del hosting**: Los servidores de Hostinger están configurados para envío transaccional legítimo, no son relays compartidos de baja reputación
4. **TLS en puerto 465**: Conexión segura implícita, sin negociación STARTTLS

**Coste:** Incluido en el plan de hosting (hosting compartido con dominio). ~$2-5/mes.

**Lección clave de toda la Fase 2:**
> Para proyectos reales con necesidad de entregabilidad, **vale la pena pagar por un dominio y hosting propios**. Los servicios gratuitos de email transaccional están diseñados para pruebas, no para producción. La entregabilidad es el verdadero desafío del correo electrónico, no el envío en sí.

---

### Fase 3: Sistema de Notificaciones por Correo

**Commit:** `ff3aed6` — Sistema completo de notificaciones

**Cambios realizados:**

1. **Nueva función `sendNotificationEmail()` en server.js:**
   - Detecta cambios en bugs comparando `oldBugs` (estado antes de guardar) con `updatedBug` (nuevo estado)
   - Identifica campos modificados: `status`, `priority`, `assignedTo`, `title`, `comments`
   - Construye lista de destinatarios: creador del bug + usuario asignado (si cambió) + admin (siempre)
   - Respeta preferencia `notifications: false` del usuario
   - Formato HTML con diseño responsive para clientes de correo
   - Envío asíncrono (no bloquea la respuesta HTTP)

2. **Endpoint `PATCH /api/users/:id`:**
   - Permite toggle de preferencia de notificaciones
   - Solo el propio usuario puede modificar sus preferencias
   - Campo: `{ "notifications": true/false }`

3. **UI de perfil con checkbox de notificaciones:**
   - Checkbox "Recibir notificaciones por correo" en el panel de perfil
   - Guardado instantáneo al cambiar (sin botón de submit adicional)
   - Feedback visual con cambio de estado

#### Errores encontrados y corregidos en esta fase

##### ❌ Error 6: ReferenceError silencioso que mataba las notificaciones

**Síntoma:** Las notificaciones simplemente no se enviaban. Los logs del servidor mostraban peticiones HTTP llegando al endpoint, pero el log de diagnóstico decía `"Cambios detectados: 0"` incluso cuando había cambios obvios.

**Causa raíz:** Un `console.log` de diagnóstico hacía referencia a `Object.keys(oldBugs)` y `Object.keys(newBugs)` **antes** de que esas variables fueran declaradas. Las variables se declaraban 3 líneas después, dentro de un bloque `if`. El `ReferenceError` mataba silenciosamente la ejecución de la función de notificaciones.

```javascript
// ❌ Código con bug:
console.log('Comparando:', Object.keys(oldBugs), '->', Object.keys(newBugs));
// ... otras líneas ...
if (bugId) {
    const oldBugs = ...;  // Declarado demasiado tarde
    const newBugs = ...;  // Declarado demasiado tarde
}
```

**Solución:** Mover el `console.log` de diagnóstico **dentro** del bloque `if` donde las variables existen:
```javascript
// ✅ Código corregido:
if (bugId) {
    const oldBugs = ...;
    const newBugs = ...;
    console.log('Comparando:', Object.keys(oldBugs), '->', Object.keys(newBugs));
}
```

**Lección → [ver Error 6 en sección 4](#error-6-referenceerror-silencioso-en-notificaciones)**

---

##### ❌ Error 7: `superUser` indefinido — Admin no recibía notificaciones

**Síntoma:** El administrador no recibía notificaciones de cambios en tareas **no asignadas** a nadie. Si una tarea sin `assignedTo` era modificada, solo se notificaba al creador, no al admin.

**Causa raíz:** La variable `superUser` se definía **dentro** del bloque `if (changed.length > 0)`:
```javascript
if (changed.length > 0) {
    const superUser = users.find(u => u.role === 'admin');
    // ...
}
```

Pero se necesitaba **antes** de ese bloque para decidir la lista de destinatarios:
```javascript
// Necesitaba superUser aquí para añadirlo a recipients
recipients.add(superUser.email);
```

**Solución:** Mover `const superUser = users.find(u => u.role === 'admin')` al principio de la función `sendNotificationEmail()`, antes de cualquier condicional.

**Lección → [ver Error 7 en sección 4](#error-7-superuser-indefinido--el-admin-no-recibía-notificaciones)**

---

##### ❌ Error 8: Formato de email con `\n` literales

**Síntoma:** Los correos llegaban con `\n` visibles en el texto (los dos caracteres backslash + n) en lugar de saltos de línea reales. El texto aparecía como una sola línea larga con `\n` esparcidos.

**Causa raíz:** Los datos del bug (title, description, comments) viajan serializados por JSON. Cuando JavaScript serializa un string que contiene saltos de línea reales (`\n` como carácter 0x0A), los representa como el escape `\\n` (dos caracteres: backslash y 'n'). Al pasarlos a `toHtml()`, estos escapados no se interpretaban como saltos de línea.

**Solución:** Añadir `.replace(/\\n/g, '\n')` al texto del correo **antes** de convertirlo a HTML con `toHtml()`:
```javascript
const textNormalized = emailText.replace(/\\n/g, '\n');
const htmlBody = textNormalized.toHtml(); // Convierte saltos reales a <br>
```

**Lección → [ver Error 8 en sección 4](#error-8-formato-de-email-con-n-literales)**

---

##### ❌ Error 9: Variable `users` usada antes de declararse

**Síntoma:** Similar al Error 6. La función fallaba silenciosamente en ciertos flujos de ejecución porque `users` no estaba disponible cuando se necesitaba.

**Causa raíz:** La variable `users` se leía de `USERS_FILE` dentro de un bloque `if` que no siempre se ejecutaba:
```javascript
// ❌ Bug: users solo existe si se entra en este if
if (someCondition) {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
// users no existe aquí si someCondition era false
```

**Solución:** Leer `users` al inicio de la función, incondicionalmente:
```javascript
// ✅ Corrección:
const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
// Ahora users siempre está disponible
```

**Lección → [ver Error 9 en sección 4](#error-9-variable-users-usada-antes-de-declararse)**

---

### Fase 4: Edición de Comentarios

**Estado:** NO commiteado aún

**Cambios en backend (server.js):**

- **Nuevo endpoint:** `PUT /api/comments`
  - Autenticación requerida
  - Solo el **autor del comentario** o un **admin** pueden editar
  - Busca el comentario dentro del array `comments` del bug correspondiente
  - Añade metadatos de edición:
    - `editedAt`: timestamp ISO de la edición
    - `editedBy`: userId de quien realizó la edición
  - Devuelve el bug completo actualizado

**Cambios en frontend (app.js):**

- **Botón de editar (✏️):** visible solo para el autor del comentario o admin, junto al texto del comentario
- **Función `startEditComment(bugId, commentId)`:**
  - Oculta el texto del comentario
  - Muestra un `<textarea>` pre-rellenado con el texto actual
  - Muestra botones "Guardar" y "Cancelar"
- **Función `saveEditComment(bugId, commentId)`:**
  - Envía `PUT /api/comments` con el nuevo texto
  - Recibe el bug actualizado
  - Actualiza los comentarios en la UI
- **Función `cancelEditComment(bugId, commentId)`:**
  - Restaura el texto original
  - Oculta el textarea y muestra el texto normal

#### Errores en esta fase

##### ❌ Error 10: CRÍTICO — `app.js` truncado a 1198 líneas

**Síntoma:** Tras aplicar el parche de edición de comentarios al frontend, el usuario reportó que **no podía acceder a las tareas**. La ventana de detalle de bug no se abría. El tablero principal se veía pero ninguna interacción funcionaba.

**Causa raíz:** Al aplicar el parche para modificar la función `renderComments`, se borraron accidentalmente **397 líneas** (de ~1595 líneas totales a 1198). Las funciones perdidas incluían:

- `openBugModal(bugId)` — abrir detalle de tarea
- `openBugModalWithContext(bugId, listId)` — abrir con contexto de columna
- `openResolveModal(bugId)` — modal de resolución
- `confirmAction(message, callback)` — confirmación genérica
- `escapeHtml(str)` — sanitización de HTML
- `getAssignees()` — obtener lista de usuarios asignables
- `openReportModal()` — modal de reportes
- `generateReport()` — generación de reportes CSV

**Cómo ocurrió:** El diff original estaba diseñado para reemplazar únicamente la función `renderComments`, pero el heredoc o `sed` utilizado para aplicar el parche incluyó la **eliminación de todo el bloque intermedio** entre el marcador de inicio y la función `renderComments`.

**Solución (2 pasos):**

1. **Restauración de emergencia:** `git checkout -- app.js` para recuperar la versión intacta del repositorio
2. **Parche quirúrgico:** Se escribió un **script Python** que:
   - Lee el archivo `app.js` completo
   - Busca la función `renderComments` por firma exacta
   - Reemplaza solo esa función con la nueva versión
   - **Verifica integridad post-parche**: confirma que todas las funciones críticas (`openBugModal`, `escapeHtml`, `generateReport`, etc.) siguen presentes en el archivo
   - Si falta alguna función, aborta y reporta el error

**Lección → [ver Error 10 en sección 4](#error-10-crítico--appjs-truncado-a-1198-líneas)**

---

##### ❌ Error 11: `render()` destruye la ventana de detalle

**Síntoma:** Tras corregir el Error 10 y restaurar las funciones, la edición de comentarios funcionaba pero con un efecto secundario grave:

- **Usuario normal (no-admin):** Al guardar un comentario editado, la ventana de detalle se **cerraba inmediatamente**. El comentario se guardaba en el servidor, pero la experiencia de usuario era terrible: parecía que la acción había fallado o cancelado.
- **Admin:** La ventana de detalle permanecía abierta (porque el admin estaba viendo el tablero completo), pero el cambio solo se reflejaba al cerrar y reabrir manualmente.

**Causa raíz:** La función `saveEditComment()` llamaba a `render()` después de recibir la respuesta del servidor:
```javascript
// ❌ Código con bug:
async function saveEditComment(bugId, commentId) {
    const response = await fetch('/api/comments', { ... });
    const updatedBug = await response.json();
    render(); // 💣 Esto reconstruye TODO el tablero
}
```

`render()` es una operación **destructiva** que:
1. Limpia completamente el DOM del tablero
2. Reconstruye las listas de columnas (To Do, In Progress, Done)
3. Re-aplica filtros
4. Re-renderiza todas las tarjetas de bugs

Esto **destruye cualquier ventana de detalle abierta**, ya que el modal de detalle del bug está anclado al DOM que `render()` elimina.

**Solución:** Quitar la llamada a `render()`. La función `renderComments(refreshed)` ya es suficiente para actualizar los comentarios inline en la ventana de detalle sin destruir el resto de la UI:
```javascript
// ✅ Código corregido:
async function saveEditComment(bugId, commentId) {
    const response = await fetch('/api/comments', { ... });
    const updatedBug = await response.json();
    renderComments(updatedBug); // Solo actualiza comentarios, no destruye nada
}
```

**Lección → [ver Error 11 en sección 4](#error-11-render-destruye-la-ventana-de-detalle)**

---

### Fase 5: Corrupción de `app.js` Restaurado

**Contexto:** Durante la recuperación del Error 10, se descubrió un problema adicional.

#### ❌ Error 12: `app.js` restaurado desde Git estaba vacío

**Síntoma:** Al ejecutar `git checkout -- app.js` para restaurar el archivo tras el Error 10, el archivo recuperado tenía **0 líneas** (vacío). El comando se ejecutó sin errores pero el resultado era un archivo sin contenido.

**Causa raíz:** En algún momento anterior, un `scp`, `rsync` o heredoc había truncado `app.js` a 0 bytes y ese estado corrupto fue commiteado accidentalmente (o el último commit no tenía el archivo). Git almacenaba la versión vacía como la "última versión buena".

**Solución:** Hacer checkout desde un commit anterior donde se sabía que el archivo estaba íntegro:
```bash
git log --oneline -- app.js          # Ver historial del archivo
git checkout <commit_anterior> -- app.js  # Restaurar desde commit seguro
```

**Lección → [ver Error 12 en sección 4](#error-12-appjs-restaurado-vacío-desde-git)**

---

## 4. 🛑 Errores y Lecciones Aprendidas

> **Esta es la sección más importante de la documentación.** Cada error está documentado con su síntoma observable, causa raíz, solución aplicada y lección extraída para evitar repetirlo.

---

### Error 1: Migración de hash rompió usuarios existentes

| Campo | Detalle |
|--------|---------|
| **Fase** | 1 — Seguridad |
| **Commit** | `1e05bd1` |
| **Severidad** | 🔴 Alta (bloquea acceso a todos los usuarios) |
| **Tiempo hasta detección** | Inmediato (primer intento de login) |
| **Tiempo hasta solución** | ~10 minutos |

**Síntoma:**
Ningún usuario podía iniciar sesión después de implementar PBKDF2. El servidor no daba errores explícitos, simplemente devolvía `401 Unauthorized` para todas las credenciales, incluso las correctas.

**Causa raíz:**
El nuevo método `verifyPassword(password, storedHash)` asume que `storedHash` tiene formato `saltHex:derivedKeyHex`. Al llamar `storedHash.split(':')`, si el valor es texto plano (ej. `"admin123"`), el split produce `["admin123"]` (array de un elemento) y `derivedKeyHex` queda como `undefined`. La comparación siempre falla.

**Solución:**
Limpieza total de `data/users.json` (array vacío `[]`), forzando re-registro de todos los usuarios. No se implementó script de migración.

**Lección:**
> **Las migraciones de esquema de datos requieren scripts de migración, no solo cambiar el código.** Un cambio en el formato de almacenamiento de datos (texto plano → hash) debe incluir un script que itere sobre los registros existentes, los transforme al nuevo formato, y verifique la integridad. Limpiar la base de datos es aceptable en desarrollo temprano, pero catastrófico en producción.

**Checklist para futuras migraciones de datos:**
- [ ] Script de migración que lea el formato antiguo
- [ ] Transformación campo por campo con validación
- [ ] Backup de los datos originales antes de migrar
- [ ] Verificación post-migración (al menos un registro de prueba)
- [ ] Rollback plan por si la migración falla

---

### Error 2: Resend API — Sandbox Restriction

| Campo | Detalle |
|--------|---------|
| **Fase** | 2 — Envío de correos |
| **Commit** | `0b1dc90` |
| **Severidad** | 🟡 Media (bloquea funcionalidad pero no el sistema) |
| **Tiempo hasta detección** | ~30 minutos (prueba con email no verificado) |
| **Tiempo hasta solución** | ~2 horas (investigación + cambio de provider) |

**Síntoma:**
`403 Forbidden` al enviar correos a cualquier destinatario que no fuera el email del propietario de la cuenta Resend.

**Causa raíz:**
Desconocimiento de las restricciones del plan gratuito de Resend. La documentación indica que en modo sandbox solo se puede enviar a "verified emails", pero este detalle se pasó por alto al elegir el provider.

**Solución:**
Abandonar Resend y buscar alternativas SMTP.

**Lección:**
> **Leer los límites del plan gratuito ANTES de implementar.** No asumir que "gratuito" significa "sin restricciones para desarrollo". Cada servicio tiene limitaciones específicas (destinatarios, volumen, dominio, autenticación) que deben evaluarse contra los requisitos del proyecto antes de escribir una sola línea de código.

---

### Error 3: Gmail SMTP — Less Secure Apps bloqueado

| Campo | Detalle |
|--------|---------|
| **Fase** | 2 — Envío de correos |
| **Commit** | `c35297c` |
| **Severidad** | 🟡 Media |
| **Tiempo hasta detección** | ~5 minutos (primer intento de conexión) |
| **Tiempo hasta solución** | ~1 hora (investigación + cambio de provider) |

**Síntoma:**
`535 5.7.8 Username and Password not accepted. Application-specific password required.`

**Causa raíz:**
Google eliminó el soporte para "Less secure apps" (aplicaciones que usan usuario/contraseña directamente sin OAuth2). Esto aplica a todas las cuentas Gmail, personales y de Google Workspace.

**Solución:**
Abandonar Gmail SMTP. La alternativa (OAuth2 + Google Cloud Console) se consideró excesivamente compleja.

**Lección:**
> **Los providers grandes de correo (Google, Microsoft) tienen capas de seguridad que hacen inviable SMTP básico con usuario/contraseña.** Para envío transaccional, usar servicios diseñados para ello (SendGrid, Mailgun, Brevo, SMTP de hosting) o implementar OAuth2 si es estrictamente necesario usar Gmail/Outlook.

---

### Error 4: Outlook SMTP — SMTP Auth deshabilitado

| Campo | Detalle |
|--------|---------|
| **Fase** | 2 — Envío de correos |
| **Commit** | `ef2b39b` |
| **Severidad** | 🟡 Media |
| **Tiempo hasta detección** | ~5 minutos |
| **Tiempo hasta solución** | ~1 hora |

**Síntoma:**
`535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox.`

**Causa raíz:**
Microsoft deshabilitó SMTP AUTH básico para cuentas nuevas de Outlook.com. Es una política a nivel de tenant que no se puede modificar para cuentas personales gratuitas.

**Solución:**
Abandonar Outlook SMTP.

**Lección:**
> Misma lección que con Gmail. **Los proveedores de correo de consumo (B2C) no están diseñados para SMTP transaccional.** Microsoft y Google han ido cerrando progresivamente el acceso SMTP básico en favor de OAuth2 y APIs modernas (Microsoft Graph, Gmail API). Para uso transaccional, recurrir a servicios especializados.

---

### Error 5: Brevo SMTP Relay — Correos nunca entregados

| Campo | Detalle |
|--------|---------|
| **Fase** | 2 — Envío de correos |
| **Commit** | No commiteado |
| **Severidad** | 🟡 Media (el error más sutil de esta fase) |
| **Tiempo hasta detección** | ~4 horas (aceptación vs. entregabilidad) |
| **Tiempo hasta solución** | ~3 horas (investigación + cambio a Hostinger) |

**Síntoma:**
El servidor SMTP de Brevo respondía `250 OK` (mensaje aceptado para entrega) en todas las operaciones. Cero errores visibles en logs. Pero **ningún correo llegaba** al destinatario — ni a la bandeja de entrada ni a la carpeta de spam. Silencio absoluto.

**Causas (múltiples, en cascada):**

1. **Reputación de relay compartido:** `smtp-relay.brevo.com` usa direcciones de remitente genéricas (`@smtp-brevo.com`) en el plan gratuito. Estas direcciones tienen baja reputación porque son compartidas por miles de remitentes, muchos de ellos legítimos pero otros potencialmente problemáticos.

2. **SPF/DKIM sin configurar:** Sin un dominio propio verificado con registros SPF y DKIM apuntando a Brevo, los servidores receptores no pueden verificar que Brevo está autorizado a enviar correos en nombre del dominio del remitente.

3. **Filtros anti-spam silenciosos:** Gmail, Outlook y otros providers simplemente descartan (silent drop) correos que no pasan verificaciones de autenticación, sin rebotarlos. Esto hace que el diagnóstico sea extremadamente difícil porque no hay mensaje de error.

**Solución:**
Migrar a Hostinger SMTP con dominio propio (`bugtracker.pro`).

**Lección:**
> **La entregabilidad es el verdadero desafío del email transaccional, no el envío.** Un correo "enviado con éxito" (respuesta 250 del servidor SMTP) no significa "entregado". Los relays SMTP gratuitos tienen mala reputación de dominio y los filtros anti-spam modernos descartan correos silenciosamente sin notificar al remitente. Para producción, es necesario:
> - Dominio propio con reputación limpia
> - SPF, DKIM y DMARC correctamente configurados
> - IP de envío dedicada (idealmente) o relay de confianza
> - Monitoreo de entregabilidad (no solo de envío)

---

### Error 6: ReferenceError silencioso en notificaciones

| Campo | Detalle |
|--------|---------|
| **Fase** | 3 — Notificaciones |
| **Commit** | `ff3aed6` |
| **Severidad** | 🔴 Alta (funcionalidad completamente rota sin error visible) |
| **Tiempo hasta detección** | ~1 hora (diagnóstico difícil por silencio del error) |
| **Tiempo hasta solución** | ~15 minutos |

**Síntoma:**
- Las notificaciones por correo simplemente no se enviaban
- Los logs del servidor mostraban peticiones llegando al endpoint
- El log de diagnóstico decía `"Cambios detectados: 0"` para todos los cambios
- **No había errores en consola ni stack traces** — el error era silencioso

**Causa raíz:**
Un `console.log` de diagnóstico referenciaba variables que aún no existían:
```javascript
console.log('Comparando:', Object.keys(oldBugs), '->', Object.keys(newBugs));
// ... código ...
if (bugId) {
    const oldBugs = ...;  // oldBugs no existe antes de esta línea
    const newBugs = ...;  // newBugs no existe antes de esta línea
}
```

Aunque oldBugs/newBugs se declaraban con `const` dentro del bloque `if`, el `console.log` que las referenciaba estaba **fuera y antes** del bloque. Esto producía un `ReferenceError` que mataba la función `sendNotificationEmail()` sin que nadie lo notara porque:
- Las notificaciones se envían de forma asíncrona (no bloquean la respuesta HTTP)
- El `try/catch` de la ruta principal no capturaba errores en callbacks asíncronos
- El error no se logueaba a ningún lado

**Solución:**
Mover el `console.log` de diagnóstico **dentro** del bloque `if`:
```javascript
if (bugId) {
    const oldBugs = ...;
    const newBugs = ...;
    console.log('Comparando:', Object.keys(oldBugs), '->', Object.keys(newBugs));
}
```

**Lección:**
> **No usar variables en logs de diagnóstico si no están garantizadas.** Poner los logs DENTRO del bloque donde se declaran las variables que referencian. Un `ReferenceError` en código asíncrono puede ser devorado silenciosamente sin stack trace, haciendo el diagnóstico extremadamente difícil. Como regla general: los logs de diagnóstico deben vivir en el mismo scope que las variables que inspeccionan.

---

### Error 7: `superUser` indefinido — El admin no recibía notificaciones

| Campo | Detalle |
|--------|---------|
| **Fase** | 3 — Notificaciones |
| **Commit** | `ff3aed6` |
| **Severidad** | 🟡 Media (el admin no se enteraba de cambios) |
| **Tiempo hasta detección** | ~30 minutos |
| **Tiempo hasta solución** | ~5 minutos |

**Síntoma:**
El administrador no recibía notificaciones de cambios en tareas **sin asignar** (donde `assignedTo` es `null`). Las notificaciones para tareas con asignado funcionaban correctamente.

**Causa raíz:**
`superUser` se declaraba dentro del bloque `if (changed.length > 0)`, pero se intentaba usar antes de ese bloque para añadir al admin a la lista de destinatarios:
```javascript
const recipients = new Set();
recipients.add(superUser.email);  // ❌ superUser no existe aquí

if (changed.length > 0) {
    const superUser = users.find(u => u.role === 'admin'); // Demasiado tarde
    // ...
}
```

**Solución:**
Mover la declaración de `superUser` al principio de la función:
```javascript
function sendNotificationEmail(...) {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const superUser = users.find(u => u.role === 'admin'); // ✅ Disponible siempre
    const recipients = new Set();
    recipients.add(superUser.email); // ✅ Funciona
    // ...
}
```

**Lección:**
> **Las variables de control de flujo deben declararse al principio de la función, no dentro de condicionales.** Si una variable se necesita en múltiples ramas de ejecución o antes de un condicional, su declaración debe estar en el scope más externo posible. Esto aplica especialmente a variables de "configuración" como el usuario admin, umbrales, o constantes derivadas de datos.

---

### Error 8: Formato de email con `\n` literales

| Campo | Detalle |
|--------|---------|
| **Fase** | 3 — Notificaciones |
| **Commit** | `ff3aed6` |
| **Severidad** | 🟢 Baja (email legible pero con formato roto) |
| **Tiempo hasta detección** | ~15 minutos (primer email de prueba) |
| **Tiempo hasta solución** | ~5 minutos |

**Síntoma:**
Los correos electrónicos llegaban con `\n` visibles (los caracteres literales backslash + n) en lugar de saltos de línea. Ejemplo:
```
Tarea actualizada\n\nTítulo: Arreglar login\nPrioridad: high → critical\n
```

**Causa raíz:**
Cuando JavaScript serializa/deserializa strings a través de JSON, los saltos de línea reales (carácter ASCII 0x0A) se representan como el escape `\n`. Si el texto pasa por `JSON.stringify` → `JSON.parse` (o se almacena en `store.json`), los `\n` reales se convierten en la secuencia de dos caracteres `\` y `n`. Al pasarlos directamente a `toHtml()` (que convierte saltos de línea reales a `<br>`), estos escapes no se interpretan.

**Solución:**
Añadir `.replace(/\\n/g, '\n')` antes de la conversión a HTML:
```javascript
const plainText = emailBody.replace(/\\n/g, '\n');
const htmlBody = plainText.replace(/\n/g, '<br>');
```

**Lección:**
> **Los datos que viajan por JSON pueden escapar los saltos de línea.** Normalizar siempre antes de transformar a HTML. La tubería de datos típica es: `dato original` → `JSON.stringify` (escapa \n) → `almacenamiento/transporte` → `JSON.parse` (mantiene \\n) → `.replace(/\\n/g, '\n')` → `transformación a HTML`. Asumir que un string tiene saltos de línea reales después de pasar por JSON es un error común.

---

### Error 9: Variable `users` usada antes de declararse

| Campo | Detalle |
|--------|---------|
| **Fase** | 3 — Notificaciones |
| **Commit** | `ff3aed6` |
| **Severidad** | 🟡 Media |
| **Tiempo hasta detección** | ~20 minutos |
| **Tiempo hasta solución** | ~5 minutos |

**Síntoma:**
Similar al Error 6: la función de notificaciones fallaba silenciosamente en ciertos flujos de ejecución. El patrón era idéntico al Error 7.

**Causa raíz:**
La variable `users` se leía de `USERS_FILE` dentro de un bloque `if` cuya condición no siempre era verdadera. Fuera de ese bloque, `users` era `undefined`.

**Solución:**
Mover `const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))` al inicio de la función, antes de cualquier condicional.

**Lección:**
> **Leer dependencias de datos al inicio de la función, no bajo condiciones.** Las operaciones de I/O que producen datos necesarios para la lógica de la función (como leer `users.json`) deben hacerse de forma incondicional al principio. Si hay preocupación de rendimiento, usar memoización o caché, pero nunca esconder la lectura dentro de un condicional.

---

### Error 10: CRÍTICO — `app.js` truncado a 1198 líneas

| Campo | Detalle |
|--------|---------|
| **Fase** | 4 — Edición de comentarios |
| **Commit** | No commiteado aún |
| **Severidad** | 🔴🔴 CRÍTICA (pérdida masiva de funcionalidad) |
| **Tiempo hasta detección** | ~5 minutos (el usuario reportó inmediatamente) |
| **Tiempo hasta solución** | ~45 minutos (restauración + parche quirúrgico) |

**Síntoma:**
- El usuario reportó que **no podía acceder a las tareas**
- El tablero principal se veía correctamente
- Al hacer clic en cualquier bug, no pasaba nada (no se abría la ventana de detalle)
- Los botones de crear bug y otras funcionalidades no respondían
- La consola del navegador mostraba `Uncaught ReferenceError: openBugModal is not defined`

**Causa raíz:**
Se borraron accidentalmente **397 líneas** de `app.js` (de ~1595 a 1198). Las funciones perdidas eran exactamente las que gestionaban toda la interacción del usuario:

| Función perdida | Impacto |
|----------------|---------|
| `openBugModal(bugId)` | No se podía ver detalle de ningún bug |
| `openBugModalWithContext(bugId, listId)` | No se podía abrir bug desde columna específica |
| `openResolveModal(bugId)` | No se podía resolver/cerrar bugs |
| `confirmAction(message, callback)` | No funcionaban confirmaciones (eliminar, etc.) |
| `escapeHtml(str)` | Posible vulnerabilidad XSS si otras funciones la usaban |
| `getAssignees()` | No se podía asignar bugs a usuarios |
| `openReportModal()` | No se podía abrir ventana de reportes |
| `generateReport()` | No se podía generar reportes CSV |

**Cómo ocurrió exactamente:**
El diff original para añadir edición de comentarios reemplazaba la función `renderComments`. Pero el método usado para aplicar el parche (presumiblemente `sed` o un heredoc con delimitadores) capturó un rango incorrecto de líneas, eliminando todo desde un marcador de inicio hasta el final de `renderComments`, incluyendo cientos de líneas de funciones no relacionadas.

**Solución (protocolo de emergencia):**

1. **Restauración inmediata:**
   ```bash
   git checkout -- app.js
   ```
   Esto recuperó la versión íntegra del repositorio.

2. **Verificación de integridad:**
   ```bash
   wc -l app.js  # Confirmar que no está vacío (ver Error 12)
   ```

3. **Parche quirúrgico con Python:**
   ```python
   # Script que:
   # 1. Lee app.js completo
   # 2. Busca función renderComments por firma
   # 3. Reemplaza solo el cuerpo de la función
   # 4. Verifica que openBugModal, escapeHtml, generateReport sigan presentes
   # 5. Aborta si falta alguna función crítica
   ```

**Lección (la más importante de todo el proyecto):**
> **NUNCA usar sed/heredocs para editar archivos remotos grandes.** La edición de archivos por rangos de líneas o delimitadores de texto es inherentemente frágil. Un solo error en el patrón puede destruir cientos de líneas. En su lugar:
> - **Usar scripts Python con verificación de integridad** (checker post-parche que confirme la presencia de funciones clave)
> - **Preferir `git apply` con patches generados por `git diff`** (formato unificado con contexto)
> - **Hacer backup explícito antes de parchear**: `cp app.js app.js.bak.$(date +%s)`
> - **Verificar `wc -l` y hashes** antes y después de cada modificación

---

### Error 11: `render()` destruye la ventana de detalle

| Campo | Detalle |
|--------|---------|
| **Fase** | 4 — Edición de comentarios |
| **Commit** | No commiteado aún |
| **Severidad** | 🟡 Media (UI rota pero datos intactos) |
| **Tiempo hasta detección** | ~30 minutos (comportamiento sutil, diferente para admin vs user) |
| **Tiempo hasta solución** | ~10 minutos |

**Síntoma:**
- **Usuario normal:** Al guardar un comentario editado, la ventana de detalle del bug **se cerraba** abruptamente. El comentario sí se guardaba en el servidor, pero el usuario no lo veía reflejado hasta reabrir manualmente el bug. La experiencia sugería que la acción había fallado.
- **Admin:** La ventana de detalle permanecía abierta (porque el admin veía el tablero completo en lugar de un modal), pero el cambio no se reflejaba en los comentarios mostrados. Solo al cerrar y reabrir manualmente se veía la edición.

**Causa raíz:**
`saveEditComment()` llamaba a `render()` después de recibir la respuesta del servidor. `render()` es una operación **destructiva a nivel de DOM** que:
1. Vacía completamente el contenedor principal del tablero
2. Reconstruye todas las columnas (To Do, In Progress, Done)
3. Re-aplica filtros activos
4. Re-renderiza cada tarjeta de bug

Esto inevitablemente **destruye cualquier modal o ventana de detalle** que estuviera abierta, porque esos elementos del DOM son eliminados cuando `render()` limpia el contenedor.

**Solución:**
Eliminar la llamada a `render()` de `saveEditComment()`. La función `renderComments(updatedBug)` ya es suficiente para:
- Actualizar el texto y metadatos del comentario inline
- Mostrar el indicador "(editado)" y timestamp de edición
- No tocar el resto de la UI

```javascript
// ❌ Antes:
async function saveEditComment(bugId, commentId) {
    const updatedBug = await response.json();
    render();              // 💣 Destruye todo
    renderComments(updatedBug);
}

// ✅ Después:
async function saveEditComment(bugId, commentId) {
    const updatedBug = await response.json();
    renderComments(updatedBug); // ✅ Solo actualiza comentarios
}
```

**Lección:**
> **`render()` es una operación destructiva que reconstruye toda la UI. No llamarla para cambios locales.** Para actualizaciones puntuales (un comentario, un cambio de estado, una etiqueta), usar funciones de actualización dirigidas que solo modifiquen los elementos del DOM relevantes. `render()` debe reservarse para cambios estructurales: nuevo bug, eliminación de bug, cambio de filtros globales, o recarga completa de datos.

---

### Error 12: `app.js` restaurado vacío desde Git

| Campo | Detalle |
|--------|---------|
| **Fase** | 5 — Corrupción |
| **Commit** | N/A (problema de repositorio) |
| **Severidad** | 🔴 Alta (fuente de verdad corrupta) |
| **Tiempo hasta detección** | ~2 minutos (`wc -l` post-checkout) |
| **Tiempo hasta solución** | ~10 minutos (checkout desde commit anterior) |

**Síntoma:**
Tras ejecutar `git checkout -- app.js` para restaurar el archivo (durante la recuperación del Error 10), el archivo resultante tenía **0 líneas**:
```bash
$ wc -l app.js
0 app.js
```

**Causa raíz:**
En algún momento previo, una transferencia de archivos (`scp`, `rsync`, o heredoc) había truncado `app.js` a 0 bytes. Este estado corrupto quedó registrado en el commit más reciente del repositorio. Al hacer checkout, Git restauró fielmente... la nada misma.

**Solución:**
1. Identificar el último commit donde el archivo estaba íntegro:
   ```bash
   git log --oneline -- app.js
   ```
2. Hacer checkout desde ese commit:
   ```bash
   git checkout <hash_del_commit_bueno> -- app.js
   ```
3. Verificar integridad:
   ```bash
   wc -l app.js  # Debe mostrar ~1595 líneas
   ```

**Lección:**
> **Verificar `wc -l` después de cada transferencia de archivos.** Preferir `git` como fuente de verdad, pero verificar que la fuente de verdad no esté corrupta. Un archivo vacío es un commit válido para Git — no hay advertencia. Como práctica defensiva:
> - Después de `scp`/`rsync`: verificar tamaño (`wc -l` o `wc -c`)
> - Después de editar remotamente: verificar que funciones clave sigan presentes
> - Antes de commit: `git diff --stat` para ver qué archivos cambiaron y cuánto
> - Considerar un hook pre-commit que rechace archivos vacíos que antes no lo estaban

---

### Error 17: `v.lists is not iterable` (split store)

| Campo | Detalle |
|--------|---------|
| **Fase** | 7 — Split Store Architecture |
| **Commit** | `377df52` |
| **Severidad** | 🔴 Alta (rompe 3 endpoints) |
| **Tiempo hasta detección** | ~10 minutos (pruebas manuales post-refactor) |
| **Tiempo hasta solución** | ~20 minutos |

**Síntoma:**
Tras dividir `store.json` en archivos `v_*.json`, varios endpoints devolvían `500 Internal Server Error` con el mensaje `TypeError: v.lists is not iterable`.

**Causa raíz:**
Los endpoints `POST /api/bugs/:bugId/followers`, `PUT /api/comments` y `POST /api/store` (notificaciones) iteraban directamente sobre `v.lists` asumiendo que el objeto `v` (versión) contenía el array completo. Tras el split, `v` solo tenía `id` y `name`; los datos reales (`lists`) estaban en el archivo `v_${v.id}.json`.

```javascript
// ❌ Código roto:
for (const v of store.versions) {
    for (const list of v.lists) {  // 💥 v.lists es undefined
        // ...
    }
}
```

**Solución:**
Llamar `readVersion(v.id)` antes de acceder a `lists`:
```javascript
// ✅ Código corregido:
for (const v of store.versions) {
    const ver = readVersion(v.id);
    for (const list of ver.lists) {  // ✅ ver.lists existe
        // ...
    }
}
```

**Lección:**
> **Al refactorizar el formato de almacenamiento, auditar TODOS los consumidores.** Un cambio en la capa de persistencia afecta a todos los endpoints que lean esos datos. Hacer `grep -n '\.lists'` sobre `server.js` antes de declarar terminado el refactor.

---

### Error 18: Login falla por token no guardado en localStorage

| Campo | Detalle |
|--------|---------|
| **Fase** | 7 — Login Fix |
| **Commit** | `a1f239e` |
| **Severidad** | 🔴 Alta (login roto para todos los usuarios) |
| **Tiempo hasta detección** | ~5 minutos (login exitoso pero 401 en siguiente request) |
| **Tiempo hasta solución** | ~2 minutos |

**Síntoma:**
El usuario hacía login, el servidor respondía `200 OK` con token, pero inmediatamente cualquier acción (ver bugs, crear tarea, comentar) fallaba con `401 Unauthorized`. Parecía que el login no persistía.

**Causa raíz:**
`Auth.saveSession()` guardaba el token con clave `token`:
```javascript
localStorage.setItem('token', token);
```

Pero `Auth.getToken()` (usado en cada `fetch`) leía con clave `bugtracker_token`:
```javascript
return localStorage.getItem('bugtracker_token');
```

Como las claves no coincidían, `getToken()` devolvía `null`, el header `Authorization: Bearer null` no se enviaba, y el servidor rechazaba la petición.

**Solución:**
Unificar la clave a `bugtracker_token`:
```javascript
localStorage.setItem('bugtracker_token', token);
```

**Lección:**
> **Las claves de localStorage deben ser constantes compartidas.** Definir `const TOKEN_KEY = 'bugtracker_token'` en un único lugar y usarla tanto en `saveSession` como en `getToken`. Un simple `grep` de `localStorage.setItem`/`getItem` habría detectado la inconsistencia al instante.

---

## 5. Configuración SMTP

### Configuración actual (Hostinger)

| Variable de entorno | Valor |
|---------------------|-------|
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` (SSL/TLS implícito) |
| `SMTP_USER` | `admin@bugtracker.pro` |
| `SMTP_PASS` | `[REDACTED]` |
| `SMTP_FROM` | `"Bug Tracker" <admin@bugtracker.pro>` |

### Historial de providers probados

| Provider | Host | Resultado | Motivo del fallo |
|----------|------|-----------|------------------|
| Resend API | `api.resend.com` | ❌ | Sandbox: solo emails verificados |
| Gmail SMTP | `smtp.gmail.com:587` | ❌ | Less secure apps bloqueado |
| Outlook SMTP | `smtp-mail.outlook.com:587` | ❌ | SMTP Auth deshabilitado |
| Brevo Relay | `smtp-relay.brevo.com:465` | ❌ | 0% entregabilidad (spam/dominio) |
| **Hostinger** | `smtp.hostinger.com:465` | ✅ | **Dominio propio, entregabilidad 100%** |

### Notas importantes sobre SMTP

1. **Nunca incluir credenciales reales en logs o documentación.** Las contraseñas SMTP deben ir exclusivamente en variables de entorno o un archivo `.env` excluido de Git.

2. **Puerto 465 vs 587:**
   - `465`: SSL/TLS implícito (conexión segura desde el primer byte)
   - `587`: STARTTLS (conexión en texto plano que se actualiza a TLS)
   - Hostinger requiere 465 con `secure: true`

3. **Entregabilidad:** El éxito técnico del envío (respuesta 250 del servidor SMTP) **no garantiza la entrega**. La entregabilidad depende de SPF, DKIM, DMARC, reputación de IP y dominio.

---

## 6. API Endpoints

### Autenticación

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `POST` | `/api/register` | No | Registrar nuevo usuario |
| `POST` | `/api/login` | No | Iniciar sesión, devuelve token |
| `GET` | `/api/me` | Bearer | Obtener perfil del usuario autenticado |

### Bugs

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/api/bugs` | Bearer | Listar todos los bugs |
| `POST` | `/api/bugs` | Bearer | Crear nuevo bug |
| `PUT` | `/api/bugs/:id` | Bearer | Actualizar bug existente |
| `DELETE` | `/api/bugs/:id` | Bearer (admin) | Eliminar bug |

### Comentarios

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `PUT` | `/api/comments` | Bearer | Editar comentario (autor o admin). Body: `{ bugId, commentId, text }` |

### Usuarios

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/api/users` | Bearer | Listar usuarios (para asignación) |
| `PATCH` | `/api/users/:id` | Bearer (propio) | Actualizar preferencias (notifications) |

### Sistema

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/api/health` | No | Health check del servidor |

### Formato de autenticación

```
Authorization: Bearer <token>
```

El token tiene formato: `userId|expiryTimestamp|hmacSignature` y expira en 24 horas.

---

## 7. Sistema de Notificaciones

### Arquitectura

```
Petición PUT /api/bugs/:id
         │
         ▼
   Guardar bug en store.json
         │
         ▼
   sendNotificationEmail(bugId, oldBug, updatedBug)
         │
         ├── 1. Comparar oldBug vs updatedBug
         │      (status, priority, assignedTo, title, comments)
         │
         ├── 2. Construir lista de destinatarios:
         │      • Creador del bug
         │      • Usuario asignado (si cambió)
         │      • Admin (siempre)
         │      • Respetar preferencia notifications=false
         │
         ├── 3. Construir email HTML
         │      (tabla de cambios, diseño responsive)
         │
         └── 4. Enviar vía Nodemailer + SMTP Hostinger
                (asíncrono, no bloquea respuesta HTTP)
```

### Reglas de notificación

- **Cambio de estado:** notifica a creador + asignado + admin
- **Cambio de prioridad:** notifica a creador + asignado + admin
- **Cambio de asignación:** notifica a creador + nuevo asignado + admin
- **Nuevo comentario:** notifica a creador + asignado (no al autor del comentario) + admin
- **Tarea sin asignar:** notifica a creador + admin
- **Usuario con `notifications: false`:** no recibe notificaciones (pero el admin sí)

### Preferencias de usuario

Cada usuario puede activar/desactivar notificaciones desde el panel de perfil (checkbox). El cambio se persiste inmediatamente vía `PATCH /api/users/:id`.

---

## 8. Sistema de Permisos

### Roles

| Rol | Descripción | Permisos especiales |
|-----|-------------|---------------------|
| `admin` | Administrador del sistema | Eliminar bugs, editar cualquier comentario, ver todos los bugs |
| `user` | Usuario estándar | Crear bugs, asignar bugs, comentar, editar solo sus comentarios |

### Reglas de autorización

| Acción | admin | user (autor) | user (otro) |
|--------|-------|--------------|-------------|
| Crear bug | ✅ | ✅ | ✅ |
| Editar bug | ✅ | ✅ (si asignado) | ❌ |
| Eliminar bug | ✅ | ❌ | ❌ |
| Editar comentario | ✅ | ✅ | ❌ |
| Cambiar preferencias | ✅ | ✅ (solo propias) | ❌ |

### Implementación

La autorización se implementa en cada endpoint verificando:
1. `authenticate(req, res)` → extrae y valida token → obtiene userId y role
2. Lógica específica del endpoint: compara `userId` del token con `createdBy`/`assignedTo`/`userId` del comentario

---

## 9. Estructura de Archivos del Proyecto

```
bug-tracker/
├── server.js              # Backend: servidor HTTP, API REST, notificaciones (736 líneas)
├── app.js                 # Frontend: SPA vanilla JS (~1900 líneas)
├── BugTracker.html        # Página principal (entry point)
├── styles.css             # Estilos con tema oscuro
├── data/
│   ├── store.json         # Datos de la aplicación (bugs, comentarios)
│   └── users.json         # Usuarios con hashes PBKDF2
├── node_modules/          # Solo Nodemailer (única dependencia externa)
├── package.json           # Configuración npm
├── package-lock.json      # Lock de dependencias
└── DOCUMENTACION.md       # Este archivo
```

### Métricas de código

| Archivo | Líneas | Responsabilidad |
|---------|--------|-----------------|
| `server.js` | 736 | Backend completo |
| `app.js` | ~1900 | Frontend completo |
| `styles.css` | ~500 | Estilos y tema oscuro |
| `BugTracker.html` | ~100 | Estructura HTML base |

---

## 10. Guía de Desarrollo: Cómo NO Repetir los Errores

### 🏗️ Antes de implementar una feature nueva

1. **Migraciones de datos:**
   - Si cambias el formato de almacenamiento, escribe un script de migración
   - Haz backup de `data/` antes de ejecutar la migración
   - Verifica integridad post-migración

2. **Servicios externos (APIs, SMTP):**
   - Lee los límites del plan gratuito antes de escribir código
   - Verifica que el servicio soporta tu caso de uso (multiusuario, volumen, etc.)
   - Prueba con un script mínimo antes de integrar

3. **Cambios en archivos grandes (>500 líneas):**
   - ❌ No usar `sed`, `awk` o heredocs para editar remotamente
   - ✅ Usar scripts Python con verificación de integridad post-parche
   - ✅ Hacer backup: `cp archivo.js archivo.js.bak.$(date +%s)`
   - ✅ Verificar `wc -l` antes y después

### 🐛 Durante el desarrollo

4. **Variables y scope:**
   - Declarar dependencias de datos al inicio de la función
   - No usar variables en logs fuera de su scope
   - Si una variable se necesita en múltiples ramas, declararla en el scope padre

5. **Logs de diagnóstico:**
   - Poner logs DENTRO del bloque donde las variables existen
   - No asumir que un `ReferenceError` será visible — en callbacks asíncronos puede ser devorado

6. **Normalización de datos:**
   - Después de `JSON.parse`, normalizar escapes (`\\n` → `\n`)
   - Antes de convertir a HTML, asegurarse de que los saltos de línea son reales

### 🚀 Antes de commit

7. **Verificación de integridad:**
   ```bash
   git diff --stat          # ¿Qué archivos cambiaron y cuánto?
   wc -l app.js server.js   # ¿Tamaños esperados?
   ```

8. **Funciones críticas:**
   - Verificar que `openBugModal`, `escapeHtml`, `generateReport` y otras funciones clave existen en `app.js`
   - Verificar que `sendNotificationEmail`, `authenticate`, `verifyToken` existen en `server.js`

### 🔄 Recuperación de desastres

9. **Si algo se rompe:**
   ```bash
   git status                    # Ver qué pasó
   git diff                      # Ver cambios exactos
   git checkout -- archivo.js    # Restaurar desde último commit bueno
   wc -l archivo.js              # Verificar que no está vacío
   ```

10. **Fuente de verdad:**
    - Git es la fuente de verdad, pero verificar que el repositorio no esté corrupto
    - Si `git checkout` produce archivo vacío, probar commit anterior

---

## 11. Glosario de Decisiones Técnicas

| Decisión | Justificación | Trade-off |
|----------|---------------|-----------|
| **Zero Dependencies** | Seguridad (sin supply chain attacks), simplicidad de despliegue | Más código propio que mantener |
| **Nodemailer como excepción** | Implementar SMTP desde cero es inviable y peligroso | Rompe la regla zero-dep pero es la dependencia más usada y auditada para email |
| **PBKDF2 sobre bcrypt** | `crypto.pbkdf2` es nativo de Node.js (no requiere C++ bindings como bcrypt) | Ligeramente menos resistente a GPU attacks que bcrypt/scrypt, pero suficiente con 210k iteraciones |
| **SHA-512 sobre SHA-256** | Mayor seguridad contra colisiones para hashing de contraseñas | Más lento (~2x) pero aceptable para operación de login |
| **JSON sobre SQLite** | Sin dependencias nativas, legible por humanos, fácil de hacer backup | Sin concurrencia real, no escala a muchos datos |
| **Vanilla JS sobre React/Vue** | Coherencia con zero-dependencies, sin build step | Más verboso, sin componentes reutilizables |
| **Tema oscuro por defecto** | Mejor para uso prolongado (herramienta de desarrollo) | Requiere diseño cuidadoso de contraste |
| **Tokens JWT-like propios sobre JWT estándar** | Sin dependencia `jsonwebtoken`, control total del formato | No interoperable con otros sistemas, menos auditado |
| **Hostinger SMTP** | Dominio propio con reputación limpia, SPF/DKIM incluido | Coste mensual de hosting (~$2-5/mes) |
| **Puerto 465 (SSL implícito)** | Más seguro que STARTTLS (sin posibilidad de downgrade attack) | Menos común que 587, algunos firewalls lo bloquean |

---



---


---

## 🆕 Fase 6: Rol Manager + Sistema de Followers (v5.0)

### Resumen
Se añadió un nuevo rol "manager" con notificaciones globales y un sistema de seguidores (followers) para que cualquier usuario pueda suscribirse a actualizaciones de tareas sin estar asignado a ellas.

### 6.1 Rol Manager

**Propósito:** Un nivel intermedio entre admin y usuario. El manager recibe notificaciones de **todos** los cambios en la aplicación, pero no tiene permisos administrativos (no puede borrar usuarios ni cambiar roles).

**Cambios en backend (`server.js`):**
- Endpoint `PATCH /api/users/:id/role` — solo admin. Body: `{ "role": "manager" }` o `{ "role": "user" }`. No permite cambiar el rol de un admin.
- Los managers reciben notificación de **cualquier cambio** (creación, edición, resolución, comentarios) — igual que el admin.
- El endpoint `PUT /api/comments` restringe la edición a autor y admin (los managers NO pueden editar comentarios ajenos).

**Cambios en frontend (`app.js`):**
- `Auth.isManager` — getter que comprueba `role === 'manager'`
- Panel de admin (`renderAdminPanel`): badge "MANAGER" naranja + botón ⭐/👤 para promover/quitar manager
- Event handler `toggle-role` con llamada al endpoint `PATCH /api/users/:id/role`

### 6.2 Sistema de Followers

**Propósito:** Cualquier usuario puede seguir una tarea para recibir notificaciones sin necesidad de estar asignado. Además, cualquier usuario puede añadir a otros como seguidores de una tarea.

**Cambios en backend (`server.js`):**
- Endpoint `POST /api/bugs/:bugId/followers` — añade/quita/togglea seguidores
  - Sin `action` especificada: toggle automático para el usuario autenticado
  - `action: "add"` + `username`: añade a otro usuario como seguidor
  - `action: "remove"` + `username`: quita a un seguidor
  - Validación: el username debe existir en users.json (búsqueda case-insensitive)
- Campo `followers` (array de strings) añadido a cada bug en store.json
- Los followers reciben notificación de **cualquier cambio** en la tarea que siguen

**Cambios en frontend (`app.js`):**
- Función `renderFollowersSection(bug)` — inyecta sección de seguidores debajo de `#comments-list`
- Interfaz completa con: contador, lista de seguidores con botón × para quitar, botón 🔔/🔕 toggle, input + botón "+ Añadir"
- Función global `removeFollower(username)` para el onclick de los botones ×

### 6.3 Notificaciones — Matriz completa (v5.0)

| Perfil | ¿Qué recibe? | Condición |
|--------|-------------|-----------|
| **Admin** | Absolutamente todo | Tiene email configurado |
| **Manager** | Cualquier cambio en la app | Tiene email configurado |
| **Seguidor** | Cambios en tareas que sigue | Tiene email configurado |
| **Asignado** | Cambios en sus tareas | Tiene email configurado |
| **Subscriptor** | Todo (como admin) | `notifications: true` + email |

### 6.4 Errores encontrados en Fase 6

| # | Error | Síntoma | Causa | Solución |
|---|-------|---------|-------|----------|
| 13 | Followers no visibles | La sección no aparecía en el detalle de tarea | `renderFollowersSection` buscaba `.bug-detail-content` (clase inexistente) | Cambiar a `document.getElementById('comments-list')` |
| 14 | "Usuario no existe" al añadir follower | Error al escribir "Kimi" cuando el username es "kimi" | Comparación case-sensitive en `u.username === targetUser` | Normalizar a lowercase: `u.username.toLowerCase() === targetUser.toLowerCase()` |
| 15 | Manager no recibía notificaciones | Solo llegaban emails de tareas nuevas/resueltas | La lógica filtraba por `c.type === 'new'` o `c.fields.includes('resuelto por')` | Cambiar a notificación incondicional: `managers.forEach(m => recipients.set(m.email, m))` |
| 16 | Manager sin email no recibe nada | Youpi (manager) nunca recibía emails | `email: ""` en users.json — el filtro `u.email && u.email.trim()` lo excluye | El usuario debe configurar su email en el perfil |

### 6.5 Lecciones aprendidas (Fase 6)

1. **Selectores DOM**: Verificar que los selectores usados en JS existen realmente en el HTML. No asumir clases que no se han definido.
2. **Case-sensitivity**: Los usernames deben compararse de forma case-insensitive. Los usuarios escriben con mayúsculas/minúsculas inconsistentes.
3. **Requisitos ambiguos**: "Cualquier novedad" significa TODOS los cambios, no solo creaciones y resoluciones. Clarificar con el usuario ante duda.
4. **Email obligatorio**: Un rol sin email configurado es inútil para notificaciones. Considerar forzar email al promover a manager.

---

## Fase 7: Split Store Architecture + Login Fix

> **Rama:** `feat/scalability`  
> **Commits:** `377df52` (split-store), `a1f239e` (auth token)  
> **Fecha:** Mayo 2026

### 7.1 Split Store Architecture

**Problema:** `data/store.json` crecía indefinidamente. Al añadir versiones, listas y bugs, el archivo se volvía un cuello de botella para lectura/escritura y corrupción.

**Solución:** Dividir `store.json` en archivos individuales por versión.

| Antes | Después |
|-------|---------|
| `data/store.json` (único, todo el árbol) | `data/v_*.json` (un archivo por versión) |

**Nomenclatura:** Cada versión se guarda como `data/v_<versionId>.json`. El contenido es el objeto versión completo (con `id`, `name`, `lists`, etc.).

**Cambios en backend (`server.js`):**
- `GET /api/store` lee todos los archivos `data/v_*.json`, los parsea y los reensambla en un objeto con `versions: [...]`.
- Función auxiliar `readVersion(versionId)` lee `data/v_${versionId}.json` y devuelve el objeto versión.
- `POST /api/store` (guardar) itera sobre las versiones recibidas y escribe cada una a su archivo individual.

**Cambios en estructura de datos:**
```
data/
├── v_a1b2c3d4.json   # Versión "v1.0"
├── v_e5f6g7h8.json   # Versión "v2.0"
└── users.json
```

---

### 7.2 readVersion() Pattern

**Regla de oro:** Todo endpoint que acceda a `store.json` (ahora a los archivos `v_*.json`) debe llamar `readVersion(v.id)` antes de iterar `v.lists`.

**¿Por qué?** Después del split, el objeto `v` que viene de un array puede tener solo metadatos (`id`, `name`) sin el array `lists`. Si se itera `v.lists` directamente, se produce `TypeError: v.lists is not iterable`.

**Endpoints arreglados (3 endpoints con `v.lists is not iterable`):**

| Endpoint | Bug | Fix |
|----------|-----|-----|
| `POST /api/bugs/:bugId/followers` | Iteraba `v.lists` sin cargar la versión | `const ver = readVersion(v.id);` antes del loop |
| `PUT /api/comments` | Iteraba `v.lists` sin cargar la versión | `const ver = readVersion(v.id);` antes del loop |
| `POST /api/store` (notificaciones) | `oldStore` comparaba versiones sin `readVersion()` | `const oldVer = readVersion(v.id);` antes de comparar `lists` |

**Patrón correcto:**
```javascript
// ❌ ANTES (rompe con split store)
for (const v of store.versions) {
    for (const list of v.lists) {  // 💥 v.lists is undefined
        // ...
    }
}

// ✅ DESPUÉS (split-store safe)
for (const v of store.versions) {
    const ver = readVersion(v.id);  // Carga el archivo v_<id>.json
    for (const list of ver.lists) { // ✅ ver.lists existe
        // ...
    }
}
```

---

### 7.3 Login Fix — Auth.saveSession()

**Síntoma:** El login funcionaba (el servidor devolvía token), pero las peticiones autenticadas posteriores fallaban con `401 Unauthorized`. El usuario no podía ver bugs, comentar, ni usar ninguna función protegida.

**Causa raíz:** `Auth.saveSession()` guardaba el token en `localStorage` con la clave `token`, pero `Auth.getToken()` (usado en cada `fetch`) leía de `localStorage.getItem('bugtracker_token')`. La clave no coincidía, por lo que el cliente nunca enviaba el header `Authorization: Bearer <token>`.

**Fix:** Unificar la clave a `bugtracker_token`:
```javascript
// Auth.saveSession()
localStorage.setItem('bugtracker_token', token);  // ✅ Antes era 'token'

// Auth.getToken()
return localStorage.getItem('bugtracker_token');  // ✅ Ya leía 'bugtracker_token'
```

**Impacto:** Este bug afectaba especialmente al hash SHA-256 porque el flujo de login era más estricto (verificación de token en cada request). Sin el token en localStorage, toda la sesión quedaba rota silenciosamente.

---

### 7.4 Lecciones aprendidas (Fase 7)

1. **Cambio de formato de datos = cambio en TODOS los consumidores.** Al dividir `store.json`, no basta con cambiar `GET /api/store`. Cada endpoint que lea versiones debe adaptarse.
2. **Defensivo: asumir que los objetos pueden estar incompletos.** Si un objeto viene de un índice/array, no asumir que tiene todas sus propiedades. Cargar la fuente de verdad antes de iterar.
3. **Consistencia de claves en localStorage.** Usar siempre la misma clave para guardar y leer. Un `grep` de `localStorage.setItem` y `localStorage.getItem` detecta esto al instante.

---

## Fase 8: Select Dropdown para Followers — Mobile-Friendly (v5.1)

> **Rama:** main  
> **Commits:** 68aa24d (datalist → select), 1121d3e (fix: event listener mismatch)  
> **Fecha:** Mayo 2026

### 8.1 Problema Móvil con datalist

**Problema:** El sistema de followers en Fase 6 usaba un input + datalist (`<input list="followers-datalist">`) para sugerir usuarios al añadir followers. Este elemento **no se renderiza en Chrome para Android/iOS** — el datalist es invisible en móviles, por lo que el usuario no podía seleccionar ningún usuario.

**Impacto:** En móvil, el campo de añadir follower era un input vacío sin opciones visibles. Imposible añadir followers desde el teléfono.

### 8.2 Solución: Select Nativo

**Cambio:** Reemplazar input + datalist por un select con options generadas dinámicamente para cada usuario registrado.

**Ventajas del select nativo:**
- Funciona en **todos** los navegadores móviles (Android Chrome, Safari iOS)
- Abre el selector nativo del sistema (scroll wheel en iOS, picker en Android)
- Accesible por defecto — no requiere librerías JS
- Compatible con touch events sin configuración extra

**Archivos afectados:**
- `app.js` — función `renderFollowersSection()`: se reemplazó el `<input list="followers-datalist">` por un `<select id="add-follower-select">` con `<option>` generadas dinámicamente desde la lista de usuarios
- `server.js` — sin cambios en la lógica del endpoint (solo cambia el ID del elemento en el frontend)

### 8.3 Bug: Event Listener Mismatch

**Síntoma:** Tras cambiar el input por un select, el botón "+ Añadir" dejó de funcionar. No añadía ningún follower al hacer click.

**Causa raíz:** El event listener del botón buscaba el valor de un input con ID `add-follower-input`:

```javascript
document.getElementById('add-follower-btn').addEventListener('click', () => {
    const selector = document.querySelector('#add-follower-input');
    const username = selector.value;  // ❌ selector es null tras el cambio a <select>
    // ...
});
```

Pero el nuevo elemento era `<select id="add-follower-select">`. El `querySelector` retornaba `null`, y `.value` en `null` causaba un error.

**Solución:** Actualizar el event listener al nuevo ID:

```javascript
document.getElementById('add-follower-btn').addEventListener('click', () => {
    const selector = document.querySelector('#add-follower-select');
    const username = selector.value;  // ✅ ahora apunta correctamente
    // ...
});
```

**Lección:** Al cambiar el tipo de elemento (input → select), verificar TODOS los event listeners que referencien ese elemento. Un simple grep previene este error.

### 8.4 Lecciones aprendidas (Fase 8)

1. **Datalist no es mobile-friendly.** Nunca usar input con datalist como selector principal de opciones. Funciona en desktop pero es invisible en Chrome Android/iOS. Para selección móvil, usar select nativo.
2. **Cambiar tipo de elemento = cambiar TODAS las referencias.** Al reemplazar un input por un select, no basta con cambiar el DOM — hay que buscar todas las referencias al ID/selector antiguo. Un grep previene este error.
3. **Probar en móvil después de cambios en formularios.** Cualquier cambio en inputs, selects, o formularios debe verificarse en Chrome DevTools (Device Mode) como mínimo, y preferiblemente en un dispositivo real.

---

## 📎 Apéndice: Documentación Original del Proyecto Base

_Las siguientes secciones provienen de la documentación original del proyecto y cubren funcionalidades base que no han cambiado._

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

## 📝 Notas Finales

Este documento es un registro vivo de la evolución del proyecto Bug Tracker. Cada error encontrado y cada lección aprendida se documenta aquí para que el equipo (y el yo del futuro) no tropiecen dos veces con la misma piedra.

**Principio rector del proyecto:**
> *"El software no es solo código funcionando — es el conocimiento acumulado de por qué funciona de esa manera y no de otra."*

---

*Documento mantenido por el equipo de desarrollo de Bug Tracker. Última actualización: 17 de mayo de 2026.*
