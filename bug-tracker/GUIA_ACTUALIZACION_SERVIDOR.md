# 🚀 Guía de Actualización del Servidor (Bug Tracker)

Esta guía contiene los comandos exactos que necesitas ejecutar desde tu **PowerShell en Windows** para enviar tus cambios locales al servidor remoto (Tailscale) y que se reflejen en los dispositivos móviles.

---

## Paso 1: Subir los archivos al servidor

Elige la opción que mejor se adapte a lo que modificaste:

### Opción A: Subir archivos específicos (Más rápido)
Si solo cambiaste el diseño o la estructura, envía solo esos archivos:

```powershell
scp "C:\Users\Usuario\TAREAS 5 26\bug-tracker\styles.css" "C:\Users\Usuario\TAREAS 5 26\bug-tracker\BugTracker.html" wilson@100.124.137.123:~/bug-tracker/
```

### Opción B: Subir todo el código fuente
Si hiciste muchos cambios y no quieres ir uno por uno, sube todos los archivos principales. 
*(Nota: No copiamos la carpeta `data/` entera con `-r` para no borrar los bugs y usuarios que ya se crearon en el móvil)*.

```powershell
scp "C:\Users\Usuario\TAREAS 5 26\bug-tracker\BugTracker.html" "C:\Users\Usuario\TAREAS 5 26\bug-tracker\styles.css" "C:\Users\Usuario\TAREAS 5 26\bug-tracker\app.js" "C:\Users\Usuario\TAREAS 5 26\bug-tracker\server.js" wilson@100.124.137.123:~/bug-tracker/
```

---

## Paso 2: Reiniciar el servidor remoto

Una vez que los archivos se hayan terminado de copiar, debes decirle a `PM2` (el programa que mantiene el servidor vivo) que cargue los nuevos cambios. Ejecuta:

```powershell
ssh wilson@100.124.137.123 "~/.npm-global/bin/pm2 restart bug-tracker"
```

Deberías ver una tabla verde indicando que el estado es `online`.

---

## 💡 Consejos Importantes

1. **El truco de la caché:**
   Los navegadores de los teléfonos móviles guardan los archivos agresivamente para ahorrar datos. Si modificas `styles.css` o `app.js`, ve al archivo `BugTracker.html` (alrededor de la línea 11) y cámbiale el número de versión (ej. de `?v=1.4` a `?v=1.5`). Sube los archivos, y los móviles descargarán la nueva versión inmediatamente sin necesidad de borrar el historial.

2. **Autenticación SSH de Tailscale:**
   Si llevas tiempo sin enviar comandos, Tailscale puede bloquear la conexión por seguridad y pedirte que confirmes tu identidad. Si el comando se queda pausado y te muestra un enlace (ej. `https://login.tailscale.com/a/...`), simplemente cópialo, ábrelo en tu navegador y autoriza la conexión. El comando continuará automáticamente.
