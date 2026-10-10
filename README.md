# RETAUX — Prototipo

Prototipo funcional de plataforma para recolección de datos personales y documentación
de tax return en Australia, orientada a titulares de visas temporales (Working Holiday,
Student, etc.).

## Qué incluye

- **Cuentas de usuario**: registro con e-mail + clave numérica de 8 dígitos. Al registrarse,
  el usuario queda en una pantalla obligatoria de **verificación por código de 6 dígitos**
  (enviado por e-mail, válido 30 min, con botón de reenvío). El enlace del e-mail también
  confirma automáticamente la cuenta. **No se puede acceder a ninguna parte de la plataforma
  (perfil, documentos, vinculación, referidos) hasta confirmar el e-mail.**
  Login con rate-limit (10 intentos / 15 min) para mitigar fuerza bruta sobre la clave de 8 dígitos.
- **Datos personales** (`/profile`): contacto, visado, dirección, datos bancarios para el reembolso.
- **Por año fiscal** (`/tax-year/:año`): trabajos y ubicaciones, datos del vehículo, seguro
  de salud privado, y carga de documentos por categoría (payslips, ABN, certificaciones,
  cursos, gastos laborales, tecnología, inversiones, donaciones).
- **Vinculación con el agente** (`/linking`): instrucciones paso a paso para que el cliente
  genere su código de vinculación del ATO (client-to-agent linking code) y lo envíe —
  nunca se pide la contraseña de myGov.
- **Programa de referidos** (`/referrals`): código único por usuario, vinculación automática
  al registrarse con un código, y tabla de estados (pendiente / listo para pago / pagado).
- **Guía de impuestos** (`/tax-info`): tasas según tipo de visa, beneficio NDA, y obligatoriedad
  de la declaración.
- **Panel de administración** (`/admin`): login separado con contraseña propia (`ADMIN_PASSWORD`),
  lista de clientes, detalle por cliente (datos, documentos descargables, año fiscal),
  actualización del estado de vinculación, y gestión de pagos de referidos.

## Cómo correrlo

```bash
npm install
cp .env.example .env   # y editá JWT_SECRET
node server.js
```

Abrí `http://localhost:3000`.

## Almacenamiento de datos

Este prototipo usa **lowdb** (un archivo JSON en `db/db.json`) y guarda los archivos
subidos en `uploads/<userId>/<añoFiscal>/`. Esto es suficiente para probar el flujo
completo, pero **antes de producción hay que migrar**:

- Base de datos → PostgreSQL / MySQL (la estructura de datos ya está pensada en
  tablas: `users`, `taxYearProfiles`, `documents`, `referrals`).
- Archivos → almacenamiento cifrado en la nube (S3 + cifrado del lado del servidor,
  o equivalente), no en disco local.
- Datos bancarios y de contacto → cifrado en reposo (campo a campo o columna completa).

## Importante — myGov

El sistema **no** tiene ni debe tener un campo para guardar la contraseña de myGov de
los usuarios. Eso es un riesgo de seguridad enorme (y probablemente una violación de
los términos de myGov). La forma correcta de operar es que el agente de impuestos
registrado (TPB) se vincule a la cuenta del cliente a través del **Tax Agent Portal**
del ATO, usando el **código de vinculación cliente-agente** que el cliente genera
en ATO online services (válido por 7 días) — no la contraseña personal. La página
`/linking` explica este proceso paso a paso y recolecta ese código de forma segura.

## Sobre el sistema de referidos

El prototipo registra y vincula códigos de referido y muestra el estado
(pendiente / listo para pago / pagado), pero **no procesa pagos reales**. El pago de
los USD 20 por referido se gestiona manualmente (o con una integración de pagos a
elegir más adelante: PayPal Payouts, Wise, transferencia bancaria, etc.). Cambiar el
estado a "pagado" hoy se haría editando `db/db.json` directamente; convendría agregar
un panel de administración simple para esto.

## Requisito legal — Tax Practitioner Board (TPB)

Para cobrar por la preparación de declaraciones de impuestos en Australia, alguien
debe estar registrado como Tax Agent ante el TPB y asumir la responsabilidad
profesional de las presentaciones. Si todavía no estás registrado/a, la vía rápida
y legal es operar como contratista/socio de un agente ya registrado (la propia
normativa del TPB lo permite: "employee or contractor of a registered tax agent").
Ver `DEPLOY.md` para más detalle sobre cómo encontrar y proponer esta asociación.

## E-mails (confirmación de cuenta)

En desarrollo, los e-mails no se envían: se escriben en `emails-dev.log` para que puedas
copiar el enlace de verificación y probar el flujo. En producción, configurá las
variables `SMTP_*` en `.env` con un proveedor real (ej. Brevo, SendGrid, Amazon SES,
o un Gmail con "App Password"). Una vez configuradas, los e-mails de confirmación se
envían automáticamente.

## Despliegue

Ver `DEPLOY.md` para la guía paso a paso de puesta en producción (dominio, VPS,
HTTPS, backups) pensada para un lanzamiento en 15 días.

## Estructura del proyecto

```
retax/
├── server.js              # punto de entrada
├── db/
│   ├── database.js         # conexión lowdb
│   ├── helpers.js           # IDs, años fiscales, códigos de referido
│   └── documentCategories.js
├── middleware/
│   ├── auth.js              # JWT
│   └── upload.js            # multer
├── routes/
│   ├── main.js               # landing, dashboard, tax-info
│   ├── auth.js               # registro/login/logout
│   ├── profile.js            # datos personales
│   ├── taxyear.js            # info + documentos por año
│   └── referrals.js
├── views/                  # plantillas EJS
├── public/css/style.css   # diseño
└── uploads/                # archivos subidos (no versionar)
```

## Próximos pasos sugeridos

1. Migrar lowdb → base de datos real con backups automáticos.
2. Cifrado de datos sensibles (banco, dirección) en reposo.
3. Panel de administración: revisar documentos, marcar referidos como pagados,
   exportar info por cliente para presentar la declaración.
4. Verificación de e-mail al registrarse.
5. Términos y condiciones + política de privacidad (obligatorio si se manejan
   datos bancarios y documentos personales).
6. Notificaciones por e-mail (recordatorios de documentos faltantes, estado del reembolso).
