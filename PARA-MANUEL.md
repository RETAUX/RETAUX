# Instrucciones para Manuel — Configuración inicial

## 1. Generar tu llave SSH para el servidor

En tu Mac, ejecutá este comando en la terminal:

```bash
ssh-keygen -t ed25519 -C "manuel-retaux-prod" -f ~/.ssh/retaux_prod -N ""
```

Esto crea dos archivos:
- `~/.ssh/retaux_prod` — tu llave **privada** (nunca la compartas)
- `~/.ssh/retaux_prod.pub` — tu llave **pública** (esta sí hay que enviar)

## 2. Enviarme la llave pública

Ejecutá esto para ver el contenido de la llave pública:

```bash
cat ~/.ssh/retaux_prod.pub
```

Copiá **todo** el texto que aparece (empieza con `ssh-ed25519 AAAA...`) y mandámelo por WhatsApp o email.
Yo la instalo en el servidor. **NUNCA me mandes el archivo `retaux_prod` sin el `.pub`.**

## 3. Clonar el repositorio

Una vez que te agregue al repo en GitHub:

```bash
git clone git@github.com:bquagliarella/retaux-web.git RetauX
cd RetauX
```

## 4. Configurar el entorno local

```bash
npm install
cp .env.example .env
```

Editá `.env` y completá los valores de desarrollo. Para pruebas locales podés usar:
- `PORT=3001`
- `BASE_URL=http://localhost:3001`
- `JWT_SECRET` — cualquier string largo (solo para dev)
- Las claves de Stripe, Brevo, etc. te las paso por separado de forma segura

## 5. Correr el servidor localmente

```bash
node server.js
# Abre http://localhost:3001
```

## 6. Reglas importantes antes de hacer deploy

- **Siempre avisarme antes de hacer deploy** — solo una persona deploya a la vez
- **Nunca hacer deploy sin subir los cambios a GitHub primero**
- El deploy se hace con `./deploy.sh` desde la raíz del proyecto
- Necesitás tener `~/.ssh/retaux_prod` en tu Mac (la que generaste en el paso 1)

## 7. Usuario de prueba

Para testing siempre usá: `claude-test@retaux.com`
Nunca crees ni borres otros usuarios de prueba.

---

Cualquier duda, consultarme antes de tocar datos de clientes o hacer deploy a producción.
