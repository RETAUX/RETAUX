const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { genId, getFinancialYears } = require('../db/helpers');
const { bookChosenSlot, availableDates, formatSlot } = require('../db/appointments');
const { sendPaymentReceipt, sendPaymentPendingNotification, sendReferralCode, sendAppointmentConfirmation } = require('../lib/emails');

const router = express.Router();

const PROOF_DIR = path.join(__dirname, '..', 'uploads', 'payment-proofs');
if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });

const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROOF_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.id}-${Date.now()}${ext}`);
  }
});
const uploadProof = multer({ storage: proofStorage, limits: { fileSize: 20 * 1024 * 1024 } });

const _rawPrice = Number(process.env.SERVICE_PRICE_AUD);
if (_rawPrice && _rawPrice < 100) {
  throw new Error(`SERVICE_PRICE_AUD está configurado en ${_rawPrice}, que parece incorrecto (mínimo 100). Revisá el .env del servidor.`);
}
const PRICE_AUD    = _rawPrice || 150;
const DISCOUNT_AUD = 30;

// ── Autorización (firma previa al pago) ──────────────────────────────────────

router.get('/consent', requireAuth, requireVerified, (req, res) => {
  const alreadyPaid = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (req.user.consentSignedAt && !alreadyPaid) return res.redirect('/payment');
  if (req.user.consentSignedAt && alreadyPaid) return res.redirect('/dashboard');
  res.render('payment/consent', { user: req.user, alreadyPaid, error: req.query.error || null });
});

router.post('/consent', requireAuth, requireVerified, (req, res) => {
  const signedName = (req.body.signedName || '').trim();
  if (signedName.length < 3) return res.redirect('/consent?error=1');
  const alreadyPaid = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  db.get('users').find({ id: req.user.id }).assign({
    consentSignedName: signedName,
    consentSignedAt: new Date().toISOString(),
  }).write();
  res.redirect(alreadyPaid ? '/dashboard' : '/payment');
});

// ── Página de pago ────────────────────────────────────────────────────────────

router.get('/payment', requireAuth, requireVerified, (req, res) => {
  const existingPayment = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (existingPayment) return res.redirect('/dashboard');

  if (!req.user.consentSignedAt) return res.redirect('/consent');

  const pendingPayment = db.get('payments').find({ userId: req.user.id, status: 'pending_manual' }).value();
  if (pendingPayment) return res.redirect('/payment/pending');

  const linkedRef = req.user.referredByCode || null;

  // Precio especial asignado por admin (customPrice sobreescribe todo)
  const effectivePriceAUD = req.user.customPrice ? req.user.customPrice : PRICE_AUD;
  const effectiveDiscountAUD = req.user.customPrice ? 0 : DISCOUNT_AUD;

  res.render('payment/checkout', {
    user: req.user,
    priceAUD: effectivePriceAUD,
    discountAUD: effectiveDiscountAUD,
    linkedRef: req.user.customPrice ? null : linkedRef,
    taxYear: getFinancialYears()[0],
    paymentLinkFull:     process.env.PAYMENT_LINK_FULL     || '',
    paymentLinkDiscount: process.env.PAYMENT_LINK_DISCOUNT || '',
    paymentLinkBase:     (process.env.PAYMENT_LINK_FULL || '').split('?')[0] || '',
    error:   req.query.error   || null,
    success: req.query.success || null
  });
});

// ── Validar código de referido ────────────────────────────────────────────────

router.get('/payment/validate-ref', requireAuth, requireVerified, (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.json({ valid: false });
  if (req.user.referralCode === code) return res.json({ valid: false, reason: 'own' });
  const referrer = db.get('users').find({ referralCode: code }).value();
  if (!referrer) return res.json({ valid: false });
  const alreadyUsed = db.get('referrals').find({ referredUserId: req.user.id }).value();
  if (alreadyUsed) return res.json({ valid: true, already: true, referrerName: referrer ? referrer.fullName.split(' ')[0] : '' });
  res.json({ valid: true, referrerName: referrer.fullName.split(' ')[0] });
});

// ── Cliente declara que ya pagó (crea pago pending_manual) ───────────────────

router.post('/payment/submit-manual', requireAuth, requireVerified, uploadProof.single('paymentProof'), async (req, res) => {
  const existingPaid = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (existingPaid) return res.redirect('/dashboard');

  const existingPending = db.get('payments').find({ userId: req.user.id, status: 'pending_manual' }).value();
  if (existingPending) return res.redirect('/payment/pending');

  const proofFilename = req.file ? req.file.filename : null;

  const code = (req.body.referralCode || '').trim().toUpperCase();
  let discountApplied = false;

  // Usar referredByCode guardado en el registro si no se ingresó uno nuevo
  const effectiveCode = code || (req.user.referredByCode || '');

  if (effectiveCode && effectiveCode !== req.user.referralCode) {
    const alreadyLinked = db.get('referrals').find({ referredUserId: req.user.id }).value();
    if (alreadyLinked) {
      // Ya existe el referral desde el registro — solo aplicar descuento
      discountApplied = true;
    } else {
      const referrer = db.get('users').find({ referralCode: effectiveCode }).value();
      if (referrer) {
        discountApplied = true;
        db.get('referrals').push({
          id: genId(), referrerUserId: referrer.id, referredUserId: req.user.id,
          status: 'pending', discountApplied: true,
          createdAt: new Date().toISOString(), paidAt: null
        }).write();
        db.get('users').find({ id: req.user.id }).assign({ referredByCode: effectiveCode }).write();
      }
    }
  }

  const years = Math.min(Math.max(parseInt(req.body.years) || 1, 1), 4);
  // Precio especial del admin tiene prioridad sobre todo
  const basePrice = req.user.customPrice || PRICE_AUD;
  const pricePerYear = req.user.customPrice ? basePrice : (discountApplied ? (PRICE_AUD - DISCOUNT_AUD) : PRICE_AUD);
  const finalAmount = pricePerYear * years;

  db.get('payments').push({
    id: genId(),
    userId: req.user.id,
    taxYear: getFinancialYears()[0],
    status: 'pending_manual',
    amountCents: Math.round(finalAmount * 100),
    discountApplied,
    customPrice: req.user.customPrice || null,
    customPriceReason: req.user.customPriceReason || null,
    years,
    method: 'manual',
    proofFilename,
    createdAt: new Date().toISOString()
  }).write();

  db.get('users').find({ id: req.user.id }).assign({ onboardingStep: 'payment_pending' }).write();

  const newPayment = db.get('payments').find({ userId: req.user.id, status: 'pending_manual' }).value();
  try {
    await sendPaymentPendingNotification(req.user, newPayment);
  } catch(e) { console.error('[PAYMENT] Notification email error:', e.message); }

  console.log('[PAYMENT MANUAL] Pago declarado por usuario:', req.user.email);
  res.redirect('/payment/pending');
});

// ── Página de pago pendiente de confirmación manual ──────────────────────────

router.get('/payment/pending', requireAuth, requireVerified, (req, res) => {
  const existingPaid = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (existingPaid) return res.redirect('/dashboard');
  res.render('payment/pending', { user: req.user });
});

// ── Elegir turno (post-pago) ──────────────────────────────────────────────────

router.get('/appointment/book', requireAuth, requireVerified, (req, res) => {
  const payment = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (!payment) return res.redirect('/payment');
  const existing = db.get('appointments').find({ userId: req.user.id }).value();
  if (existing) return res.redirect('/appointment/confirmed');

  const dates = availableDates(new Date(), 45);
  res.render('appointment/book', {
    user: req.user,
    dates,
    formatSlot,
    error: req.query.error || null
  });
});

router.post('/appointment/book', requireAuth, requireVerified, async (req, res) => {
  const payment = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (!payment) return res.redirect('/payment');

  const { date, hour } = req.body;
  if (!date || !hour) return res.redirect('/appointment/book?error=Seleccioná una fecha y horario.');

  let appt;
  try {
    appt = bookChosenSlot(req.user.id, payment.taxYear || getFinancialYears()[0], date, Number(hour));
  } catch (err) {
    return res.redirect('/appointment/book?error=' + encodeURIComponent(err.message));
  }

  // Email de confirmación de turno desactivado — no se usa más este método

  res.redirect('/appointment/confirmed');
});

// ── Página de turno confirmado ────────────────────────────────────────────────

router.get('/appointment/confirmed', requireAuth, requireVerified, (req, res) => {
  const appt = db.get('appointments').find({ userId: req.user.id }).value();
  if (!appt) return res.redirect('/appointment/book');
  res.render('appointment-confirmed', { user: req.user, appt, formatSlot });
});

// ── Suspender turno (con 24h de anticipación mínima) ─────────────────────────

router.post('/appointment/cancel', requireAuth, requireVerified, (req, res) => {
  const appt = db.get('appointments').find({ userId: req.user.id }).value();
  if (!appt) return res.redirect('/dashboard');

  const apptDate = new Date(`${appt.date}T${String(appt.hour).padStart(2,'0')}:00:00`);
  const hoursUntil = (apptDate - new Date()) / 36e5;
  if (hoursUntil <= 24) {
    return res.redirect('/appointment/confirmed?error=' + encodeURIComponent('No podés suspender un turno con menos de 24 horas de anticipación.'));
  }

  db.get('appointments').remove({ userId: req.user.id }).write();
  res.redirect('/appointment/book?cancelled=1');
});

// ── Procesar pago (sin auto-asignar turno) ────────────────────────────────────

async function processPayment(userId, taxYear, paymentId, amountCents) {
  // Acreditar puntos al referidor
  const referral = db.get('referrals').find({ referredUserId: userId }).value();
  if (referral && referral.status === 'pending') {
    db.get('referrals').find({ id: referral.id }).assign({
      status: 'paid', paidAt: new Date().toISOString()
    }).write();
    const referrer = db.get('users').find({ id: referral.referrerUserId }).value();
    if (referrer) {
      db.get('users').find({ id: referrer.id }).assign({
        referralPoints: (referrer.referralPoints || 0) + 20
      }).write();
      console.log(`[PAYMENT] +20 AUD puntos → ${referrer.email}`);
    }
  }

  db.get('users').find({ id: userId }).assign({ onboardingStep: 'done', taxReturnStage: 'processing' }).write();

  const user = db.get('users').find({ id: userId }).value();
  const payment = db.get('payments').find({ id: paymentId }).value();
  try {
    await Promise.race([sendPaymentReceipt(user, payment, null), new Promise((_, r) => setTimeout(() => r(), 10000))]);
  } catch(e) { console.error('[PAYMENT] Email error:', e.message); }
}

// ── Estado del trámite (timeline) ────────────────────────────────────────────

router.get('/case/status', requireAuth, requireVerified, (req, res) => {
  const payment = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (!payment) return res.redirect('/dashboard');
  res.render('case/status', { user: req.user, payment });
});

module.exports = router;
