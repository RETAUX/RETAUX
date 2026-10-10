const express = require('express');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');

const router = express.Router();

const POINTS_PER_REFERRAL = 20; // AUD points per successful referral

router.get('/referrals', requireAuth, requireVerified, (req, res) => {
  const myReferrals = db.get('referrals')
    .filter({ referrerUserId: req.user.id })
    .value()
    .map(r => {
      const referredUser = db.get('users').find({ id: r.referredUserId }).value();
      return {
        ...r,
        referredName: referredUser ? referredUser.fullName : 'Usuario',
        referredEmail: referredUser ? referredUser.email : ''
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const paidCount     = myReferrals.filter(r => r.status === 'paid').length;
  const pendingCount  = myReferrals.filter(r => r.status === 'pending' || r.status === 'eligible').length;
  const totalPoints   = req.user.referralPoints || 0;
  const pendingPoints = pendingCount * POINTS_PER_REFERRAL;
  const paidPoints    = paidCount * POINTS_PER_REFERRAL;

  const refLink = `https://retaux.com/register?ref=${req.user.referralCode}`;

  res.render('referrals', {
    user: req.user,
    referrals: myReferrals,
    paidCount,
    pendingCount,
    totalPoints,
    pendingPoints,
    paidPoints,
    refLink,
    POINTS_PER_REFERRAL
  });
});

const RESERVED = ['ADMIN','RETAUX','FREE','GRATIS','PROMO','TEST','STAFF','SUPPORT','HELP','INFO','RTX','RETAX'];

router.post('/referrals/update-code', requireAuth, requireVerified, (req, res) => {
  const suffix = (req.body.suffix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (suffix.length < 3 || suffix.length > 10)
    return res.json({ ok: false, reason: 'length' });

  if (RESERVED.includes(suffix))
    return res.json({ ok: false, reason: 'reserved' });

  const newCode = `RTX-${suffix}`;

  // Verificar que no exista (excluyendo al propio usuario)
  const existing = db.get('users').find({ referralCode: newCode }).value();
  if (existing && existing.id !== req.user.id)
    return res.json({ ok: false, reason: 'taken' });

  db.get('users').find({ id: req.user.id }).assign({ referralCode: newCode }).write();
  res.json({ ok: true, code: newCode });
});

module.exports = router;
