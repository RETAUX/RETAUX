/**
 * Rellena el template Tax Deductions Individual con datos del cliente.
 * Devuelve un Buffer con el XLSX listo para adjuntar.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const TEMPLATE   = path.join(__dirname, '..', 'assets', 'TaxDeductions_TEMPLATE.xlsx');
const FILL_SCRIPT = path.join(__dirname, 'fill_deductions_xlsx.py');

/**
 * @param {object} opts
 * @param {object} opts.user          — lowdb user document
 * @param {object} opts.dedSums       — { D1: { total }, D2: { total }, ... }
 * @param {string} [opts.taxYear]     — e.g. '2025-26'
 * @param {number} [opts.d1Km]        — km for cents-per-km method
 * @returns {Buffer} XLSX file buffer
 */
async function fillDeductionsXlsx({ user, dedSums = {}, taxYear = '2025-26', d1Km = null }) {
  const tmpId    = `ded_${Date.now()}`;
  const jsonPath = path.join(os.tmpdir(), `${tmpId}.json`);
  const xlsxPath = path.join(os.tmpdir(), `${tmpId}.xlsx`);

  // Build deduction totals map
  const ded = {};
  for (const [k, v] of Object.entries(dedSums)) {
    const code = k.toUpperCase();
    ded[code] = (v && v.total) ? v.total : (typeof v === 'number' ? v : 0);
  }

  const payload = {
    fullName:    user.fullName || user.email || '',
    taxYear,
    address:     [user.currentAddress || user.address, user.suburb, user.state, user.postcode]
                   .filter(Boolean).join(', '),
    occupation:  user.occupation || '',
    dateOfBirth: user.dateOfBirth || user.birthDate || '',
    spouseName:  user.spouseName || '',
    hasSpouse:   !!(user.spouseName || user.maritalStatus === 'married' || user.maritalStatus === 'defacto'),
    hasPhi:      !!(user.hasPhi),
    ded,
    d1_km:   d1Km || null,
    d1_rate: 0.88,
    d1_ref:  d1Km ? `Work-related motor vehicle travel – cents per km method` : null,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload));

  try {
    execSync(
      `python3 "${FILL_SCRIPT}" "${jsonPath}" "${xlsxPath}" "${TEMPLATE}"`,
      { timeout: 30000 }
    );
    const buf = fs.readFileSync(xlsxPath);
    return buf;
  } finally {
    try { fs.unlinkSync(jsonPath); } catch (_) {}
    try { fs.unlinkSync(xlsxPath); } catch (_) {}
  }
}

module.exports = { fillDeductionsXlsx };
