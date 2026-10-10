const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/database');
const { requireAuth, attachUser, requireVerified } = require('../middleware/auth');
const { getFinancialYears, genId } = require('../db/helpers');
const { formatSlot } = require('../db/appointments');
const DOCUMENT_CATEGORIES = require('../db/documentCategories');
const { sendMail } = require('../lib/mailer');

const router = express.Router();
const PIN_REGEX = /^\d{8}$/;

router.get('/', attachUser, (req, res) => res.render('landing', { user: req.user || null }));
router.get('/tax-info', attachUser, (req, res) => res.render('tax-info', { user: req.user || null }));
router.get('/calculator', attachUser, (req, res) => res.render('calculator', { user: req.user || null }));
router.get('/terms', attachUser, (req, res) => res.render('terms', { user: req.user || null }));

// ── Soporte ───────────────────────────────────────────────────────────────────
router.get('/support', requireAuth, requireVerified, (req, res) => {
  res.render('support', { user: req.user, sent: false, error: null });
});

router.post('/support', requireAuth, requireVerified, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message || !message.trim()) {
    return res.render('support', { user: req.user, sent: false, error: 'Completá el asunto y el mensaje.' });
  }

  const html = `
    <h2>Nuevo mensaje de soporte</h2>
    <p><strong>Usuario:</strong> ${req.user.fullName} (${req.user.email})</p>
    <p><strong>Asunto:</strong> ${subject}</p>
    <p><strong>Mensaje:</strong></p>
    <p style="background:#f5f5f5;padding:16px;border-radius:6px;">${message.replace(/\n/g,'<br>')}</p>
    <hr>
    <p style="font-size:12px;color:#888;">Enviado desde RETAUX · ${new Date().toLocaleString('es-AR')}</p>
  `;

  try {
    await Promise.race([
      sendMail({
        to: 'hola@retaux.com',
        subject: `[Soporte] ${subject} — ${req.user.fullName}`,
        text: `De: ${req.user.fullName} (${req.user.email})\n\nAsunto: ${subject}\n\n${message}`,
        html,
        replyTo: req.user.email
      }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
    ]);
  } catch(e) {
    console.error('[SUPPORT] Error enviando email:', e.message);
  }

  res.render('support', { user: req.user, sent: true, error: null });
});

// ── Dashboard de referidor ─────────────────────────────────────────────────────
router.get('/referrer', requireAuth, requireVerified, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (user.role !== 'referrer') return res.redirect('/dashboard');
  const referrals = db.get('referrals').filter({ referrerUserId: user.id }).value();
  const paidReferrals = referrals.filter(r => r.status === 'paid');
  const earned = paidReferrals.length * 20;
  const refLink = `${process.env.BASE_URL}/register?ref=${user.referralCode}`;
  const referredUsers = db.get('users').value();
  res.render('dashboard/referrer', { user, referrals, paidReferrals, earned, refLink, referredUsers });
});

// ── Cambio de clave con verificación por email ─────────────────────────────────
router.post('/profile/request-pin-change', requireAuth, requireVerified, async (req, res) => {
  const { newPin } = req.body;
  const user = db.get('users').find({ id: req.user.id }).value();

  if (!PIN_REGEX.test(newPin || '')) {
    return res.redirect('/onboarding/personal?pinError=format');
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const pendingHash = await bcrypt.hash(newPin, 10);
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.get('users').find({ id: user.id }).assign({
    pinChangeCode: code,
    pinChangeCodeExpires: expires,
    pinChangePendingHash: pendingHash
  }).write();

  try {
    await sendMail({
      to: user.email,
      subject: 'Código para cambiar tu clave — RETAUX',
      text: `Tu código de verificación es: ${code}. Expira en 15 minutos.`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#1C2B45">Cambio de clave — RETAUX</h2>
        <p>Tu código de verificación es:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#D98A3D;margin:20px 0">${code}</div>
        <p style="color:#666;font-size:14px">Expira en 15 minutos. Si no solicitaste este cambio, ignorá este email.</p>
      </div>`
    });
  } catch (e) {
    return res.redirect('/onboarding/personal?pinError=send');
  }

  res.redirect('/onboarding/personal?pinStep=verify');
});

router.post('/profile/confirm-pin-change', requireAuth, requireVerified, async (req, res) => {
  const { code } = req.body;
  const user = db.get('users').find({ id: req.user.id }).value();

  const now = new Date();
  const expired = !user.pinChangeCodeExpires || new Date(user.pinChangeCodeExpires) < now;
  const invalid = !user.pinChangeCode || user.pinChangeCode !== (code || '').trim();

  if (expired || invalid) {
    return res.redirect('/onboarding/personal?pinStep=verify&pinError=code');
  }

  db.get('users').find({ id: user.id }).assign({
    pinHash: user.pinChangePendingHash,
    pinChangeCode: null,
    pinChangeCodeExpires: null,
    pinChangePendingHash: null
  }).write();

  res.redirect('/onboarding/personal?pinSuccess=1');
});

router.get('/dashboard', requireAuth, requireVerified, (req, res) => {
  const financialYears = getFinancialYears();

  const personalFields = ['fullName','phone','nationality','birthDate','arrivalDateInAustralia','jobCategory','tfn','taxResidencyStatus','maritalStatus','medicareExemption','currentVisaSubclass','currentAddress','bankAccountName','bsb','accountNumber'];
  const filledCount = personalFields.filter(f => (req.user[f]||'').toString().trim()).length;
  const profilePct = Math.round((filledCount / personalFields.length) * 100);
  const profileComplete = filledCount === personalFields.length;

  const allDocs = db.get('documents').filter({ userId: req.user.id }).value();
  const yearSummaries = financialYears.map(taxYear => {
    const docs = allDocs.filter(d => d.taxYear === taxYear);
    const profile = db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).value();
    const catCounts = {};
    DOCUMENT_CATEGORIES.forEach(cat => {
      catCounts['cat_' + cat.id] = docs.filter(d => d.category === cat.id).length;
    });
    return {
      taxYear,
      docCount: docs.length,
      categoriesWithDocs: new Set(docs.map(d => d.category)).size,
      totalCategories: DOCUMENT_CATEGORIES.length,
      infoStarted: !!profile && !!(profile.jobsDescription||'').trim(),
      ...catCounts
    };
  });

  const appt = db.get('appointments').find({ userId: req.user.id }).value();
  const payment = db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  const referrals = db.get('referrals').filter({ referrerUserId: req.user.id }).value();
  const paidReferrals = referrals.filter(r => r.status === 'paid').length;
  const daspRequest = db.get('daspRequests').find({ userId: req.user.id }).value() || null;
  const superPayment = db.get('super_payments').find({ userId: req.user.id }).value() || null;

  res.render('dashboard', {
    user: req.user, profileComplete, profilePct, yearSummaries,
    appt, payment, referrals, paidReferrals, formatSlot, daspRequest, superPayment
  });
});

// ── Tax Estimate — accept ────────────────────────────────────────────────────
router.post('/dashboard/tax-estimate/accept', requireAuth, requireVerified, async (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user || !user.taxEstimate) return res.redirect('/dashboard');

  db.get('users').find({ id: user.id }).assign({
    taxEstimate: { ...user.taxEstimate, status: 'accepted', acceptedAt: new Date().toISOString() },
    taxReturnStage: 'issued'
  }).write();

  const est = db.get('users').find({ id: user.id }).value().taxEstimate;
  const fmt = v => (v !== null && v !== undefined) ? '$' + Number(v).toFixed(2) : '—';
  const tfn = (user.profile && user.profile.tfn) ? user.profile.tfn : (user.tfn || '—');

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
    <div style="background:#0A0E5C;padding:20px 28px;"><div style="font-size:1.1rem;font-weight:700;color:#FFC107;">RETAUX</div><div style="font-size:1.15rem;font-weight:700;color:#fff;margin-top:4px;">Tax Estimate Accepted</div></div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;font-size:0.95rem;color:#374151;"><strong>${user.fullName || user.email}</strong> accepted their tax estimate. Please proceed with lodgement.</p>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;margin-bottom:20px;">
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;width:40%;">Client Name</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${user.fullName || user.email}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">Email</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${user.email}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">TFN</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${tfn}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">Accepted At</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${new Date(est.acceptedAt).toLocaleString('en-AU')}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;width:60%;border-bottom:1px solid #E5E7EB;">Taxable Income</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxableIncome)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Tax Payable on Taxable Income</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxPayableOnTaxableIncome)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Low Income Offset</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.lowIncomeOffset)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Tax Withheld (salary)</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxWithheldSalary)}</td></tr>
        <tr><td style="padding:7px 12px;background:#ECFDF5;font-weight:700;color:#065F46;font-size:1rem;">Estimated Tax Refund</td><td style="padding:7px 12px;font-family:monospace;font-weight:700;font-size:1rem;color:#065F46;">${fmt(est.estimatedRefund)}</td></tr>
      </table>
    </div>
    <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">RETAUX · hola@retaux.com</div>
  </div>`;

  try {
    await sendMail({ to: 'hishamcharbine@gmail.com', subject: `[RETAUX] Tax Estimate Accepted — ${user.fullName || user.email}`, html, text: `Client ${user.fullName || user.email} (TFN: ${tfn}) accepted. Estimated refund: ${fmt(est.estimatedRefund)}.` });
  } catch (e) { console.error('[TAX-ESTIMATE ACCEPT]', e.message); }

  const updatedUser = db.get('users').find({ id: user.id }).value();
  res.render('dashboard/estimate-confirmed', { user: updatedUser });
});

// ── Tax Estimate — doubt ─────────────────────────────────────────────────────
router.post('/dashboard/tax-estimate/doubt', requireAuth, requireVerified, async (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user || !user.taxEstimate) return res.redirect('/dashboard');

  const comment = (req.body.comment || '').trim().slice(0, 1000);
  db.get('users').find({ id: user.id }).assign({
    taxEstimate: { ...user.taxEstimate, status: 'doubts', clientComment: comment }
  }).write();

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
    <div style="background:#0A0E5C;padding:20px 28px;"><div style="font-size:1.1rem;font-weight:700;color:#FFC107;">RETAUX</div><div style="font-size:1.15rem;font-weight:700;color:#fff;margin-top:4px;">Tax Estimate — Client has doubts</div></div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 12px;font-size:0.95rem;color:#374151;"><strong>${user.fullName || user.email}</strong> has questions about their tax estimate.</p>
      <p style="margin:0 0 4px;font-size:0.82rem;font-weight:700;color:#0A0E5C;">Email:</p><p style="margin:0 0 16px;font-size:0.9rem;color:#374151;">${user.email}</p>
      ${comment ? `<p style="margin:0 0 4px;font-size:0.82rem;font-weight:700;color:#0A0E5C;">Comment:</p><div style="background:#FFF8E1;border:1px solid #FDE68A;border-radius:6px;padding:12px 16px;font-size:0.9rem;color:#374151;">${comment}</div>` : '<p style="color:#6B7280;font-size:0.9rem;">No comment provided.</p>'}
    </div>
    <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">RETAUX · hola@retaux.com</div>
  </div>`;

  try {
    await sendMail({ to: 'hola@retaux.com', subject: `[RETAUX] Tax Estimate — dudas de ${user.fullName || user.email}`, html, text: `${user.fullName || user.email} (${user.email}) tiene dudas.\nComentario: ${comment || '(ninguno)'}` });
  } catch (e) { console.error('[TAX-ESTIMATE DOUBT]', e.message); }

  res.redirect('/dashboard');
});

module.exports = router;
