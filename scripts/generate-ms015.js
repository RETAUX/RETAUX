/**
 * Genera CSV con datos para formulario MS015 (Medicare Entitlement Statement)
 * Uso: node scripts/generate-ms015.js
 * Salida: exports/MS015_YYYY-MM-DD.csv
 */

const path = require('path');
const fs   = require('fs');
const db   = require('../db/database');

// ── Lista de clientes a incluir ───────────────────────────────────────────────
const TARGET_NAMES = [
  'Manuel Perez Alzueta',
  'Ariel David Prieto',
  'Maria Candela Gonzalez',
  'Tamar Vishnia',
  'Mark Wust',
  'Ivan Alejandro Panussis Conejeros',
  'Mauro Lombardo',
  'Carlos Augusto Ortega Rodriguez',
  'Betsabe Chica Peralta',
  'Marion Christine Martine Pottier',
  'Francisco Gomez Galzerano',
  'Luciano Guillermo Barbieri',
  'Teo David Meglio',
  'Maria Agustina González Roulet',
  'Loreto Andrea Cordova Vasquez',
  'Melany Borda',
  'Gonzalo Martin Salas',
  'Marina Pulichino',
  'Hugo Toca Sainz-Rozas',
  'Julia Cecilia Porporato',
  'Javier Alberto Pedrotti',
  'Felipe Giraudo',
  'Joaquin vandersluis',
  'Ot Balleste Puig',
  'Florencia Cristina Rey',
  'Julian Ignacio Roig Puscama',
  'Rocio Eluney Camerlo',
  'Agustina Saenz Batista',
  'Giuliano Oberrti',
  'Daniel Romero Garcia',
  'Ignacio Clementino',
  'Maria Belen Blanco Correcher',
  'River David Rodriguez Romero',
  'Ilse Maria Hemmerling Gonzalez',
  'Sofia Quiroga Lescano',
  'Maria Sol Lopez',
  'Tiago Estevez Lopez',
  'Ignacio Paci Navarro',
  'Ederson Siler Tolentino Mendoza',
  'Rafaella La Rosa Sousa',
  'Ramiro Fera',
  'Olivia de Alharilla Salas Vallejos',
  'Tomas Alejo Casaretto Scotti',
  'Trinidad Escudero',
  'Cristóbal Muñoz',
  'Alondra Micaela Traid Zang',
  'Lautaro Uribe',
  'Agustin Manjon',
];

// Países que requieren prueba de seguro de salud extranjero con fecha de vencimiento
const BILATERAL_COUNTRIES = ['united kingdom','uk','gran bretaña','belgica','belgium','finland','finlandia','italy','italia','netherlands','países bajos','holanda','norway','noruega','slovenia','eslovenia','sweden','suecia'];

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  const dd = String(dt.getUTCDate()).padStart(2,'0');
  const mm = String(dt.getUTCMonth()+1).padStart(2,'0');
  const yyyy = dt.getUTCFullYear();
  return `${dd} ${mm} ${yyyy}`;
}

function csvCell(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

function csvRow(arr) {
  return arr.map(csvCell).join(',');
}

// ── Cargar datos ──────────────────────────────────────────────────────────────
const allUsers    = db.get('users').value();
const allProfiles = db.get('taxYearProfiles').value();
const allDocs     = db.get('documents').value();
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

const rows = [];
const notFound = [];

// Deduplicar: Marion aparece dos veces en la lista, Tiago también
const processed = new Set();

for (const targetName of TARGET_NAMES) {
  const normTarget = normalize(targetName);

  // Casos especiales por email
  const EMAIL_OVERRIDES = {
    'carlos augusto ortega rodriguez': 'carlosor95@hotmail.com',
  };
  const override = EMAIL_OVERRIDES[normTarget];

  // Buscar usuario por email override, o por nombre (al menos 2 palabras coinciden)
  const targetWords = normTarget.split(' ').filter(w => w.length > 1);
  const user = override
    ? allUsers.find(u => u.email === override)
    : allUsers.find(u => {
        if (!u.fullName) return false;
        const uWords = normalize(u.fullName).split(' ').filter(w => w.length > 1);
        const matches = targetWords.filter(w => uWords.includes(w));
        return matches.length >= 2;
      });

  if (!user) {
    if (!processed.has(normTarget)) notFound.push(targetName);
    processed.add(normTarget);
    continue;
  }

  // Obtener perfiles fiscales del usuario (uno por año)
  const profiles = allProfiles.filter(p => p.userId === user.id)
    .sort((a,b) => (b.taxYear||'').localeCompare(a.taxYear||''));

  const userDocs = allDocs.filter(d => d.userId === user.id);
  const hasSelfie  = userDocs.some(d => d.category === 'selfie_id');
  const selfieFile = userDocs.find(d => d.category === 'selfie_id');

  // Usar el perfil más reciente (o uno vacío si no hay)
  const profile = profiles[0] || {};
  const taxYear = profile.taxYear || '';

  // Fecha de nacimiento
  const dob = fmtDate(user.birthDate || user.dateOfBirth || '');

  // Visa
  const visa = user.currentVisaSubclass || user.visaType || '';
  const visaStart = fmtDate(user.visaStartDate || '');
  const visaEnd   = fmtDate(user.visaEndDate || '');

  // Año fiscal → rango legible
  let fyRange = taxYear;
  if (taxYear && taxYear.includes('-')) {
    const [y1, y2short] = taxYear.split('-');
    const y2 = y2short.length === 2 ? `20${y2short}` : y2short;
    fyRange = `01 07 ${y1} – 30 06 ${y2}`;
  }

  // Seguro de salud extranjero: hasHealthInsurance en el perfil
  const hasForeignHealth = profile.hasHealthInsurance ? 'Sí' : 'No';

  // Verificar bilateral country
  const natNorm = normalize(user.nationality || '');
  const needsHealthProof = BILATERAL_COUNTRIES.some(c => natNorm.includes(c));

  // Foto pasaporte y visa en documents
  const selfieInfo = hasSelfie
    ? `Sí — uploads/${user.id}/${selfieFile.storedFilename}`
    : 'No';
  // No hay categoría 'visa' en documents
  const visaDoc = 'No';

  // Firma
  const hasSig = !!(user.consentSignedAt || user.declarationSignedAt);

  // ── Datos faltantes ────────────────────────────────────────────────────────
  const missing = [];
  if (!dob)                   missing.push('Fecha de nacimiento');
  if (!user.currentAddress)   missing.push('Dirección residencial');
  if (!visa)                  missing.push('Tipo de visa');
  if (!visaStart)             missing.push('Fecha inicio visa');
  if (!visaEnd)               missing.push('Fecha fin visa');
  if (!user.nationality)      missing.push('Nacionalidad');
  if (!hasSig)                missing.push('Firma del cliente');
  if (!hasSelfie)             missing.push('Foto pasaporte');
  if (!taxYear)               missing.push('Año fiscal');
                              missing.push('Dirección postal');
                              missing.push('Número Medicare + IRN');
                              missing.push('País de residencia anterior');
                              missing.push('Aplicó a residencia permanente (S/N + fecha)');
                              missing.push('Fecha estimada de salida');
                              missing.push('Copia de visa');
  if (needsHealthProof)       missing.push('⚠ Prueba de seguro extranjero con fecha vencimiento (país bilateral)');

  // Si tiene múltiples años fiscales, hacer una fila por año
  const profileList = profiles.length > 0 ? profiles : [profile];
  const dedupKey = `${user.id}`;
  if (processed.has(dedupKey) && profiles.length <= 1) {
    // ya procesado (duplicado en lista como Marion/Tiago)
    processed.add(dedupKey);
    // igual generar filas de años extra
  }
  processed.add(dedupKey);

  for (const prof of profileList) {
    const ty = prof.taxYear || '';
    let fyR = ty;
    if (ty && ty.includes('-')) {
      const [y1, y2s] = ty.split('-');
      const y2 = y2s.length === 2 ? `20${y2s}` : y2s;
      fyR = `01 07 ${y1} – 30 06 ${y2}`;
    }
    const phInsurance = prof.hasHealthInsurance ? 'Sí' : 'No';

    rows.push([
      user.id,                          // 1. ID
      user.fullName || '',              // 2. Nombre completo
      dob,                              // 3. Fecha nacimiento
      user.email,                       // 4. Email
      user.currentAddress || '',        // 5. Dirección residencial
      '',                               // 6. Dirección postal (no disponible)
      '',                               // 7. Medicare + IRN (no disponible)
      '',                               // 8. País residencia anterior (no disponible)
      user.nationality || '',           // 9. Nacionalidad
      visa,                             // 10. Tipo de visa
      phInsurance,                      // 11. Seguro salud extranjero
      '',                               // 12. Aplicó a residencia permanente
      fyR,                              // 13. Año fiscal
      '',                               // 14. Fecha estimada de salida
      selfieInfo,                       // 15. Foto pasaporte
      visaDoc,                          // 16. Copia visa
      hasSig ? 'Sí' : 'No',            // 17. Firma
      missing.join(' | '),              // 18. Datos faltantes
    ]);
  }
}

// ── Escribir CSV ──────────────────────────────────────────────────────────────
const headers = [
  'ID Cliente',
  'Nombre completo',
  'Fecha de nacimiento (DD MM YYYY)',
  'Email',
  'Dirección residencial',
  'Dirección postal',
  'Medicare + IRN',
  'País residencia anterior',
  'Nacionalidad',
  'Tipo de visa',
  'Seguro salud extranjero',
  'Aplicó a residencia permanente',
  'Año fiscal',
  'Fecha estimada de salida',
  'Foto pasaporte',
  'Copia de visa',
  'Firma del cliente',
  'Datos faltantes',
];

const dateStr  = new Date().toISOString().slice(0,10);
const outDir   = path.join(__dirname, '..', 'exports');
fs.mkdirSync(outDir, { recursive: true });
const outFile  = path.join(outDir, `MS015_${dateStr}.csv`);

const csvLines = [csvRow(headers), ...rows.map(csvRow)];
fs.writeFileSync(outFile, '﻿' + csvLines.join('\n'), 'utf8'); // BOM para Excel

// ── Resumen (sin datos personales) ───────────────────────────────────────────
const complete  = rows.filter(r => r[17] === '').length;
const withGaps  = rows.filter(r => r[17] !== '').length;

// Contar campos faltantes más frecuentes
const fieldCount = {};
rows.forEach(r => {
  (r[17] || '').split(' | ').filter(Boolean).forEach(f => {
    fieldCount[f] = (fieldCount[f] || 0) + 1;
  });
});
const topMissing = Object.entries(fieldCount).sort((a,b)=>b[1]-a[1]).slice(0,10);

console.log('\n=== RESUMEN MS015 ===');
console.log(`Clientes en lista:    ${TARGET_NAMES.length} (${[...new Set(TARGET_NAMES.map(normalize))].length} únicos)`);
console.log(`Filas generadas:      ${rows.length}`);
console.log(`Completos:            ${complete}`);
console.log(`Con datos faltantes:  ${withGaps}`);
console.log(`No encontrados en DB: ${notFound.length}${notFound.length ? ' → ' + notFound.join(', ') : ''}`);
console.log('\nCampos que faltan con más frecuencia:');
topMissing.forEach(([f,c]) => console.log(`  ${c}x  ${f}`));
console.log(`\nArchivo generado: ${outFile}`);
