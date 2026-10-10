const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db/database');

const router = express.Router();

// Public route — no auth required (token acts as the credential)
router.get('/taxagent-bundle/:token', (req, res) => {
  const bundle = db.get('taxBundles').find({ token: req.params.token }).value();

  if (!bundle) {
    return res.status(404).send('<h2>Link not found or already expired.</h2>');
  }

  if (new Date(bundle.expiresAt) < new Date()) {
    return res.status(410).send('<h2>This download link has expired. Please contact hola@retaux.com to request a new one.</h2>');
  }

  const safeName = (bundle.clientName || 'client').replace(/[^a-zA-Z0-9_\-]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="RETAUX_${safeName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    console.error('[BUNDLE DOWNLOAD ERROR]', err);
    if (!res.headersSent) res.status(500).send('Error generating ZIP.');
  });
  archive.pipe(res);

  let added = 0;
  for (const f of bundle.files) {
    if (fs.existsSync(f.path)) {
      archive.file(f.path, { name: f.name });
      added++;
    } else {
      console.warn(`[BUNDLE] File missing: ${f.path}`);
    }
  }

  if (added === 0) {
    archive.abort();
    return res.status(404).send('<h2>No files found for this bundle. Please contact hola@retaux.com.</h2>');
  }

  archive.finalize();
});

module.exports = router;
