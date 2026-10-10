/**
 * ENPRESA TAA — rellena el formulario original con datos del cliente.
 * Usa el PDF base como fondo y superpone solo el texto del cliente.
 * Requiere: pypdf, reportlab (Python) accesibles como 'python3'.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const BASE_PDF = path.join(__dirname, '..', 'assets', 'ENPRESA_TAA_Template.pdf');

async function generateEnpresaPdf({ u, employers, tfn, clientFyProfile, dedSums, allDocs, dateStr, signature, taxYear }) {
  // Armar datos del cliente como JSON para pasarlos al script Python
  const empName1  = employers && employers[0] ? (employers[0].employerName || '') : '';
  const empName2  = employers && employers[1] ? (employers[1].employerName || '') : '';
  const empName3  = employers && employers[2] ? (employers[2].employerName || '') : '';
  const empName4  = employers && employers[3] ? (employers[3].employerName || '') : '';
  const empName5  = employers && employers[4] ? (employers[4].employerName || '') : '';
  const fullName  = (u.fullName && !u.fullName.includes('@')) ? u.fullName : (signature?.name || '');
  const sigName   = signature?.name || fullName;
  const sigDate   = signature?.date || (signature?.signedAt ? new Date(signature.signedAt).toLocaleDateString('en-AU') : dateStr || '');
  const sigAt     = signature?.signedAt ? new Date(signature.signedAt).toLocaleString('en-AU') : '';
  const multiEmp  = (employers || []).length > 1;

  const data = {
    fullName,
    preferredName:  u.preferredName || fullName.split(' ')[0] || '',
    dob:            u.dateOfBirth || u.birthDate || '',
    gender:         u.gender || '',
    countryBirth:   u.countryOfBirth || u.nationality || '',
    citizenship:    u.nationality || '',
    occupation:     u.occupation || '',
    empName1, empName2, empName3, empName4, empName5,
    multiEmp,
    address:        u.currentAddress || u.address || '',
    suburb:         u.suburb || '',
    state:          u.state || '',
    postcode:       u.postcode || '',
    visaSubclass:   u.currentVisaSubclass || u.visaSubclass || '',
    hasVisa:        !!(u.currentVisaSubclass || u.visaSubclass),
    hasForeign:     !!(u.nationality && !['australian','australia'].includes((u.nationality||'').toLowerCase())),
    hasSpouse:      !!(u.spouseName || u.maritalStatus === 'married' || u.maritalStatus === 'defacto'),
    spouseName:     u.spouseName || '',
    hasAbn:         !!(allDocs && allDocs.some(d => d.category === 'abn_income')) || !!u.abn,
    hasPhi:         !!(allDocs && allDocs.some(d => d.category === 'health_insurance' && d.adminAmount)),
    ded: {
      // dedSums tiene claves uppercase con estructura { total, docs } o un número plano
      d1:  dedSums && (dedSums.D1  ? dedSums.D1.total  > 0 : dedSums.d1  > 0),
      d2:  dedSums && (dedSums.D2  ? dedSums.D2.total  > 0 : dedSums.d2  > 0),
      d3:  dedSums && (dedSums.D3  ? dedSums.D3.total  > 0 : dedSums.d3  > 0),
      d4:  dedSums && (dedSums.D4  ? dedSums.D4.total  > 0 : dedSums.d4  > 0),
      d5:  dedSums && (dedSums.D5  ? dedSums.D5.total  > 0 : dedSums.d5  > 0),
      d6:  dedSums && (dedSums.D6  ? dedSums.D6.total  > 0 : dedSums.d6  > 0),
      d9:  dedSums && (dedSums.D9  ? dedSums.D9.total  > 0 : dedSums.d9  > 0),
      d10: dedSums && (dedSums.D10 ? dedSums.D10.total > 0 : dedSums.d10 > 0),
    },
    email:          u.email || '',
    mobile:         u.phone || u.mobile || '',
    tfn:            tfn || '',
    bankAccountName: u.bankAccountName || '',
    bsb:            u.bsb || '',
    accountNumber:  u.accountNumber || '',
    bankName:       u.bankName || '',
    sigName, sigDate, sigAt,
    taxYear: taxYear || '2025-26',
    dateStr: dateStr || new Date().toLocaleDateString('en-AU'),
  };

  const tmpJson = path.join(os.tmpdir(), `enpresa_data_${Date.now()}.json`);
  const tmpOut  = path.join(os.tmpdir(), `enpresa_out_${Date.now()}.pdf`);
  fs.writeFileSync(tmpJson, JSON.stringify(data));

  const scriptPath = path.join(__dirname, 'enpresa_fill.py');

  try {
    execSync(`python3 "${scriptPath}" "${BASE_PDF}" "${tmpJson}" "${tmpOut}"`, { timeout: 30000 });
    const buf = fs.readFileSync(tmpOut);
    return buf;
  } finally {
    try { fs.unlinkSync(tmpJson); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

module.exports = { generateEnpresaPdf };
