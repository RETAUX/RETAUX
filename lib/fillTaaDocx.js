/**
 * Rellena el DOCX template TAA con datos del cliente y devuelve un PDF.
 * Manipula el XML interno del DOCX directamente, luego convierte con LibreOffice.
 * Uso: const buf = await fillTaaDocx(data); → Buffer PDF listo.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'ENPRESA-TAA_ClientDetailsForm_20260807.docx');

async function fillTaaDocx(data) {
  const tmpDir  = path.join(os.tmpdir(), `taa_${Date.now()}`);
  const tmpDocx = tmpDir + '.docx';
  const tmpPdf  = tmpDir + '.pdf';
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Descomprimir el DOCX
  execSync(`unzip -q "${TEMPLATE}" -d "${tmpDir}"`);

  // 2. Leer y modificar document.xml
  const docXmlPath = path.join(tmpDir, 'word', 'document.xml');
  let xml = fs.readFileSync(docXmlPath, 'utf8');
  xml = applyData(xml, data);
  fs.writeFileSync(docXmlPath, xml, 'utf8');

  // 3. Recomprimir como DOCX
  execSync(`cd "${tmpDir}" && zip -qr "${tmpDocx}" .`);

  // 4. Convertir a PDF con LibreOffice
  const soffice = process.platform === 'darwin'
    ? '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    : 'soffice';
  execSync(`"${soffice}" --headless --convert-to pdf --outdir "${os.tmpdir()}" "${tmpDocx}"`, { timeout: 30000 });

  // 5. Recortar a las primeras 2 páginas (datos del cliente)
  const tmpPdf2 = tmpDir + '_2p.pdf';
  execSync(`python3 -c "
from pypdf import PdfReader, PdfWriter
r = PdfReader('${tmpPdf}')
w = PdfWriter()
for p in r.pages[:2]: w.add_page(p)
with open('${tmpPdf2}', 'wb') as f: w.write(f)
"`, { timeout: 15000 });

  // 6. Leer PDF recortado y limpiar
  const buf = fs.readFileSync(tmpPdf2);
  fs.rmSync(tmpDir,   { recursive: true, force: true });
  fs.rmSync(tmpDocx,  { force: true });
  fs.rmSync(tmpPdf,   { force: true });
  fs.rmSync(tmpPdf2,  { force: true });
  return buf;
}

function applyData(xml, d) {
  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Reemplaza el texto dentro de un sdt identificado por su tag
  function setField(tag, value) {
    // Busca el bloque <w:sdt> que contiene <w:tag w:val="TAG"/>
    // y reemplaza el primer <w:t>...</w:t> dentro de <w:sdtContent>
    const re = new RegExp(
      `(<w:sdt[^>]*>(?:(?!<w:sdt[\\s>]).)*?<w:tag w:val="${escRe(tag)}"[^/]*/>[\\s\\S]*?<w:sdtContent>[\\s\\S]*?<w:t(?:[^>]*)>)([^<]*)(</w:t>)`,
      'g'
    );
    xml = xml.replace(re, `$1${escXml(String(value ?? ''))}$3`);
  }

  // Marca ☒ en el sdt con tag "Qxx_Yes" o "Qxx_No" según la respuesta
  function setYesNo(q, answerIsYes) {
    setField(`${q}_Yes`, answerIsYes ? '☒' : '☐');
    setField(`${q}_No`,  answerIsYes ? '☐' : '☒');
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function escXml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtDob(s) {
    if (!s) return '';
    try { const d = new Date(s); return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`; }
    catch { return s; }
  }
  function fmtDate(s) {
    if (!s) return new Date().toLocaleDateString('en-AU');
    try { return new Date(s).toLocaleDateString('en-AU'); } catch { return s; }
  }

  // ── Field_26 aparece 9 veces en orden: nombre, apodo, dirección, email, móvil, tel fijo, tel trabajo, nombre cónyuge, DOB cónyuge ──
  // Como todos tienen el mismo tag usamos reemplazo secuencial posicional
  const f26vals = [
    d.fullName || '',
    '',                   // preferred name
    d.address || '',
    d.email || '',
    d.phone || '',
    '',                   // home phone
    '',                   // work phone
    d.spouseName || '',
    '',                   // spouse DOB
  ];
  let f26idx = 0;
  xml = xml.replace(
    /(<w:tag w:val="Field_26"[^/]*\/>[\s\S]*?<w:sdtContent>[\s\S]*?<w:t(?:[^>]*)>)([^<]*?)(<\/w:t>)/g,
    (match, pre, _old, post) => {
      const val = f26idx < f26vals.length ? f26vals[f26idx] : '';
      f26idx++;
      return `${pre}${escXml(val)}${post}`;
    }
  );

  // ── Campos con tag único ──────────────────────────────────────────────────────
  setField('Field_3',  fmtDob(d.dob));
  setField('Field_4',  d.gender || '');
  setField('Field_5',  d.countryBirth || '');
  setField('Field_6',  d.citizenship || '');
  setField('Field_7',  d.occupation || '');
  const emp0 = (d.employers||[])[0];
  setField('Field_8',  (typeof emp0 === 'object' ? (emp0?.employerName || emp0?.name || '') : emp0) || '');
  setField('Field_17', d.suburb || '');
  setField('Field_18', d.state || '');
  setField('Field_19', d.postcode || '');
  setField('Field_20', '');

  // Empleadores
  const emps = (d.employers || []).map(e => typeof e === 'object' ? (e.employerName || e.name || '') : e);
  ['Employer_1','Employer_2','Employer_3','Employer_4','Employer_5'].forEach((tag, i) => {
    setField(tag, emps[i] || '');
  });

  // Visa
  setField('Detail_11', d.visaSubclass || '');

  // Banco
  setField('Field_12', d.bankAccountName || '');
  setField('Field_13', d.bsb || '');
  setField('Field_14', d.accountNumber || '');
  setField('Field_15', d.bankName || '');

  // Firma
  setField('Field_65', fmtDate(d.sigAt));

  // Details opcionales vacíos
  ['Detail_9','Detail_10','Detail_30','Detail_31','Detail_33','Detail_34',
   'Detail_36','Detail_37','Detail_38','Detail_39','Detail_40','Detail_41',
   'Detail_42','Detail_43','Detail_44','Detail_45','Detail_46','Detail_47',
   'Detail_54','Detail_55','Detail_56','Detail_57',
   'Field_27','Field_28','Field_29','Field_48','Field_49','Field_50',
   'Field_51','Field_52','Field_53','Field_61','Field_62','Field_63',
   'Field_64','Field_66',
   'DividendCompany_1','DividendCompany_2','DividendCompany_3',
   'DividendCompany_4','DividendCompany_5',
  ].forEach(tag => setField(tag, ''));

  // ── Yes/No ───────────────────────────────────────────────────────────────────
  const hasD1  = (d.ded_d1 || 0) > 0;
  const hasD2  = (d.ded_d2 || 0) > 0;
  const hasD3  = (d.ded_d3 || 0) > 0;
  const hasD4  = (d.ded_d4 || 0) > 0;
  const hasD5  = (d.ded_d5 || 0) > 0;

  setYesNo('Q1',  true);               // Australian resident
  setYesNo('Q2',  true);               // Full year
  setYesNo('Q3',  !!d.hasForeign);     // Foreign residency periods
  setYesNo('Q4',  d.hasVisa);
  setYesNo('Q5',  !!d.hasForeign);     // Foreign income/assets
  setYesNo('Q6',  d.hasSpouse);
  ['Q7','Q8','Q9','Q10'].forEach(q => setYesNo(q, false));
  setYesNo('Q11', emps.length > 0);
  setYesNo('Q12', emps.length > 1);
  ['Q13','Q14','Q15','Q16'].forEach(q => setYesNo(q, false));
  setYesNo('Q17', false);
  ['Q18','Q19','Q20','Q21'].forEach(q => setYesNo(q, false));
  setYesNo('Q22', false);
  setYesNo('Q23', false);
  setYesNo('Q24', d.hasAbn);
  setYesNo('Q25', d.hasAbn);
  ['Q26','Q27','Q28','Q29','Q30','Q31','Q32','Q33','Q34','Q35',
   'Q36','Q37','Q38','Q39','Q40','Q41','Q42','Q43','Q44','Q45','Q46'
  ].forEach(q => setYesNo(q, false));
  setYesNo('Q47', hasD1);              // Vehicle / logbook
  setYesNo('Q48', hasD2);             // Work-related travel (D2)
  setYesNo('Q49', false);
  setYesNo('Q50', hasD3);             // Clothing/uniform
  setYesNo('Q51', hasD3);             // Laundry
  setYesNo('Q52', hasD4);             // Self-education
  ['Q53','Q54'].forEach(q => setYesNo(q, false));
  setYesNo('Q55', hasD5);             // Phone
  setYesNo('Q56', hasD5);             // Internet
  setYesNo('Q57', d.hasHomeOffice || hasD1);
  setYesNo('Q58', d.hasHomeOffice || hasD1);
  setYesNo('Q59', false);
  setYesNo('Q60', d.hasWorkExp || hasD2);
  ['Q61','Q62','Q63','Q64'].forEach(q => setYesNo(q, false));
  setYesNo('Q65', d.hasDonation || (d.ded_d9 > 0));
  ['Q66','Q67','Q68','Q69','Q70','Q71','Q72','Q73','Q74','Q75',
   'Q76','Q77','Q78'].forEach(q => setYesNo(q, false));
  setYesNo('Q79', d.hasPhi);
  setYesNo('Q80', d.hasPhi);
  ['Q81','Q82','Q83','Q84','Q85','Q86'].forEach(q => setYesNo(q, false));
  setYesNo('Q87', true);              // LITO
  ['Q88','Q89','Q90','Q91','Q92'].forEach(q => setYesNo(q, false));
  setYesNo('Q93', d.hasPhi);
  ['Q94','Q95','Q96','Q97','Q98','Q99'].forEach(q => setYesNo(q, false));
  ['Q100','Q101','Q102','Q103','Q104','Q105'].forEach(q => setYesNo(q, false));
  ['Q106','Q107','Q108','Q109','Q110','Q111','Q112','Q113','Q114'].forEach(q => setYesNo(q, false));
  setYesNo('Q115', true);  // Photo ID
  setYesNo('Q116', true);  // Income statements
  setYesNo('Q117', true);  // Receipts
  setYesNo('Q118', d.hasPhi);
  ['Q119','Q120','Q121'].forEach(q => setYesNo(q, false));

  // ── CLIENT DECLARATION — celdas sin SDT: nombre, fecha, firma ────────────────
  // La celda de valor está justo después del label, es un <w:p> vacío con fill DCE6F2
  function fillDeclarationCell(labelText, value) {
    // Busca: label → </w:tc> → <w:tc> con la celda de valor → <w:p...><w:pPr...></w:pPr></w:p>
    const run = `<w:r><w:rPr><w:color w:val="1F3456"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>${escXml(value)}</w:t></w:r>`;
    const re = new RegExp(
      `(${escRe(labelText)}</w:t></w:r></w:p></w:tc><w:tc>[\\s\\S]*?<w:p[^>]*><w:pPr>[\\s\\S]*?</w:pPr>)(</w:p>)`,
      'g'
    );
    xml = xml.replace(re, `$1${run}$2`);
  }

  const sigName = (d.fullName && !d.fullName.includes('@')) ? d.fullName : '';
  const sigDateStr = fmtDate(d.sigAt);
  fillDeclarationCell('Client Full Name:', sigName);
  fillDeclarationCell('Date:', sigDateStr);
  fillDeclarationCell('(e)Signature:', sigName ? `${sigName} (Signed digitally ${sigDateStr})` : '');

  return xml;
}

module.exports = { fillTaaDocx };
