# RETAUX — Guía de desarrollo y operaciones

## Stack tecnológico

- **Backend**: Node.js + Express + EJS (server-side rendering)
- **Base de datos**: lowdb v0 (JSON flat-file) en `db/db.json`
- **Proceso**: PM2 en servidor DigitalOcean (170.64.132.127), puerto 3001
- **Proxy**: nginx → puerto 3001
- **Emails**: Brevo (SMTP transaccional)
- **AI**: Anthropic Claude API
- **Pagos**: Stripe (⚠️ claves en modo sk_test_ — ver abajo)
- **i18n**: archivos JSON en `locales/` (ES / EN / FR / IT)

## Reglas de trabajo

### Git y deploys
- **Nunca hacer deploy sin antes subir los cambios a GitHub**
- **Solo una persona hace deploy a la vez — avisar al otro antes de publicar**
- Los cambios van al repo → deploy via `./deploy.sh`

### Stripe
- ⚠️ Las claves actuales son `sk_test_` (modo prueba — no procesa pagos reales)
- **Antes de ir a producción**: generar claves `sk_live_` nuevas en dashboard.stripe.com y rotarlas en el `.env` del servidor

### Datos de usuarios
- **NUNCA eliminar documentos, campos ni registros que los usuarios ya cargaron**
- La DB (`db/db.json`) vive solo en el servidor, nunca en el repo

### Usuario de prueba
- Siempre usar `claude-test@retaux.com` para testing — nunca crear ni borrar otros usuarios de prueba

### Cambios de texto / i18n
- Todo cambio de texto visible requiere actualizar los 4 idiomas: ES / EN / FR / IT
- Verificar que no haya ubicaciones duplicadas donde se renderiza el mismo string

### Seguridad
- Nunca mostrar en pantalla valores de claves o contraseñas — solo sus nombres
- Las claves viven en `.env` (no versionado); ver `.env.example` para la estructura

## Llave SSH de deploy

- Ubicación en Mac de Bruno: `~/.ssh/retaux_prod`
- Ubicación en Mac de Manuel: `~/.ssh/retaux_prod` (él la genera en su máquina)
- El servidor tiene ambas llaves públicas en `~/.ssh/authorized_keys`
- El deploy usa `BatchMode=yes` — si la llave no existe, el script falla con mensaje claro

## Procedimiento de deploy

```bash
./deploy.sh
```

El script hace automáticamente:
1. Verifica que la llave SSH existe
2. Cuenta archivos en `uploads/` antes del deploy
3. Backup pre-deploy de DB + uploads → Google Drive
4. rsync al servidor (excluye `.env`, `db/`, `uploads/`, `node_modules/`, etc.)
5. `npm install --production` + reinicio PM2
6. Verifica HTTP 200 en `/login`
7. Verifica proceso correcto via `/health` (previene el riesgo de proceso raíz en puerto 3000)
8. Sincroniza este `CLAUDE.md` a Google Drive

### Archivos que NO se deploya (excluidos del rsync)
- `.env` — claves del servidor, nunca se pisan
- `db/` — datos reales de clientes
- `uploads/` — archivos subidos por clientes
- `TaxResidencyDeclarations/` — declaraciones fiscales
- `EngagementLetters/` — contratos firmados
- `node_modules/`

## Preview local

```bash
npm install
cp .env.example .env   # completar con valores de desarrollo
node server.js
# Abre http://localhost:3001
```

## Rotación de claves

Rotar DE A UNA. Para cada clave:
1. Generar nueva clave
2. Actualizar en `.env` del servidor
3. Reiniciar PM2: `pm2 restart retaux --update-env`
4. Verificar que la función correspondiente siga operativa
5. Recién entonces marcar la vieja como inactiva/eliminada

## Backups

- **Automático pre-deploy**: `deploy.sh` hace backup a `gdrive:RETAUX-backups/` antes de cada deploy
- **Backup manual cifrado**: `~/Desktop/RETAUX-backups-cifrado.dmg` (AES-256, 1 GB)
- **Google Drive**: `gdrive:RETAUX-backups/` via rclone (configurado en el servidor)

## Riesgo: proceso duplicado en puerto 3000

Hay un proceso Node.js corriendo como root en `/root/RetauX` que ocupa el puerto 3000.
PM2 corre en `/home/deploy/RetauX` → puerto 3001. nginx apunta a 3001.
El script `deploy.sh` verifica esto via `/health` antes de dar el deploy por exitoso.
**Si `/health` reporta `cwd` distinto a `/home/deploy/RetauX`, el deploy falla con alerta.**
