# Guía de puesta en producción — 15 días

Esta guía asume que no tenés todavía dominio ni hosting. El objetivo es tener
RETAUX funcionando en internet, con HTTPS, para que los clientes puedan
registrarse y empezar a cargar información.

## Resumen del plan (orden recomendado)

| Día | Tarea |
|-----|-------|
| 1-2 | Buscar agente TPB registrado para asociarte (ver sección final) |
| 1-2 | Comprar dominio |
| 2-3 | Crear servidor (VPS) y dejarlo accesible por SSH |
| 3-4 | Subir el código, instalar dependencias, configurar `.env` |
| 4-5 | Apuntar el dominio al servidor (DNS) |
| 5-6 | Configurar HTTPS (Certbot) y Nginx |
| 6-7 | Pruebas completas: registro, documentos, vinculación, admin |
| 7+  | Backups automáticos + monitoreo |
| resto | Contenido legal (T&C, privacidad), ajustes de diseño/copy |

---

## 1. Comprar el dominio

- Registrá `retaux.com.au` (o la variante disponible) en Namecheap, GoDaddy o similar.
- Esto es algo que tenés que hacer vos mismo/a (pago con tu tarjeta) — yo no puedo
  comprarlo por vos.

## 2. Elegir y crear el servidor (VPS)

Recomendación simple para este stack (Node + archivos JSON + uploads en disco):
un **VPS** (no un hosting "serverless"), porque necesitamos que `db/db.json` y la
carpeta `uploads/` persistan en disco.

Opciones razonables (todas ~USD 5-12/mes, elegí región **Sydney** para baja latencia
con Australia):
- DigitalOcean (Droplet, Ubuntu 22.04, 1GB RAM)
- Linode / Akamai Cloud Computing
- Vultr

Pasos generales:
1. Creá la cuenta y un Droplet/VPS con Ubuntu 22.04, región Sydney.
2. Anotá la IP pública del servidor.
3. Conectate por SSH: `ssh root@TU_IP`.

## 3. Preparar el servidor

```bash
# Actualizar sistema
apt update && apt upgrade -y

# Instalar Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git

# Instalar PM2 (mantiene el proceso vivo y lo reinicia si se cae)
npm install -g pm2

# Instalar Nginx y Certbot (para HTTPS)
apt install -y nginx certbot python3-certbot-nginx
```

## 4. Subir el código

Desde tu computadora (con el .tar.gz que te di):

```bash
scp retax-prototype.tar.gz root@TU_IP:/root/
ssh root@TU_IP
tar -xzf retax-prototype.tar.gz
cd retax
npm install
cp .env.example .env
nano .env   # completá JWT_SECRET y ADMIN_PASSWORD con valores largos y aleatorios
```

Para generar secretos aleatorios fuertes:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Levantar la app con PM2

```bash
cd /root/retax
pm2 start server.js --name retax
pm2 save
pm2 startup   # seguí las instrucciones que imprime para que arranque solo al reiniciar
```

## 6. Apuntar el dominio (DNS)

En el panel de tu proveedor de dominio, creá:
- Un registro **A** para `retaux.com.au` → IP de tu VPS
- Un registro **A** para `www.retaux.com.au` → IP de tu VPS

Los cambios de DNS pueden tardar hasta unas horas en propagarse.

## 7. Configurar Nginx como proxy + HTTPS

Crear `/etc/nginx/sites-available/retax`:

```nginx
server {
    listen 80;
    server_name retaux.com.au www.retaux.com.au;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20M;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/retax /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx

# HTTPS gratis con Let's Encrypt
certbot --nginx -d retaux.com.au -d www.retaux.com.au
```

`client_max_body_size 20M` es importante: si no lo agregás, las subidas de
documentos de más de 1MB van a fallar.

## 8. Backups (crítico — la base de datos es un archivo)

Como `db/db.json` y `uploads/` son lo único que guarda toda la información de
tus clientes (incluyendo datos bancarios), necesitás backups automáticos desde
el día 1. Ejemplo simple con cron, copiando a otro servicio (podés adaptarlo a
donde prefieras guardar los backups):

```bash
crontab -e
# Agregar línea: backup diario a las 3am
0 3 * * * tar -czf /root/backups/retax-$(date +\%F).tar.gz /root/retax/db /root/retax/uploads
```

Y descargá esos backups regularmente a un lugar fuera del servidor (tu compu,
Google Drive, etc.).

## 9. Probar todo en producción

- Crear una cuenta de prueba real, completar perfil, subir un documento, generar
  el flujo de vinculación.
- Entrar a `https://retaux.com.au/admin/login` con tu `ADMIN_PASSWORD` y verificar
  que ves al usuario de prueba.
- Borrar la cuenta de prueba (editando `db/db.json`) antes de lanzar a clientes reales.

---

## Sobre encontrar un agente TPB registrado para asociarte

Esto es tan importante como el deploy, porque sin esto no podés operar legalmente.

1. Usá el **TPB Register** (buscador público en tpb.gov.au) para encontrar agentes
   tributarios registrados — podés filtrar por ubicación.
2. Buscá especialmente estudios/contadores que ya atiendan a backpackers/working
   holiday makers (suelen estar familiarizados con el caso de uso).
3. Propuesta concreta: vos aportás la plataforma + captación de clientes +
   organización de documentos; ellos (como agentes registrados) reciben los
   códigos de vinculación, revisan y presentan las declaraciones, y se quedan
   con un % o un monto fijo por declaración procesada.
4. Pedile que confirme por escrito (mail) que actuás como su contratista/referente
   para este servicio — eso te cubre frente a cualquier duda sobre quién es
   responsable de las presentaciones.

Si en estos días no conseguís a nadie, avisame y vemos una alternativa (por ejemplo,
lanzar primero solo la etapa de "recolección de documentos" sin presentar
declaraciones, mientras seguís buscando).
