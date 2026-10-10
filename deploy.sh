#!/bin/bash
# deploy.sh — Script seguro de deploy para RETAUX
# Hace backup de la DB + verifica uploads antes de subir cualquier archivo
set -e

SERVER="deploy@170.64.132.127"
SSH_KEY="${HOME}/.ssh/retaux_prod"
LOCAL="/Users/bquagliarella/RetauX/"
REMOTE="/home/deploy/RetauX/"
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=no -o PasswordAuthentication=no -o BatchMode=yes"

# Verificar que la llave SSH existe antes de arrancar
if [ ! -f "$SSH_KEY" ]; then
  echo "❌ Llave SSH no encontrada en $SSH_KEY"
  echo "   Generá la llave con: ssh-keygen -t ed25519 -f ~/.ssh/retaux_prod -N \"\""
  exit 1
fi

echo "▶ [1/5] Verificando estado de uploads en el servidor..."
UPLOADS_COUNT=$(ssh $SSH_OPTS "$SERVER" "find /home/deploy/RetauX/uploads -type f 2>/dev/null | wc -l | tr -d ' '")
echo "   Archivos en uploads/: $UPLOADS_COUNT"

echo "▶ [2/5] Haciendo backup de la DB y uploads en el servidor..."
ssh $SSH_OPTS "$SERVER" "
  DATE=\$(date +%Y-%m-%d-%H%M)
  ARCHIVE=\"/tmp/retaux-predeploybackup-\$DATE.tar.gz\"
  tar -czf \"\$ARCHIVE\" -C /home/deploy/RetauX uploads db/db.json 2>/dev/null || tar -czf \"\$ARCHIVE\" -C /home/deploy/RetauX db/db.json
  rclone copy \"\$ARCHIVE\" gdrive:RETAUX-backups/ --quiet
  rm -f \"\$ARCHIVE\"
  echo \"   Backup pre-deploy OK: \$DATE\"
"

echo "▶ [3/5] Subiendo archivos al servidor (sin tocar DB ni uploads)..."
rsync -az -e "ssh $SSH_OPTS" \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='uploads' \
  --exclude='db/db.json' \
  --exclude='db/*.json' \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='TaxResidencyDeclarations' \
  --exclude='EngagementLetters' \
  --exclude='emails-dev.log' \
  --exclude='files.zip' \
  --exclude='admin.js' \
  --exclude='upload_drive*.js' \
  --exclude='dedup_drive.js' \
  "$LOCAL" "$SERVER:$REMOTE"

echo "▶ [4/5] Instalando dependencias y reiniciando servidor..."
ssh $SSH_OPTS "$SERVER" "
  cd /home/deploy/RetauX
  npm install --production --silent
  pip3 install --quiet openpyxl pypdf reportlab 2>&1 | grep -E 'Successfully|already|ERROR' || true
  pm2 restart retaux --update-env
"

echo "▶ [5/5] Verificando..."
sleep 2
STATUS=$(ssh $SSH_OPTS "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/login")
UPLOADS_AFTER=$(ssh $SSH_OPTS "$SERVER" "find /home/deploy/RetauX/uploads -type f 2>/dev/null | wc -l | tr -d ' '")

if [ "$STATUS" = "200" ]; then
  echo "✅ Deploy exitoso — www.retaux.com online (HTTP $STATUS)"
  echo "   Archivos en uploads/ antes: $UPLOADS_COUNT | después: $UPLOADS_AFTER"
  if [ "$UPLOADS_AFTER" -lt "$UPLOADS_COUNT" ]; then
    echo "⚠️  ADVERTENCIA: uploads/ bajó de $UPLOADS_COUNT a $UPLOADS_AFTER archivos — revisá el servidor"
  fi
else
  echo "❌ Error — servidor respondió HTTP $STATUS"
  exit 1
fi

# ── Verificar que el proceso correcto está sirviendo el sitio ─────────────────
echo "▶ [6/6] Verificando proceso activo via /health..."
HEALTH=$(ssh $SSH_OPTS "$SERVER" "curl -s http://localhost:3001/health 2>/dev/null")
HEALTH_CWD=$(echo "$HEALTH" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)
HEALTH_PORT=$(echo "$HEALTH" | grep -o '"port":[0-9]*' | cut -d':' -f2)
HEALTH_USERS=$(echo "$HEALTH" | grep -o '"users":[0-9]*' | cut -d':' -f2)
HEALTH_PID=$(echo "$HEALTH" | grep -o '"pid":[0-9]*' | cut -d':' -f2)

if [ "$HEALTH_CWD" = "/home/deploy/RetauX" ]; then
  echo "✅ Proceso correcto sirviendo — PID $HEALTH_PID | Puerto $HEALTH_PORT | Usuarios en DB: $HEALTH_USERS"
else
  echo "❌ ALERTA: El sitio NO está siendo servido por /home/deploy/RetauX"
  echo "   /health respondió: $HEALTH"
  echo "   Revisá si hay otro proceso node ocupando el puerto."
  exit 1
fi

# Sincronizar contexto de programación a Google Drive
echo "▶ [+] Sincronizando CLAUDE_PROGRAMACION.md a Google Drive..."
ssh $SSH_OPTS "$SERVER" \
  "rclone copyto /home/deploy/RetauX/CLAUDE.md 'gdrive:claude programacion/CLAUDE.md' --quiet && \
   echo '   ✅ CLAUDE.md sincronizado a Drive'" || \
  echo "   ⚠️  No se pudo sincronizar a Drive (no crítico)"
