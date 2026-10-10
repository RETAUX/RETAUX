const express = require('express');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');

const router = express.Router();

router.get('/linking', requireAuth, requireVerified, (req, res) => {
  res.render('linking', {
    user: req.user,
    saved: req.query.saved === '1'
  });
});

router.post('/linking', requireAuth, requireVerified, (req, res) => {
  const { linkingCode } = req.body;
  const code = (linkingCode || '').trim();

  if (!code) {
    return res.redirect('/linking');
  }

  db.get('users')
    .find({ id: req.user.id })
    .assign({
      linkingCode: code,
      linkingStatus: 'submitted',
      linkingSubmittedAt: new Date().toISOString()
    })
    .write();

  res.redirect('/linking?saved=1');
});

module.exports = router;
