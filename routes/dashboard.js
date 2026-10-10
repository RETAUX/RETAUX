const express = require('express')
const router = express.Router()
const db = require('../db/database')
const { userAuth } = require('../middleware/auth')

// GET /dashboard
router.get('/', userAuth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value()
  if (!user.verified) return res.redirect('/verify')
  if (!user.onboardingComplete) return res.redirect('/onboarding')
  if (!user.paymentComplete) return res.redirect('/payment')
  if (!user.consentSignedAt) return res.redirect('/consent')

  const appointment = db.get('appointments').find({ userId: user.id }).value()
  const referrals = db.get('referrals').filter({ referrerId: user.id }).value()
  const docs = db.get('documents').filter({ userId: user.id }).value()

  const refLink = `${process.env.BASE_URL}/register?ref=${user.referralCode}`

  res.render('dashboard/index', {
    user,
    appointment,
    referrals,
    docs,
    refLink,
    BASE_URL: process.env.BASE_URL,
    estimateFlash: req.query.estimate || null,
  })
})

// GET /linking — código ATO
router.get('/linking', userAuth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value()
  if (!user.paymentComplete) return res.redirect('/dashboard')
  res.render('dashboard/linking', { user, success: null, error: null })
})

// POST /linking
router.post('/linking', userAuth, (req, res) => {
  const { atoCode } = req.body
  const user = db.get('users').find({ id: req.user.id }).value()

  if (!atoCode || atoCode.trim().length < 4) {
    return res.render('dashboard/linking', { user, success: null, error: 'Ingresá un código válido.' })
  }

  db.get('users').find({ id: user.id }).assign({
    atoCode: atoCode.trim(),
    atoCodeSubmittedAt: new Date().toISOString(),
    atoLinkingStatus: 'code-received'
  }).write()

  const updatedUser = db.get('users').find({ id: user.id }).value()
  res.render('dashboard/linking', { user: updatedUser, success: 'Código enviado correctamente. Nos pondremos en contacto pronto.', error: null })
})

// GET /profile — editar datos personales
router.get('/profile', userAuth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value()
  res.render('dashboard/profile', { user, success: null, error: null })
})

// POST /profile
router.post('/profile', userAuth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value()
  const {
    phone, nationality, visaType, visaSubclass,
    address, tfn,
    bankName, bankBSB, bankAccount
  } = req.body

  if (!phone || !nationality || !visaType || !address) {
    return res.render('dashboard/profile', { user, success: null, error: 'Completá los campos obligatorios.' })
  }

  db.get('users').find({ id: user.id }).assign({
    profile: {
      ...user.profile,
      phone: phone.trim(),
      nationality: nationality.trim(),
      visaType,
      visaSubclass: visaSubclass || '',
      address: address.trim(),
      tfn: tfn ? tfn.trim() : user.profile.tfn,
      bankName: bankName ? bankName.trim() : user.profile.bankName,
      bankBSB: bankBSB ? bankBSB.trim() : user.profile.bankBSB,
      bankAccount: bankAccount ? bankAccount.trim() : user.profile.bankAccount
    }
  }).write()

  const updatedUser = db.get('users').find({ id: user.id }).value()
  res.render('dashboard/profile', { user: updatedUser, success: 'Datos actualizados correctamente.', error: null })
})

// POST /dashboard/tax-estimate/accept — cliente acepta estimación
router.post('/tax-estimate/accept', userAuth, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user || !user.taxEstimate) return res.redirect('/dashboard');

  const existingEst = user.taxEstimate || {};
  db.get('users').find({ id: user.id }).assign({
    taxEstimate: { ...existingEst, status: 'accepted', acceptedAt: new Date().toISOString() },
    taxReturnStage: 'issued',
  }).write();

  const est = db.get('users').find({ id: user.id }).value().taxEstimate;
  const fmt = v => (v !== null && v !== undefined) ? `$${Number(v).toFixed(2)}` : '—';
  const tfn = (user.profile && user.profile.tfn) ? user.profile.tfn : (user.tfn || '—');

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
    <div style="background:#0A0E5C;padding:20px 28px;">
      <div style="font-size:1.1rem;font-weight:700;color:#FFC107;letter-spacing:0.08em;">RETAUX</div>
      <div style="font-size:1.15rem;font-weight:700;color:#fff;margin-top:4px;">Tax Estimate Accepted</div>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;font-size:0.95rem;color:#374151;">The following client has <strong>accepted their tax estimate</strong>. Please proceed with lodgement.</p>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;margin-bottom:20px;">
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;width:40%;">Client Name</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${user.fullName || user.email}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">Email</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${user.email}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">TFN</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${tfn}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:600;background:#F3F4F6;">Accepted At</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${new Date(est.acceptedAt).toLocaleString('en-AU')}</td></tr>
      </table>
      <p style="margin:0 0 8px;font-size:0.82rem;font-weight:700;color:#0A0E5C;text-transform:uppercase;letter-spacing:0.06em;">ATO Estimate Breakdown</p>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;width:60%;border-bottom:1px solid #E5E7EB;">Taxable Income</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxableIncome)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Tax Payable</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxPayableOnTaxableIncome)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Low Income Tax Offset</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.lowIncomeOffset)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Private Health Insurance Offset</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.healthInsuranceOffset)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Other Offsets</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.otherOffsets)}</td></tr>
        <tr><td style="padding:7px 12px;background:#FFF8E1;font-weight:700;border-bottom:1px solid #FDE68A;">Total Offsets</td><td style="padding:7px 12px;border-bottom:1px solid #FDE68A;font-family:monospace;font-weight:700;">${fmt(est.totalOffsets)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Tax Withheld</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxWithheldSalary)}</td></tr>
        <tr><td style="padding:7px 12px;background:#F8FAFC;font-weight:600;border-bottom:1px solid #E5E7EB;">Other Credits</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.otherCredits)}</td></tr>
        <tr><td style="padding:7px 12px;background:#ECFDF5;font-weight:700;color:#065F46;font-size:1rem;">Estimated Refund</td><td style="padding:7px 12px;font-family:monospace;font-weight:700;font-size:1rem;color:#065F46;">${fmt(est.estimatedRefund)}</td></tr>
      </table>
    </div>
    <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">RETAUX · hola@retaux.com</div>
  </div>`;

  const notifyTo = user.estimateNotifiedTo || 'hishamcharbine@gmail.com';
  try {
    await sendMail({
      to: notifyTo,
      subject: `[RETAUX] Tax Estimate Accepted — ${user.fullName || user.email}`,
      html,
      text: `Client ${user.fullName || user.email} (TFN: ${tfn}) accepted their tax estimate. Estimated refund: ${fmt(est.estimatedRefund)}.`,
    });
  } catch (e) {
    console.error('[TAX-ESTIMATE ACCEPT EMAIL ERROR]', e.message);
  }

  res.render('dashboard/estimate-confirmed', { user });
});

// POST /dashboard/sign-declaration — cliente firma declaración ENPRESA
router.post('/sign-declaration', userAuth, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.redirect('/dashboard');

  const signedName = (req.body.signedName || '').trim();
  if (!signedName) return res.redirect('/dashboard?sign_error=name_required');

  const signedAt = new Date().toISOString();
  const dateStr  = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  db.get('users').find({ id: user.id }).assign({
    declarationSignedAt:   signedAt,
    declarationSignedName: signedName,
  }).write();

  // Construir formulario ENPRESA firmado y enviarlo al tax agent
  const taxAgentEmail = user.taxAgentEmail;
  if (taxAgentEmail) {
    try {
      const db2       = require('../db/database');
      const freshU    = db2.get('users').find({ id: user.id }).value();
      const allDocs   = db2.get('documents').filter({ userId: user.id }).value();
      const employers = freshU.employers || [];
      const tfn       = (freshU.profile && freshU.profile.tfn) ? freshU.profile.tfn : (freshU.tfn || null);
      const allFyProfiles = db2.get('taxYearProfiles').filter({ userId: user.id }).value()
        .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
      const clientFyProfile = allFyProfiles[0] || {};
      const dedSums = {};
      allDocs.forEach(d => {
        const CAT_MAP = { logbook:'D1', work_travel:'D2', work_expenses:'D3', training:'D4', certifications:'D5', tech_purchases:'D5', home_office:'D6', donation_receipts:'D9' };
        const code = d.adminDedCode || CAT_MAP[d.category];
        if (!code || !d.adminAmount) return;
        const amt = parseFloat(String(d.adminAmount || '').replace(',', '.')) || 0;
        if (!dedSums[code]) dedSums[code] = { total: 0 };
        dedSums[code].total = Math.round((dedSums[code].total + amt) * 100) / 100;
      });

      const { buildEnpresaFormHtml } = require('./admin');
      const enpresaHtml = buildEnpresaFormHtml({
        u: freshU, employers, tfn, clientFyProfile, dedSums, allDocs, dateStr,
        signature: { name: signedName, date: dateStr, signedAt },
      });

      await sendMail({
        to:      taxAgentEmail,
        cc:      'hola@retaux.com',
        subject: `[RETAUX] Signed Declaration — ${freshU.fullName || freshU.email}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:24px auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
          <div style="background:#0A0E5C;padding:20px 28px;">
            <div style="font-weight:700;color:#FFC107;font-size:1rem;">RETAUX</div>
            <div style="color:#fff;font-size:1.1rem;font-weight:700;margin-top:4px;">Client Declaration Signed</div>
          </div>
          <div style="padding:20px 28px;">
            <p style="margin:0 0 12px;color:#374151;">The client <strong>${freshU.fullName || freshU.email}</strong> has signed their ENPRESA Client Details Form declaration.</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
              <tr><td style="padding:7px 12px;font-weight:600;background:#F3F4F6;width:40%;">Signed Name</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;">${signedName}</td></tr>
              <tr><td style="padding:7px 12px;font-weight:600;background:#F3F4F6;">Date</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;">${dateStr}</td></tr>
              <tr><td style="padding:7px 12px;font-weight:600;background:#F3F4F6;">Timestamp</td><td style="padding:7px 12px;border-bottom:1px solid #E5E7EB;font-family:monospace;font-size:0.82rem;">${signedAt}</td></tr>
            </table>
            <p style="margin:16px 0 0;font-size:0.85rem;color:#6B7280;">The signed form is attached. Please forward to your supervisor for countersignature.</p>
          </div>
          <div style="padding:12px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.75rem;color:#9CA3AF;">RETAUX · hola@retaux.com</div>
        </div>`,
        text: `Client ${freshU.fullName || freshU.email} signed their declaration on ${dateStr}.`,
        attachments: [{
          name: `ENPRESA_Signed_${(freshU.fullName || freshU.id).replace(/\s+/g, '_')}_2025-26.html`,
          content: Buffer.from(enpresaHtml).toString('base64'),
        }],
      });
      console.log(`[DECLARATION] Firma enviada al agente: ${taxAgentEmail}`);
    } catch (e) {
      console.error('[DECLARATION] Error enviando firma:', e.message);
    }
  }

  res.redirect('/dashboard?declaration_signed=1');
});

// POST /dashboard/tax-estimate/doubt — cliente tiene dudas
router.post('/tax-estimate/doubt', userAuth, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user || !user.taxEstimate) return res.redirect('/dashboard');

  const comment = (req.body.comment || '').trim().slice(0, 1000);

  db.get('users').find({ id: user.id }).assign({
    'taxEstimate.status': 'doubts',
    'taxEstimate.clientComment': comment,
  }).write();

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
    <div style="background:#0A0E5C;padding:20px 28px;">
      <div style="font-size:1.1rem;font-weight:700;color:#FFC107;">RETAUX</div>
      <div style="font-size:1.15rem;font-weight:700;color:#fff;margin-top:4px;">Tax Estimate — Client has doubts</div>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 12px;font-size:0.95rem;color:#374151;"><strong>${user.fullName || user.email}</strong> has questions about their tax estimate.</p>
      <p style="margin:0 0 4px;font-size:0.82rem;font-weight:700;color:#0A0E5C;">Email:</p>
      <p style="margin:0 0 16px;font-size:0.9rem;color:#374151;">${user.email}</p>
      ${comment ? `<p style="margin:0 0 4px;font-size:0.82rem;font-weight:700;color:#0A0E5C;">Client comment:</p><div style="background:#FFF8E1;border:1px solid #FDE68A;border-radius:6px;padding:12px 16px;font-size:0.9rem;color:#374151;">${comment}</div>` : '<p style="color:#6B7280;font-size:0.9rem;">No comment provided.</p>'}
    </div>
    <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">RETAUX · hola@retaux.com</div>
  </div>`;

  try {
    await sendMail({
      to: 'hola@retaux.com',
      subject: `[RETAUX] Tax Estimate — dudas de ${user.fullName || user.email}`,
      html,
      text: `${user.fullName || user.email} (${user.email}) tiene dudas sobre su estimación.\n\nComentario: ${comment || '(ninguno)'}`,
    });
  } catch (e) {
    console.error('[TAX-ESTIMATE DOUBT EMAIL ERROR]', e.message);
  }

  res.redirect('/dashboard?estimate=doubts');
});

module.exports = router
