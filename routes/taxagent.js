const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const db      = require('../db/database');
const { JWT_SECRET } = require('../middleware/auth');
const { genId } = require('../db/helpers');

// ── Middleware: only taxagent role ────────────────────────────────────────────

function requireTaxAgent(req, res, next) {
  const token = req.cookies.retaux_token;
  if (!token) return res.redirect('/taxagent/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.get('users').find({ id: payload.id }).value();
    if (!user || user.role !== 'taxagent') return res.redirect('/taxagent/login');
    req.taxAgent = user;
    res.locals.taxAgent = user;
    next();
  } catch (e) { res.redirect('/taxagent/login'); }
}

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.cookies.retaux_token) {
    try {
      const p = jwt.verify(req.cookies.retaux_token, JWT_SECRET);
      const u = db.get('users').find({ id: p.id }).value();
      if (u && u.role === 'taxagent') return res.redirect('/taxagent');
    } catch(e) {}
  }
  res.render('taxagent/login', { error: null });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  const user = db.get('users').find({ email }).value();
  if (!user || user.role !== 'taxagent' || !bcrypt.compareSync(password, user.pinHash))
    return res.render('taxagent/login', { error: 'Incorrect email or password.' });
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('retaux_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12*60*60*1000 });
  res.redirect('/taxagent');
});

router.get('/logout', (req, res) => {
  res.clearCookie('retaux_token');
  res.redirect('/taxagent/login');
});

// ── Main dashboard ─────────────────────────────────────────────────────────────

router.get('/', requireTaxAgent, (req, res) => {
  const now = Date.now();
  const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

  const clients = db.get('users')
    .filter(u => u.taxAgentSentAt)
    .map(u => {
      const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value() || {};
      const daysSince = u.taxAgentSentAt ? Math.floor((now - new Date(u.taxAgentSentAt)) / (1000*60*60*24)) : 0;
      const overdue = daysSince > 5 && !u.taxAgentGrossIncome && !u.taxAgentSubmittedAt;
      // ABN: puede estar en abn directo o en el primer employer
      const abn = u.abn || (u.employers && u.employers.length ? (u.employers[0].abn || '') : '');
      return {
        id:           u.id,
        fullName:     u.fullName || u.email,
        tfn:          u.tfn || '',
        abn:          abn,
        occupation:   u.occupation || '',
        sentAt:       u.taxAgentSentAt ? new Date(u.taxAgentSentAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—',
        taxYear:      payment.taxYear || '—',
        grossIncome:  u.taxAgentGrossIncome || '',
        returnAmt:    u.taxAgentReturnAmt   || '',
        notes:        u.taxAgentNotes       || '',
        hasReport:    !!u.taxAgentReportHtml,
        submitted:    !!u.taxAgentSubmittedAt,
        submittedAt:  u.taxAgentSubmittedAt ? new Date(u.taxAgentSubmittedAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : null,
        stage:        u.taxReturnStage || 'processing',
        overdue,
        daysSince,
      };
    })
    .sortBy(c => c.sentAt)
    .reverse()
    .value();

  res.render('taxagent/dashboard', { clients, agent: req.taxAgent });
});

// ── Save row data (inline edit) ───────────────────────────────────────────────

router.post('/client/:id/save', requireTaxAgent, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u || !u.taxAgentSentAt) return res.status(404).json({ ok: false });

  const update = {};
  if (req.body.occupation  !== undefined) update.occupation          = req.body.occupation;
  if (req.body.grossIncome !== undefined) update.taxAgentGrossIncome = req.body.grossIncome;
  if (req.body.returnAmt   !== undefined) update.taxAgentReturnAmt   = req.body.returnAmt;
  if (req.body.notes       !== undefined) update.taxAgentNotes       = req.body.notes;

  db.get('users').find({ id: u.id }).assign(update).write();
  res.json({ ok: true });
});

// ── Read-only client report ───────────────────────────────────────────────────

router.get('/client/:id/report', requireTaxAgent, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u || !u.taxAgentSentAt) return res.status(403).send('Client not available.');
  if (!u.taxAgentReportHtml) return res.status(404).send('Report not yet generated. Ask admin to re-send the client.');
  res.send(u.taxAgentReportHtml);
});

// ── Mark client as submitted to ATO ──────────────────────────────────────────

router.post('/client/:id/submit', requireTaxAgent, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u || !u.taxAgentSentAt) return res.status(404).json({ ok: false });
  const already = !!u.taxAgentSubmittedAt;
  if (!already) {
    db.get('users').find({ id: u.id }).assign({
      taxAgentSubmittedAt: new Date().toISOString(),
      taxReturnStage: 'issued'
    }).write();
  }
  res.json({ ok: true, submittedAt: u.taxAgentSubmittedAt || new Date().toISOString() });
});

module.exports = { router, requireTaxAgent };
