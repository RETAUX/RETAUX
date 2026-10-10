/**
 * ENPRESA Engagement Letter — rellena el formulario con datos del cliente.
 * Mismo patrón que enpresaPdf.js. Requiere: pypdf, reportlab (Python 3).
 */
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const BASE_PDF = path.join(__dirname, '..', 'assets', 'ENPRESA_EngagementLetter_NewTemplate.pdf');
// Template: PDF de Alejandro con todos sus datos — el script Python los borra y escribe los del cliente actual

async function generateEngagementPdf({ u, signature, dateStr }) {
  const fullName = (u.fullName && !u.fullName.includes('@'))
    ? u.fullName
    : (signature?.name || '');

  const sigName = signature?.name || fullName;
  const sigDate = signature?.date
    || (signature?.signedAt ? new Date(signature.signedAt).toLocaleDateString('en-AU') : dateStr || '');
  const sigAt = signature?.signedAt
    ? new Date(signature.signedAt).toLocaleString('en-AU')
    : '';

  const data = {
    fullName,
    abn:     u.abn || '',
    sigName,
    sigDate,
    sigAt,
  };

  const tmpJson = path.join(os.tmpdir(), `engagement_data_${Date.now()}.json`);
  const tmpOut  = path.join(os.tmpdir(), `engagement_out_${Date.now()}.pdf`);
  fs.writeFileSync(tmpJson, JSON.stringify(data));

  const scriptPath = path.join(__dirname, 'enpresa_engagement_fill.py');

  try {
    execSync(`python3 "${scriptPath}" "${BASE_PDF}" "${tmpJson}" "${tmpOut}"`, { timeout: 30000 });
    return fs.readFileSync(tmpOut);
  } finally {
    try { fs.unlinkSync(tmpJson); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

module.exports = { generateEngagementPdf };
