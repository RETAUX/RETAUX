const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { genId, getFinancialYears } = require('../db/helpers');
const { upload, UPLOAD_ROOT, compressImage, IMAGE_EXTS } = require('../middleware/upload');
const DOCUMENT_CATEGORIES = require('../db/documentCategories');

const router = express.Router();

const STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function isValidYear(year) {
  return getFinancialYears(6).includes(year);
}

function getOrCreateProfile(userId, taxYear) {
  let profile = db.get('taxYearProfiles').find({ userId, taxYear }).value();
  if (!profile) {
    profile = {
      id: genId(),
      userId,
      taxYear,
      jobsDescription: '',
      workLocations: '',
      hasCar: false,
      carBrand: '', carModel: '', carYear: '', carPlate: '', carState: '',
      hasHealthInsurance: false,
      healthProvider: '', healthMemberNumber: '', healthStartDate: '', healthEndDate: '', healthPlanType: '',
      updatedAt: new Date().toISOString()
    };
    db.get('taxYearProfiles').push(profile).write();
  }
  return profile;
}

router.get('/tax-year/:taxYear', requireAuth, requireVerified, (req, res) => {
  const { taxYear } = req.params;
  if (!isValidYear(taxYear)) return res.redirect('/dashboard');

  const profile = getOrCreateProfile(req.user.id, taxYear);
  const documents = db.get('documents')
    .filter({ userId: req.user.id, taxYear })
    .value();

  res.render('tax-year', {
    user: req.user,
    taxYear,
    financialYears: getFinancialYears(),
    profile,
    states: STATES,
    categories: DOCUMENT_CATEGORIES,
    documents,
    saved: req.query.saved === '1',
    uploadError: req.query.uploadError || null
  });
});

router.post('/tax-year/:taxYear/info', requireAuth, requireVerified, (req, res) => {
  const { taxYear } = req.params;
  if (!isValidYear(taxYear)) return res.redirect('/dashboard');

  const b = req.body;
  const updates = {
    jobsDescription: (b.jobsDescription || '').trim(),
    workLocations: (b.workLocations || '').trim(),
    hasCar: b.hasCar === 'on',
    carBrand: (b.carBrand || '').trim(),
    carModel: (b.carModel || '').trim(),
    carYear: (b.carYear || '').trim(),
    carPlate: (b.carPlate || '').trim(),
    carState: b.carState || '',
    hasHealthInsurance: b.hasHealthInsurance === 'on',
    healthProvider: (b.healthProvider || '').trim(),
    healthMemberNumber: (b.healthMemberNumber || '').trim(),
    healthStartDate: b.healthStartDate || '',
    healthEndDate: b.healthEndDate || '',
    healthPlanType: (b.healthPlanType || '').trim(),
    updatedAt: new Date().toISOString()
  };

  getOrCreateProfile(req.user.id, taxYear);
  db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).assign(updates).write();

  res.redirect(`/tax-year/${taxYear}?saved=1`);
});

router.post('/tax-year/:taxYear/upload', requireAuth, requireVerified, (req, res) => {
  const { taxYear } = req.params;
  if (!isValidYear(taxYear)) return res.redirect('/dashboard');

  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      return res.redirect(`/tax-year/${taxYear}?uploadError=${encodeURIComponent(err.message)}`);
    }

    const category = req.body.category;
    const validCategory = DOCUMENT_CATEGORIES.find(c => c.id === category);
    if (!validCategory || !req.files || req.files.length === 0) {
      return res.redirect(`/tax-year/${taxYear}?uploadError=${encodeURIComponent('Seleccioná una categoría y al menos un archivo.')}`);
    }

    const savePromises = req.files.map(async file => {
      const ext = path.extname(file.originalname).toLowerCase();
      let finalSize = file.size;
      if (IMAGE_EXTS.has(ext)) {
        finalSize = await compressImage(file.path);
      }
      db.get('documents').push({
        id: genId(),
        userId: req.user.id,
        taxYear,
        category,
        originalName: file.originalname,
        storedFilename: file.filename,
        sizeBytes: finalSize,
        uploadedAt: new Date().toISOString()
      }).write();
    });

    Promise.all(savePromises).then(() => {
      res.redirect(`/tax-year/${taxYear}?saved=1`);
    }).catch(e => {
      console.error('[UPLOAD] Error post-compresión:', e.message);
      res.redirect(`/tax-year/${taxYear}?saved=1`);
    });
  });
});

router.get('/tax-year/:taxYear/document/:docId/download', requireAuth, requireVerified, (req, res) => {
  const { taxYear, docId } = req.params;
  const doc = db.get('documents').find({ id: docId, userId: req.user.id, taxYear }).value();
  if (!doc) return res.status(404).send('Documento no encontrado.');

  const filePath = path.join(UPLOAD_ROOT, req.user.id, taxYear, doc.storedFilename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado.');

  res.download(filePath, doc.originalName);
});

router.post('/tax-year/:taxYear/document/:docId/delete', requireAuth, requireVerified, (req, res) => {
  const { taxYear, docId } = req.params;
  const doc = db.get('documents').find({ id: docId, userId: req.user.id, taxYear }).value();
  if (doc) {
    const filePath = path.join(UPLOAD_ROOT, req.user.id, taxYear, doc.storedFilename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.get('documents').remove({ id: docId }).write();
  }
  res.redirect(`/tax-year/${taxYear}?saved=1`);
});

module.exports = router;
