require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Confiar en el proxy de nginx para rate limiting e IPs reales
app.set('trust proxy', 1);

// Seguridad: ocultar stack y agregar headers de protección
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// El webhook de Stripe necesita el body RAW (sin parsear).
// Debe registrarse ANTES de express.json() y express.urlencoded().
app.use('/payment/webhook', express.raw({ type: 'application/json' }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', false);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const { middleware: i18n } = require('./lib/i18n');
app.use(i18n);

app.use(express.static(path.join(__dirname, 'public')));

// Health check — permite verificar que el proceso correcto sirve el sitio
const _healthDb = require('./db/database');
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    port: PORT,
    cwd: __dirname,
    users: _healthDb.get('users').size().value(),
    uptime: Math.floor(process.uptime())
  });
});

// Serve locale JSON files for client-side i18n
app.get('/locales/:lang.json', (req, res) => {
  const allowed = ['es', 'en', 'fr', 'it'];
  const lang = req.params.lang;
  if (!allowed.includes(lang)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'locales', lang + '.json'));
});

app.use('/', require('./routes/public'));
app.use('/', require('./routes/main'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/onboarding'));
app.use('/', require('./routes/payment'));
app.use('/', require('./routes/profile'));
app.use('/', require('./routes/taxyear'));
app.use('/', require('./routes/referrals'));
app.use('/', require('./routes/linking'));
app.use('/', require('./routes/dasp'));
app.use('/', require('./routes/super'));
app.use('/admin', require('./routes/admin'));
app.use('/taxagent', require('./routes/taxagent').router);
app.use('/', require('./routes/bundle'));
app.use('/', require('./routes/webhook'));

app.use((req, res) => res.status(404).render('404', { user: req.user || null }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Error interno del servidor.');
});

app.listen(PORT, () => {
  console.log(`RETAUX corriendo en http://localhost:${PORT}`);
  const { cleanupUnverified } = require('./lib/cleanup-unverified');
  cleanupUnverified();
  setInterval(cleanupUnverified, 60 * 60 * 1000);

  // ── Startup dependency check ──────────────────────────────────────────────
  const { execSync } = require('child_process');
  const checks = [
    { label: 'LibreOffice (soffice)', cmd: 'soffice --version' },
    { label: 'openpyxl',             cmd: 'python3 -c "import openpyxl"' },
    { label: 'pypdf',                cmd: 'python3 -c "from pypdf import PdfReader"' },
    { label: 'reportlab',            cmd: 'python3 -c "from reportlab.pdfgen import canvas"' },
  ];
  checks.forEach(({ label, cmd }) => {
    try {
      execSync(cmd, { stdio: 'ignore', timeout: 8000 });
      console.log(`[DEPS] ✓ ${label}`);
    } catch {
      console.error(`[DEPS] ✗ ${label} — NO DISPONIBLE. Los archivos ENPRESA pueden fallar.`);
    }
  });
});
