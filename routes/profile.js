const express = require('express');
const { requireAuth, requireVerified } = require('../middleware/auth');

const router = express.Router();

// /profile quedó reemplazado por /onboarding/personal (formulario único de datos de contacto).
router.get('/profile', requireAuth, requireVerified, (req, res) => {
  res.redirect('/onboarding/personal');
});

module.exports = router;
