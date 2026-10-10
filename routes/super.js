const express = require('express');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { genId } = require('../db/helpers');
const { sendSuperPaymentPendingNotification } = require('../lib/emails');

const router = express.Router();

const SUPER_PRICE_AUD = 250;

router.get('/super', requireAuth, requireVerified, (req, res) => {
  const existing = db.get('super_payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (existing) return res.redirect('/super/done');

  const pending = db.get('super_payments').find({ userId: req.user.id, status: 'pending_manual' }).value();
  if (pending) return res.redirect('/super/pending');

  res.render('payment/super-checkout', {
    user: req.user,
    priceAUD: SUPER_PRICE_AUD,
    paymentLink: process.env.SUPER_PAYMENT_LINK || '',
    error: req.query.error || null
  });
});

router.post('/super/submit', requireAuth, requireVerified, async (req, res) => {
  const existingPaid = db.get('super_payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (existingPaid) return res.redirect('/super/done');

  const existingPending = db.get('super_payments').find({ userId: req.user.id, status: 'pending_manual' }).value();
  if (existingPending) return res.redirect('/super/pending');

  db.get('super_payments').push({
    id: genId(),
    userId: req.user.id,
    status: 'pending_manual',
    amountCents: SUPER_PRICE_AUD * 100,
    method: 'manual',
    createdAt: new Date().toISOString()
  }).write();

  try {
    await sendSuperPaymentPendingNotification(req.user);
  } catch (e) { console.error('[SUPER] Email error:', e.message); }

  res.redirect('/super/pending');
});

router.get('/super/pending', requireAuth, requireVerified, (req, res) => {
  const paid = db.get('super_payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (paid) return res.redirect('/super/done');
  res.render('payment/super-pending', { user: req.user });
});

router.get('/super/done', requireAuth, requireVerified, (req, res) => {
  const paid = db.get('super_payments').find({ userId: req.user.id, status: 'paid' }).value();
  if (!paid) return res.redirect('/super');
  res.render('payment/super-done', { user: req.user, payment: paid });
});

module.exports = router;
module.exports.SUPER_PRICE_AUD = SUPER_PRICE_AUD;
