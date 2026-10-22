const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { genId, genReferralCode } = require('../db/helpers');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');
const { sendWelcomeVerification, sendPasswordReset } = require('../lib/emails');

const router = express.Router();
const CODE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 año — no vence en la práctica

const loginLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });
const verifyLimiter   = rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 5,  standardHeaders: true, legacyHeaders: false, message: 'Demasiados intentos. Intentá en una hora.' });
const disposableDomains = require('../lib/disposable-domains');

// Registro de cuentas nuevas pausado: muestra popup con WhatsApp y rechaza el POST.
// Para reabrir: REGISTRATION_PAUSED=false en .env + pm2 restart retaux --update-env
const REGISTRATION_PAUSED = process.env.REGISTRATION_PAUSED !== 'false';

function setSession(res, userId, opts = {}) {
  const maxAge = opts.longSession ? 30 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const expiresIn = opts.longSession ? '30d' : '2h';
  const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn });
  res.cookie('retaux_token', token, { httpOnly: true, sameSite: 'lax', maxAge });
}

function genCode() { return crypto.randomInt(0, 1000000).toString().padStart(6,'0'); }

// API: verifica si un email ya existe (para validación en tiempo real)
router.get('/api/check-email', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ valid: false, exists: false });
  }
  const exists = !!db.get('users').find({ email }).value();
  res.json({ valid: true, exists });
});

router.get('/register', (req, res) => {
  res.render('register', {
    error: null,
    refCode: req.query.ref || '',
    prefill: {},
    registrationPaused: REGISTRATION_PAUSED,
    metaTitle: 'Crear cuenta — RETAUX | Australian Tax Return',
    metaDesc: 'Recuperá tu tax return en Australia. Servicio profesional para Working Holiday Makers. AUD 120 con código de referido.',
    ogUrl: req.originalUrl
  });
});

router.post('/register', registerLimiter, async (req, res) => {
  if (REGISTRATION_PAUSED)
    return res.render('register', { error: null, prefill: {}, refCode: '', registrationPaused: true });

  // Honeypot
  if ((req.body.website || '').trim()) return res.redirect('/register');

  // Tiempo mínimo de llenado: menos de 8 segundos = bot
  const formLoadedAt = parseInt(req.body._t || '0', 10);
  if (formLoadedAt && (Date.now() - formLoadedAt) < 8000) return res.redirect('/register');

  const { email, password, referralCode } = req.body;
  const normalizedEmail = (email || '').toLowerCase().trim();

  if (!normalizedEmail || !password)
    return res.render('register', { error: req.__('auth.error_required') || 'Completá e-mail y clave.', prefill: req.body, refCode: referralCode || '' });
  if (password.length < 6)
    return res.render('register', { error: req.__('auth.error_pwd_short') || 'La clave debe tener al menos 6 caracteres.', prefill: req.body, refCode: referralCode || '' });
  // Bloqueo de dominios desechables
  const emailDomain = normalizedEmail.split('@')[1] || '';
  if (disposableDomains.has(emailDomain))
    return res.render('register', { error: 'Usá un e-mail permanente — no se aceptan correos temporales.', prefill: req.body, refCode: referralCode || '' });

  // Bloqueo de alias con código aleatorio (patrón de bots: nombre+abc123@gmail.com)
  if (/\+[a-z0-9]{3,}@(gmail|hotmail|yahoo|outlook)\.com$/.test(normalizedEmail))
    return res.render('register', { error: 'No se aceptan alias de email con códigos. Usá tu dirección principal.', prefill: req.body, refCode: referralCode || '' });

  if (db.get('users').find({ email: normalizedEmail }).value())
    return res.render('register', { error: req.__('auth.error_email_exists') || 'Ya existe una cuenta con ese e-mail.', prefill: req.body, refCode: referralCode || '' });

  const userId = genId();
  const code = genCode();
  const lang = ['es','en','fr','it'].includes(req.cookies.lang) ? req.cookies.lang : 'en';
  const newUser = {
    id: userId,
    fullName: '',
    email: normalizedEmail,
    tfn: '',
    hasMygov: false,
    hasAtoLinked: false,
    pinHash: bcrypt.hashSync(password, 10),
    lang,
    emailVerified: false,
    verificationCode: code,
    verificationCodeExpires: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    phone: '', nationality: '', currentVisaSubclass: '', previousVisaDetails: '',
    visaChangedRecently: null, currentAddress: '',
    bankAccountName: '', bsb: '', accountNumber: '',
    referralCode: genReferralCode(normalizedEmail),
    referredByCode: null,
    onboardingStep: 'personal', // personal → documents → payment → done
    linkingStatus: 'not_started', linkingCode: '', linkingSubmittedAt: null,
    adminNotes: '', adminAssignedTo: null,
    createdAt: new Date().toISOString()
  };

  if (referralCode && referralCode.trim()) {
    const referrer = db.get('users').find({ referralCode: referralCode.trim().toUpperCase() }).value();
    if (referrer) {
      newUser.referredByCode = referrer.referralCode;
      db.get('referrals').push({
        id: genId(), referrerUserId: referrer.id, referredUserId: userId,
        status: 'pending', createdAt: new Date().toISOString(), paidAt: null, note: ''
      }).write();
    }
  }

  db.get('users').push(newUser).write();

  // Enviar email con timeout de 8s — nunca bloquea el registro
  const emailTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Email timeout')), 8000)
  );
  try {
    await Promise.race([sendWelcomeVerification(newUser), emailTimeout]);
    console.log('[REGISTER] Email enviado a:', newUser.email);
  } catch(e) {
    console.error('[REGISTER] Email error (usuario creado igual):', e.message);
  }

  setSession(res, userId);
  res.redirect('/verify-email');
});

router.get('/verify-email', requireAuth, (req, res) => {
  if (req.user.emailVerified) return res.redirect('/dashboard');
  res.render('verify-email', { user: req.user, error: null, sent: req.query.sent==='1', prefillCode: req.query.code || '' });
});

router.post('/verify-email', requireAuth, verifyLimiter, (req, res) => {
  if (req.user.emailVerified) return res.redirect('/dashboard');
  const code = (req.body.code || '').trim();
  // Sin vencimiento — el código es válido hasta que se use o se reenvíe uno nuevo
  if (code !== req.user.verificationCode)
    return res.render('verify-email', { user: req.user, error: 'Código incorrecto. Revisá tu e-mail.', sent: false, prefillCode: '' });
  db.get('users').find({ id: req.user.id }).assign({ emailVerified: true, verificationCode: null, verificationCodeExpires: null }).write();
  res.redirect('/welcome');
});

router.get('/welcome', requireAuth, (req, res) => {
  if (!req.user.emailVerified) return res.redirect('/verify-email');
  const firstName = req.user.firstName || (req.user.fullName || '').split(' ')[0] || 'ahí';
  res.render('welcome', { firstName });
});

router.get('/resend-verification', requireAuth, async (req, res) => {
  if (req.user.emailVerified) return res.redirect('/dashboard');
  const code = genCode();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.get('users').find({ id: req.user.id }).assign({ verificationCode: code, verificationCodeExpires: expires }).write();
  try {
    await Promise.race([
      sendWelcomeVerification({ ...req.user, verificationCode: code }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
    ]);
  } catch(e) { console.error('[RESEND] Email error:', e.message); }
  res.redirect('/verify-email?sent=1');
});

router.get('/login', (req, res) => {
  const errorMap = {
    link_invalido: 'El link de acceso no es válido o ya venció. Escribinos a hola@retaux.com para que te enviemos uno nuevo.',
    link_vencido:  'El link de acceso venció (48 horas). Escribinos a hola@retaux.com y te reenviamos el acceso.',
  };
  const error = errorMap[req.query.error] || null;
  res.render('login', { error, prefill: {} });
});

router.post('/login', loginLimiter, (req, res) => {
  const { email, password, pin } = req.body;
  const pwd = password || pin || '';
  const user = db.get('users').find({ email: (email||'').toLowerCase().trim() }).value();
  if (!user || !bcrypt.compareSync(pwd, user.pinHash))
    return res.render('login', { error: 'E-mail o clave incorrectos.', prefill: { email } });
  setSession(res, user.id);
  if (user.role === 'referrer')  return res.redirect('/referrer');
  if (user.role === 'taxagent')  return res.redirect('/taxagent');
  res.redirect(user.emailVerified ? '/dashboard' : '/verify-email');
});

router.get('/logout', (req, res) => { res.clearCookie('retaux_token'); res.redirect('/'); });

// ── Magic link — login sin contraseña desde email ─────────────────────────────
// Genera un token de un solo uso (48h) guardado en el usuario
// Uso: genMagicLink(userId, '/dashboard') → URL lista para poner en email
function genMagicToken(userId, redirectTo) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 año
  db.get('users').find({ id: userId }).assign({
    magicToken: token,
    magicTokenExpires: expires,
    magicTokenRedirect: redirectTo || '/dashboard',
  }).write();
  return token;
}

router.get('/magic', (req, res) => {
  const { t } = req.query;
  if (!t) return res.redirect('/login');

  const user = db.get('users').find({ magicToken: t }).value();
  if (!user) return res.redirect('/login?error=link_invalido');

  const expired = !user.magicTokenExpires || new Date(user.magicTokenExpires) < new Date();
  if (expired) {
    db.get('users').find({ id: user.id }).assign({ magicToken: null, magicTokenExpires: null }).write();
    return res.redirect('/login?error=link_vencido');
  }

  // No consumir el token — queda activo hasta vencer (48h) para que
  // funcione desde múltiples dispositivos o si el cliente reenvia el email.
  const redirectTo = user.magicTokenRedirect || '/dashboard';
  db.get('users').find({ id: user.id }).assign({
    emailVerified: true,
  }).write();

  setSession(res, user.id, { longSession: true }); // 30 días
  res.redirect(redirectTo);
});

// genMagicToken se exporta junto con el router al final del archivo

// ── Recupero de clave ─────────────────────────────────────────────────────────

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { error: null, success: null, prefill: '' });
});

router.post('/forgot-password', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const user = db.get('users').find({ email }).value();

  // Siempre mostrar el mismo mensaje (no revelar si existe o no)
  const successMsg = 'Si ese e-mail está registrado, vas a recibir un código en segundos.';

  if (user) {
    const code = genCode();
    const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
    db.get('users').find({ id: user.id }).assign({
      resetCode: code,
      resetCodeExpires: expires
    }).write();
    try {
      await Promise.race([
        sendPasswordReset(user, code),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
      ]);
    } catch(e) { console.error('[RESET] Email error:', e.message); }
  }

  res.render('forgot-password', { error: null, success: successMsg, prefill: email });
});

router.get('/reset-password', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  res.render('reset-password', { email, error: null });
});

router.post('/reset-password', async (req, res) => {
  const { email, code, newPin, newPinConfirm } = req.body;
  const normalizedEmail = (email || '').toLowerCase().trim();

  const user = db.get('users').find({ email: normalizedEmail }).value();
  if (!user) return res.render('reset-password', { email: normalizedEmail, error: 'Código inválido o vencido.' });

  if (!user.resetCode || user.resetCode !== (code || '').trim()) {
    return res.render('reset-password', { email: normalizedEmail, error: 'Código incorrecto.' });
  }
  if (!user.resetCodeExpires || new Date(user.resetCodeExpires) < new Date()) {
    return res.render('reset-password', { email: normalizedEmail, error: 'El código venció. Pedí uno nuevo.' });
  }
  if (!newPin) {
    return res.render('reset-password', { email: normalizedEmail, error: 'Ingresá una clave nueva.' });
  }
  if (newPin !== newPinConfirm) {
    return res.render('reset-password', { email: normalizedEmail, error: 'Las claves no coinciden.' });
  }

  db.get('users').find({ id: user.id }).assign({
    pinHash: bcrypt.hashSync(newPin, 10),
    resetCode: null,
    resetCodeExpires: null
  }).write();

  // Iniciar sesión automáticamente
  setSession(res, user.id);
  res.redirect('/dashboard');
});

router.genMagicToken = genMagicToken;
module.exports = router;
