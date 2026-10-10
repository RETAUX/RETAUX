const express = require('express');
const db = require('../db/database');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { genId, getFinancialYears } = require('../db/helpers');
const { upload } = require('../middleware/upload');
const DOCUMENT_CATEGORIES = require('../db/documentCategories');
const path = require('path');
const fs = require('fs');
const { extractFromPdf, buildEmployersFromDocs } = require('../lib/payslipExtractor');

const router = express.Router();

// Categorías que NO se validan por fecha (tienen lógica propia o no tienen fecha relevante)
const NO_DATE_CHECK_CATS = new Set(['payslips', 'selfie_id', 'bank_statement', 'abn_income']);

/**
 * Extrae la(s) fecha(s) de un archivo usando:
 * 1. Regex sobre texto (PDFs con texto nativo)
 * 2. Claude Vision (imágenes y PDFs escaneados)
 * Devuelve array de Date | [] si no se pudo detectar.
 */
async function extractDatesFromFile(filePath, ext) {
  const dateRegex = /\b([0-3]?\d)[\/\-\.]([01]?\d)[\/\-\.](\d{2,4})\b/g;

  function parseDateParts(d, m, y) {
    if (y.length === 2) y = '20' + y;
    const year = parseInt(y), month = parseInt(m) - 1, day = parseInt(d);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    // Ignorar fechas absurdas (antes de 2010 o más de 2 años en el futuro)
    if (year < 2010 || year > new Date().getFullYear() + 2) return null;
    return date;
  }

  function extractDatesFromText(text) {
    const dates = [];
    let m;
    while ((m = dateRegex.exec(text)) !== null) {
      const d = parseDateParts(m[1], m[2], m[3]);
      if (d) dates.push(d);
    }
    dateRegex.lastIndex = 0;
    return dates;
  }

  // Paso 1: texto nativo (PDF)
  if (ext === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      const text = data.text || '';
      if (text.length > 20) {
        const dates = extractDatesFromText(text);
        if (dates.length > 0) return dates;
      }
    } catch (_) {}
  }

  // Paso 2: Claude Vision (imágenes + PDFs escaneados)
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return [];

  try {
    const fileBuf = fs.readFileSync(filePath);
    function detectMime(buf) {
      if (buf[0]===0xFF && buf[1]===0xD8) return 'image/jpeg';
      if (buf[0]===0x89 && buf[1]===0x50) return 'image/png';
      if (buf[0]===0x52 && buf[1]===0x49) return 'image/webp';
      if (buf[0]===0x25 && buf[1]===0x50 && buf[2]===0x44 && buf[3]===0x46) return 'application/pdf';
      return null;
    }
    const detectedMime = detectMime(fileBuf) || (
      ['jpg','jpeg'].includes(ext) ? 'image/jpeg' :
      ext === 'png' ? 'image/png' :
      ext === 'webp' ? 'image/webp' :
      ext === 'pdf' ? 'application/pdf' : null
    );
    if (!detectedMime) return [];

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: ANTHROPIC_KEY });
    const isPdf = detectedMime === 'application/pdf';
    const source = { type: 'base64', media_type: detectedMime, data: fileBuf.toString('base64') };

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          { type: isPdf ? 'document' : 'image', source },
          { type: 'text', text: 'List ALL dates visible in this document in DD/MM/YYYY format. Reply ONLY as JSON array of strings, e.g. ["15/03/2025","30/06/2025"]. If no dates found reply [].' }
        ]
      }]
    });

    const raw = (message.content[0].text || '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    const dates = [];
    for (const s of arr) {
      const parts = s.split('/');
      if (parts.length === 3) {
        const d = parseDateParts(parts[0], parts[1], parts[2]);
        if (d) dates.push(d);
      }
    }
    return dates;
  } catch (_) {
    return [];
  }
}

/**
 * Verifica si alguna fecha del documento cae dentro del año fiscal.
 * taxYear: '2025-26'  →  start: 2025-07-01, end: 2026-06-30
 * Retorna: 'ok' | 'out_of_range' | 'no_date'
 */
function checkFiscalYear(dates, taxYear) {
  if (!dates || dates.length === 0) return 'no_date';
  const parts = taxYear.split('-');
  const startYear = parseInt(parts[0]);
  const endYear   = parts[1].length === 2 ? 2000 + parseInt(parts[1]) : parseInt(parts[1]);
  const fyStart   = new Date(startYear, 6, 1);   // 1 July start year
  const fyEnd     = new Date(endYear,   5, 30);  // 30 June end year
  const inRange   = dates.some(d => d >= fyStart && d <= fyEnd);
  return inRange ? 'ok' : 'out_of_range';
}

function recomputeEmployers(userId) {
  const docs = db.get('documents').filter({ userId, category: 'payslips' }).value();
  const employers = buildEmployersFromDocs(docs);
  db.get('users').find({ id: userId }).assign({ employers }).write();
}

const VISA_OPTIONS = [
  'Working Holiday Visa (subclass 417)',
  'Work and Holiday Visa (subclass 462)',
  'Student Visa (subclass 500)',
  'Temporary Graduate Visa (subclass 485)',
  'Bridging Visa (COVID-19 related)',
  'Permanent Resident / Citizen',
  'Other'
];
const STATES = ['ACT','NSW','NT','QLD','SA','TAS','VIC','WA'];

// Step 1 — Personal data
router.get('/onboarding/personal', requireAuth, requireVerified, (req, res) => {
  const selfieDoc        = db.get('documents').find({ userId: req.user.id, category: 'selfie_id' }).value();
  const bankStatementDoc = db.get('documents').find({ userId: req.user.id, category: 'bank_statement' }).value();
  res.render('onboarding/personal', {
    user: req.user,
    GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY || '',
    saved: req.query.saved === '1',
    error: null,
    selfieDoc:        selfieDoc        || null,
    bankStatementDoc: bankStatementDoc || null,
  });
});

// Selfie + ID upload
router.post('/onboarding/personal/selfie', requireAuth, requireVerified, (req, res) => {
  upload.single('selfie')(req, res, (err) => {
    if (err) return res.redirect('/onboarding/personal?error=' + encodeURIComponent(err.message));
    if (!req.file) return res.redirect('/onboarding/personal?error=no_file');
    // Eliminar selfie anterior si existe
    const existing = db.get('documents').find({ userId: req.user.id, category: 'selfie_id' }).value();
    if (existing) {
      const oldPath = path.join(__dirname, '..', 'uploads', req.user.id, existing.storedFilename);
      try { require('fs').unlinkSync(oldPath); } catch(e) {}
      db.get('documents').remove({ userId: req.user.id, category: 'selfie_id' }).write();
    }
    db.get('documents').push({
      id: genId(), userId: req.user.id, category: 'selfie_id',
      originalName: req.file.originalname, storedFilename: req.file.filename,
      taxYear: 'general', sizeBytes: req.file.size, uploadedAt: new Date().toISOString()
    }).write();
    res.redirect('/onboarding/personal?saved=1');
  });
});

router.post('/onboarding/personal', requireAuth, requireVerified, (req, res) => {
  upload.fields([{ name: 'selfie', maxCount: 1 }, { name: 'bankStatement', maxCount: 1 }])(req, res, (uploadErr) => {
    // Si hubo error de upload (tamaño, tipo) lo ignoramos — los datos igual se guardan
    const selfieFile = req.files && req.files['selfie'] && req.files['selfie'][0];
    const bankStatementFile = req.files && req.files['bankStatement'] && req.files['bankStatement'][0];

    if (selfieFile) {
      const existing = db.get('documents').find({ userId: req.user.id, category: 'selfie_id' }).value();
      if (existing) {
        try { fs.unlinkSync(path.join(__dirname, '..', 'uploads', req.user.id, existing.storedFilename)); } catch(e) {}
        db.get('documents').remove({ userId: req.user.id, category: 'selfie_id' }).write();
      }
      db.get('documents').push({
        id: genId(), userId: req.user.id, category: 'selfie_id',
        originalName: selfieFile.originalname, storedFilename: selfieFile.filename,
        taxYear: 'general', sizeBytes: selfieFile.size, uploadedAt: new Date().toISOString()
      }).write();
    }

    if (bankStatementFile) {
      const existing = db.get('documents').find({ userId: req.user.id, category: 'bank_statement' }).value();
      if (existing) {
        try { fs.unlinkSync(path.join(__dirname, '..', 'uploads', req.user.id, 'general', existing.storedFilename)); } catch(e) {}
        db.get('documents').remove({ userId: req.user.id, category: 'bank_statement' }).write();
      }
      db.get('documents').push({
        id: genId(), userId: req.user.id, category: 'bank_statement',
        originalName: bankStatementFile.originalname, storedFilename: bankStatementFile.filename,
        taxYear: 'general', sizeBytes: bankStatementFile.size, uploadedAt: new Date().toISOString()
      }).write();
    }

    const b = req.body;
    const fullName = (b.fullName || '').trim();
    const currentAddress = (b.currentAddress || '').trim();
    const birthDate = (b.birthDate || '').trim();
    const tfn = (b.tfn || '').replace(/\s/g, '').trim();
    const abn = (b.abn || '').replace(/\s/g, '').trim();
    const phone = (b.phone || '').trim();
    const phoneWhatsapp = b.phoneWhatsapp === '1';
    const bankBSB = (b.bankBSB || '').replace(/[^0-9-]/g, '').trim();
    const bankAccount = (b.bankAccount || '').replace(/\D/g, '').trim();
    const bankAccountName = (b.bankAccountName || '').trim();
    const bankInstitution = (b.bankInstitution || '').trim();
    const firstTimeClaiming = b.firstTimeClaiming || null;
    const strField = (v) => (Array.isArray(v) ? v[0] : (v || '')).trim();
    const occupation = strField(b.occupation) || null;
    const nationality = strField(b.nationality) || null;
    const visaType = strField(b.visaType) || null;
    const currentVisaSubclass = strField(b.currentVisaSubclass) || null;
    const visaStartDate = strField(b.visaStartDate) || null;
    const visaEndDate = strField(b.visaEndDate) || null;
    const taxResidencyStatus = strField(b.taxResidencyStatus) || null;
    const isAustralianResident = strField(b.isAustralianResident) || null;
    const selfieDoc        = db.get('documents').find({ userId: req.user.id, category: 'selfie_id' }).value();
    const bankStatementDoc = db.get('documents').find({ userId: req.user.id, category: 'bank_statement' }).value();

    if (!fullName || !currentAddress || !occupation) {
      return res.render('onboarding/personal', {
        user: { ...req.user, fullName, currentAddress, occupation },
        GOOGLE_MAPS_KEY: process.env.GOOGLE_MAPS_KEY || '',
        saved: false,
        error: 'Por favor completá todos los campos obligatorios, incluyendo la ocupación.',
        selfieDoc:        selfieDoc        || null,
        bankStatementDoc: bankStatementDoc || null,
      });
    }

    db.get('users').find({ id: req.user.id }).assign({
      fullName,
      currentAddress,
      birthDate,
      phone,
      phoneWhatsapp,
      bankBSB,
      bankAccount,
      bankAccountName,
      bankInstitution,
      firstTimeClaiming,
      occupation,
      nationality,
      visaType,
      currentVisaSubclass,
      visaStartDate,
      visaEndDate,
      taxResidencyStatus,
      isAustralianResident,
      onboardingStep: 'documents',
      abn: abn || req.user.abn || '',
      profile: { ...(req.user.profile || {}), tfn },
      updatedAt: new Date().toISOString()
    }).write();

    res.redirect('/onboarding/personal?saved=1');
  }); // cierra upload.single
});

// Step 2 — Documents
router.get('/onboarding/documents', requireAuth, requireVerified, (req, res) => {
  const availableYears = ['2025-26', '2024-25', '2023-24', '2022-23'];
  const DEFAULT_YEAR = '2025-26';
  const requestedYear = req.query.year;
  const taxYear = availableYears.includes(requestedYear) ? requestedYear : DEFAULT_YEAR;

  const documents = db.get('documents').filter({ userId: req.user.id, taxYear }).value();
  const profile = db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).value() || {};

  // Contar documentos por año para mostrar badges en los tabs
  const docCountByYear = {};
  availableYears.forEach(y => {
    docCountByYear[y] = db.get('documents').filter({ userId: req.user.id, taxYear: y }).size().value();
  });

  const alreadyPaid = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
  res.render('onboarding/documents', {
    user: req.user,
    taxYear,
    availableYears,
    docCountByYear,
    categories: DOCUMENT_CATEGORIES,
    documents,
    profile,
    states: STATES,
    uploadError: req.query.uploadError || null,
    saved: req.query.saved === '1',
    tfnError: req.query.error === 'tfn',
    dateWarning: req.query.dateWarning || null,
    alreadyPaid,
  });
});

// Autosave — called via fetch, returns JSON
router.post('/onboarding/documents/autosave', requireAuth, requireVerified, (req, res) => {
  const availableYears = getFinancialYears(4);
  const taxYear = availableYears.includes(req.body.taxYear) ? req.body.taxYear : availableYears[0];
  const b = req.body;
  const existing = db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).value();
  const updates = {
    userId: req.user.id, taxYear,
    jobsData: (b.jobsData || '').trim(),
    hasCar: b.hasCar === '1' || b.hasCar === 'on',
    carBrand: (b.carBrand||'').trim(), carModel: (b.carModel||'').trim(),
    carYear: (b.carYear||'').trim(), carPlate: (b.carPlate||'').trim(), carState: b.carState||'',
    carPurchasePrice: b.carPurchasePrice !== '' && b.carPurchasePrice != null ? Number(b.carPurchasePrice) : null,
    carWorkKm: b.carWorkKm !== '' && b.carWorkKm != null ? parseInt(b.carWorkKm) || 0 : null,
    hasHealthInsurance: b.hasHealthInsurance === '1' || b.hasHealthInsurance === 'on',
    healthProvider: (b.healthProvider||'').trim(), healthMemberNumber: (b.healthMemberNumber||'').trim(),
    healthStartDate: b.healthStartDate||'', healthEndDate: b.healthEndDate||'',
    healthPlanType: (b.healthPlanType||'').trim(),
    // D1 se calcula automáticamente desde km × $0.88; si no hay km se usa el valor manual
    ded_d1: (() => { const km = parseInt(b.carWorkKm) || 0; return km > 0 ? Math.round(km * 0.88 * 100) / 100 : (b.ded_d1 !== '' && b.ded_d1 != null ? Number(b.ded_d1) : null); })(),
    ded_d2: b.ded_d2 ? Number(b.ded_d2) : null,
    ded_d3: b.ded_d3 !== '' && b.ded_d3 != null ? Number(b.ded_d3) : null,
    ded_d4: b.ded_d4 ? Number(b.ded_d4) : null,
    ded_d5: b.ded_d5 ? Number(b.ded_d5) : null,
    ded_d6: b.ded_d6 ? Number(b.ded_d6) : null,
    ded_d9: b.ded_d9 ? Number(b.ded_d9) : null,
    ded_d10: b.ded_d10 ? Number(b.ded_d10) : null,
    updatedAt: new Date().toISOString()
  };
  if (existing) {
    db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).assign(updates).write();
  } else {
    db.get('taxYearProfiles').push({ id: genId(), ...updates }).write();
  }
  res.json({ ok: true, savedAt: updates.updatedAt });
});

router.post('/onboarding/documents/info', requireAuth, requireVerified, (req, res) => {
  const availableYears = getFinancialYears(4);
  const taxYear = availableYears.includes(req.body.taxYear) ? req.body.taxYear : availableYears[0];
  const b = req.body;
  const existing = db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).value();
  const updates = {
    userId: req.user.id, taxYear,
    jobsData: (b.jobsData||'').trim(),
    jobsDescription: (b.jobsDescription||'').trim(),
    workLocations: (b.workLocations||'').trim(),
    hasCar: b.hasCar === '1' || b.hasCar === 'on',
    carBrand: (b.carBrand||'').trim(), carModel: (b.carModel||'').trim(),
    carYear: (b.carYear||'').trim(), carPlate: (b.carPlate||'').trim(), carState: b.carState||'',
    carPurchasePrice: b.carPurchasePrice !== '' && b.carPurchasePrice != null ? Number(b.carPurchasePrice) : null,
    carWorkKm: b.carWorkKm !== '' && b.carWorkKm != null ? parseInt(b.carWorkKm) || 0 : null,
    hasHealthInsurance: b.hasHealthInsurance === '1' || b.hasHealthInsurance === 'on',
    healthProvider: (b.healthProvider||'').trim(), healthMemberNumber: (b.healthMemberNumber||'').trim(),
    healthStartDate: b.healthStartDate||'', healthEndDate: b.healthEndDate||'',
    healthPlanType: (b.healthPlanType||'').trim(),
    // D1 se calcula automáticamente desde km × $0.88; si no hay km se usa el valor manual
    ded_d1: (() => { const km = parseInt(b.carWorkKm) || 0; return km > 0 ? Math.round(km * 0.88 * 100) / 100 : (b.ded_d1 !== '' && b.ded_d1 != null ? Number(b.ded_d1) : null); })(),
    updatedAt: new Date().toISOString()
  };

  if (existing) {
    db.get('taxYearProfiles').find({ userId: req.user.id, taxYear }).assign(updates).write();
  } else {
    db.get('taxYearProfiles').push({ id: genId(), ...updates }).write();
  }

  db.get('users').find({ id: req.user.id }).assign({ onboardingStep: 'documents' }).write();
  res.redirect('/onboarding/documents?saved=1&year=' + taxYear);
});

// Delete document — returns JSON so the page doesn't reload
router.post('/onboarding/documents/delete', requireAuth, requireVerified, (req, res) => {
  const { docId } = req.body;
  const doc = db.get('documents').find({ id: docId, userId: req.user.id }).value();
  if (doc) {
    try {
      const filePath = path.join(__dirname, '..', 'uploads', req.user.id, doc.category, doc.storedFilename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
    db.get('documents').remove({ id: docId, userId: req.user.id }).write();
    if (doc.category === 'payslips') recomputeEmployers(req.user.id);
    const isPaidDel = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
    if (isPaidDel) db.get('users').find({ id: req.user.id }).assign({ lastModifiedByClientAt: new Date().toISOString() }).write();
  }
  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers['accept'] === 'application/json') {
    return res.json({ ok: true });
  }
  res.redirect('/onboarding/documents?saved=1');
});

// Replace document (delete old + upload new)
router.post('/onboarding/documents/replace', requireAuth, requireVerified, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.redirect(`/onboarding/documents?uploadError=${encodeURIComponent(err.message)}`);
    const { docId } = req.body;
    const doc = db.get('documents').find({ id: docId, userId: req.user.id }).value();
    if (doc && req.file) {
      try {
        const oldPath = path.join(__dirname, '..', 'uploads', req.user.id, doc.category, doc.storedFilename);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (e) {}
      const updates = {
        originalName: req.file.originalname,
        storedFilename: req.file.filename,
        sizeBytes: req.file.size,
        uploadedAt: new Date().toISOString()
      };
      if (doc.category === 'payslips' && req.file.mimetype === 'application/pdf') {
        updates.extracted = await extractFromPdf(req.file.path);
      }
      db.get('documents').find({ id: docId, userId: req.user.id }).assign(updates).write();
      if (doc.category === 'payslips') recomputeEmployers(req.user.id);
      const isPaidRep = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
      if (isPaidRep) db.get('users').find({ id: req.user.id }).assign({ lastModifiedByClientAt: new Date().toISOString() }).write();
    }
    res.redirect('/onboarding/documents?saved=1');
  });
});

router.post('/onboarding/documents/upload', requireAuth, requireVerified, (req, res) => {
  const availableYears = ['2025-26', '2024-25', '2023-24', '2022-23'];
  upload.array('files', 10)(req, res, async (err) => {
    if (err) return res.redirect(`/onboarding/documents?uploadError=${encodeURIComponent(err.message)}`);
    const rb = req.body || {};
    const taxYear = availableYears.includes(rb.taxYear) ? rb.taxYear : '2025-26';
    const category = rb.category;
    const validCat = DOCUMENT_CATEGORIES.find(c => c.id === category);
    if (!validCat || !req.files || !req.files.length)
      return res.redirect('/onboarding/documents?uploadError=' + encodeURIComponent('Seleccioná categoría y archivo.'));

    const skipped = [];   // archivos rechazados por estar fuera del año fiscal
    const unverified = []; // archivos sin fecha detectada

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');

      // Validación de año fiscal (solo categorías que aplica)
      if (!NO_DATE_CHECK_CATS.has(category)) {
        const dates = await extractDatesFromFile(file.path, ext);
        const check = checkFiscalYear(dates, taxYear);

        if (check === 'out_of_range') {
          // Borrar archivo del disco y no guardar en DB
          try { fs.unlinkSync(file.path); } catch (_) {}
          skipped.push(file.originalname);
          continue;
        }

        if (check === 'no_date') {
          unverified.push(file.originalname);
          // Se guarda igual — el admin revisará
        }
      }

      const docEntry = {
        id: genId(), userId: req.user.id, taxYear, category,
        originalName: file.originalname, storedFilename: file.filename,
        sizeBytes: file.size, uploadedAt: new Date().toISOString(),
        dateVerified: NO_DATE_CHECK_CATS.has(category) ? null : (unverified.includes(file.originalname) ? 'unverified' : 'ok'),
      };
      if (category === 'payslips' && file.mimetype === 'application/pdf') {
        docEntry.extracted = await extractFromPdf(file.path);
      }
      db.get('documents').push(docEntry).write();
    }

    if (category === 'payslips') recomputeEmployers(req.user.id);
    const isPaid = !!db.get('payments').find({ userId: req.user.id, status: 'paid' }).value();
    if (isPaid) db.get('users').find({ id: req.user.id }).assign({ lastModifiedByClientAt: new Date().toISOString() }).write();

    // Armar query string de respuesta
    const params = new URLSearchParams({ year: taxYear });
    if (skipped.length > 0 && unverified.length === 0) {
      params.set('uploadError', `Archivo(s) rechazado(s): ${skipped.join(', ')} — la fecha del documento está fuera del año fiscal ${taxYear} (01/07/${taxYear.split('-')[0]} – 30/06/${2000 + parseInt(taxYear.split('-')[1])}).`);
    } else if (skipped.length > 0 && unverified.length > 0) {
      params.set('uploadError', `Rechazado(s): ${skipped.join(', ')} — fuera del año fiscal ${taxYear}. | Sin fecha detectada (el equipo lo revisará): ${unverified.join(', ')}.`);
    } else if (skipped.length === 0 && unverified.length > 0) {
      params.set('saved', '1');
      params.set('dateWarning', unverified.join(', '));
    } else {
      params.set('saved', '1');
    }
    res.redirect('/onboarding/documents?' + params.toString());
  });
});

// myGov guide
router.get('/onboarding/mygov-guide', requireAuth, requireVerified, (req, res) => {
  res.render('onboarding/mygov-guide', { user: req.user });
});

// Step 3 — Confirm (goes to payment)
router.post('/onboarding/confirm', requireAuth, requireVerified, (req, res) => {
  const profile = req.user.profile || {};
  if (!profile.tfn || !profile.tfn.toString().trim()) {
    return res.redirect('/onboarding/documents?error=tfn');
  }
  db.get('users').find({ id: req.user.id }).assign({ onboardingStep: 'payment' }).write();
  res.redirect('/consent');
});

module.exports = router;
