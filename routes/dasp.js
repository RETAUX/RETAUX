const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db      = require('../db/database');
const { genId } = require('../db/helpers');
const { requireAuth } = require('../middleware/auth');
const { UPLOAD_ROOT } = require('../middleware/upload');

const router = express.Router();

// Multer para tickets de avión — guarda en uploads/<userId>/dasp/
const daspStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, req.user.id, 'dasp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `ticket_${Date.now()}_${genId().slice(0,6)}${ext}`);
  }
});

const daspUpload = multer({
  storage: daspStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Página principal DASP ────────────────────────────────────────────────────

router.get('/dasp', requireAuth, (req, res) => {
  const existing = db.get('daspRequests').find({ userId: req.user.id }).value();
  const superPayment = db.get('super_payments').find({ userId: req.user.id }).value() || null;
  res.render('dasp', { user: req.user, existing: existing || null, superPayment, saved: req.query.saved === '1', error: null });
});

// ── Guardar solicitud DASP ───────────────────────────────────────────────────

router.post('/dasp', requireAuth, daspUpload.array('flightTickets', 10), (req, res) => {
  const {
    fullName, phone,
    passportNumber, passportCountry, dateOfBirth, departureDate, lastAustralianAddress,
    visaSubclass, visaExpiryDate,
    tfn,
    fundName, fundABN, fundUSI, memberNumber,
    bankRecipientName, bankName, bankCountry, bankSwift, bankAccount,
    notes
  } = req.body;

  const funds = [];
  const names = Array.isArray(fundName) ? fundName : [fundName];
  names.forEach((name, i) => {
    if (name && name.trim()) {
      funds.push({
        fundName:     name.trim(),
        fundABN:      (Array.isArray(fundABN)      ? fundABN[i]      : fundABN)      || '',
        fundUSI:      (Array.isArray(fundUSI)      ? fundUSI[i]      : fundUSI)      || '',
        memberNumber: (Array.isArray(memberNumber) ? memberNumber[i] : memberNumber) || '',
      });
    }
  });

  if (!fullName || !passportNumber || !passportCountry || !dateOfBirth || !departureDate) {
    const existing = db.get('daspRequests').find({ userId: req.user.id }).value();
    return res.render('dasp', { user: req.user, existing: existing || null, saved: false,
      error: 'Completá los campos obligatorios: nombre completo, pasaporte, fecha de nacimiento y fecha de salida de Australia.' });
  }

  // Archivos de tickets nuevos subidos en este POST
  const newTickets = (req.files || []).map(f => ({
    storedFilename: f.filename,
    originalName:   f.originalname,
    uploadedAt:     new Date().toISOString(),
  }));

  const existingReq = db.get('daspRequests').find({ userId: req.user.id });
  const prevTickets = existingReq.value()?.flightTickets || [];

  const data = {
    fullName:             fullName.trim(),
    phone:                (phone || '').trim(),
    passportNumber:       passportNumber.trim(),
    passportCountry:      passportCountry.trim(),
    dateOfBirth:          dateOfBirth.trim(),
    departureDate:        departureDate.trim(),
    lastAustralianAddress:(lastAustralianAddress || '').trim(),
    visaSubclass:         (visaSubclass || req.user.currentVisaSubclass || '').trim(),
    visaExpiryDate:       (visaExpiryDate || '').trim(),
    tfn:                  (tfn || req.user.tfn || '').trim(),
    funds,
    flightTickets:        [...prevTickets, ...newTickets],
    bankRecipientName:    (bankRecipientName || '').trim(),
    bankName:             (bankName || '').trim(),
    bankCountry:          (bankCountry || '').trim(),
    bankSwift:            (bankSwift || '').trim(),
    bankAccount:          (bankAccount || '').trim(),
    notes:                (notes || '').trim(),
    updatedAt:            new Date().toISOString(),
    status:               'pending_review',
  };

  if (existingReq.value()) {
    existingReq.assign(data).write();
  } else {
    db.get('daspRequests').push({
      id:        genId(),
      userId:    req.user.id,
      ...data,
      createdAt: new Date().toISOString(),
    }).write();
  }

  res.redirect('/dasp?saved=1');
});

module.exports = router;
