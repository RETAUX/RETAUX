/**
 * Extracción best-effort de datos de payslips / income statements en PDF.
 * No es un parser garantizado — los payslips australianos no tienen un formato
 * estándar único, así que esto cubre los patrones más comunes (ATO income
 * statements, payslips de software tipo Xero/MYOB/QuickBooks).
 * Si no se puede extraer con confianza, se marca extractionStatus='manual_review'
 * y un admin revisa el archivo a mano.
 */

const fs = require('fs');
let PDFParse;
try { ({ PDFParse } = require('pdf-parse')); } catch (e) { PDFParse = null; }

function parseAmount(str) {
  if (!str) return null;
  const n = Number(str.replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function findAmount(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const n = parseAmount(m[1]);
      if (n !== null) return n;
    }
  }
  return null;
}

function findDate(text) {
  // dd/mm/yyyy o dd-mm-yyyy, prioriza "Pay Date"/"Period Ending"
  const labeled = text.match(/(?:Pay\s*Date|Period\s*Ending|Date\s*Paid)[:\s]*([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/i);
  const raw = labeled ? labeled[1] : (text.match(/([0-3]?\d[\/\-][01]?\d[\/\-]\d{2,4})/) || [])[1];
  if (!raw) return null;
  const parts = raw.split(/[\/\-]/);
  if (parts.length !== 3) return null;
  let [d, m, y] = parts;
  if (y.length === 2) y = '20' + y;
  const date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function findEmployerName(text) {
  const labeled = text.match(/(?:Employer|Pay(?:er)?\s*Name|Company)[:\s]*\n?\s*([A-Za-z0-9&.,'\-\s]{3,60})/i);
  if (labeled) return labeled[1].trim().replace(/\s{2,}/g, ' ');
  // Fallback: primera línea no vacía del documento (suele ser el nombre del empleador en payslips)
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 2 && l.length < 60);
  return firstLine || null;
}

function findABN(text) {
  const m = text.match(/ABN[:\s]*([\d\s]{11,14})/i);
  if (!m) return null;
  const digits = m[1].replace(/\s/g, '');
  return /^\d{11}$/.test(digits) ? digits : null;
}

/**
 * Extrae datos de un PDF de payslip/income statement.
 * Devuelve { employerName, employerABN, grossIncome, taxWithheld, payDate, status }
 * status: 'auto' | 'manual_review'
 */
async function extractFromPdf(filePath) {
  if (!PDFParse) {
    return { employerName: null, employerABN: null, grossIncome: null, taxWithheld: null, payDate: null, status: 'manual_review', error: 'pdf-parse no disponible' };
  }
  try {
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result.text || '').trim();

    if (text.length < 20) {
      console.error('[PAYSLIP EXTRACT] PDF sin texto extraíble (probablemente escaneado):', filePath);
      return { employerName: null, employerABN: null, grossIncome: null, taxWithheld: null, payDate: null, status: 'manual_review', error: 'PDF sin texto extraíble' };
    }

    const employerABN = findABN(text);
    const employerName = findEmployerName(text);
    const grossIncome = findAmount(text, [
      /Gross\s*(?:Income|Payments?|Pay|Earnings)?\s*\(?YTD\)?[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      /YTD\s*Gross[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      /Gross\s*(?:Pay|Earnings|Income)[:\s]*\$?\s*([\d,]+\.?\d*)/i
    ]);
    const taxWithheld = findAmount(text, [
      /Tax\s*Withheld\s*\(?YTD\)?[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      /YTD\s*Tax\s*Withheld[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      /PAYG\s*Withholding[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      /Tax[:\s]*\$?\s*([\d,]+\.?\d*)/i
    ]);
    const payDate = findDate(text);

    const status = (employerABN && grossIncome !== null) ? 'auto' : 'manual_review';
    return { employerName, employerABN, grossIncome, taxWithheld, payDate, status };
  } catch (e) {
    console.error('[PAYSLIP EXTRACT] Error procesando PDF:', filePath, e.message);
    return { employerName: null, employerABN: null, grossIncome: null, taxWithheld: null, payDate: null, status: 'manual_review', error: e.message };
  }
}

/**
 * Recalcula el array `employers` de un usuario agrupando todos los payslips
 * extraídos por employerABN (o por nombre si no hay ABN).
 */
function buildEmployersFromDocs(docs) {
  const groups = new Map();
  docs.forEach(doc => {
    const ex = doc.extracted;
    if (!ex) return;
    const key = ex.employerABN || ('name:' + (ex.employerName || 'desconocido').toLowerCase());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...ex, sourceFile: doc.originalName });
  });

  const employers = [];
  groups.forEach(entries => {
    const withDates = entries.filter(e => e.payDate).sort((a, b) => a.payDate.localeCompare(b.payDate));
    const startDate = withDates.length ? withDates[0].payDate : null;
    const endDate = withDates.length ? withDates[withDates.length - 1].payDate : null;

    // Gross/tax: usar el YTD del payslip más reciente si todos tienen payDate; si no, sumar.
    let grossIncome, taxWithheld;
    if (withDates.length === entries.length && withDates.length > 0) {
      const latest = withDates[withDates.length - 1];
      grossIncome = latest.grossIncome || 0;
      taxWithheld = latest.taxWithheld || 0;
    } else {
      grossIncome = entries.reduce((sum, e) => sum + (e.grossIncome || 0), 0);
      taxWithheld = entries.reduce((sum, e) => sum + (e.taxWithheld || 0), 0);
    }

    const daysWorked = (startDate && endDate)
      ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1)
      : null;

    employers.push({
      employerName: entries.find(e => e.employerName)?.employerName || 'Empleador sin identificar',
      employerABN: entries.find(e => e.employerABN)?.employerABN || '',
      grossIncome: Math.round(grossIncome * 100) / 100,
      taxWithheld: Math.round(taxWithheld * 100) / 100,
      startDate, endDate, daysWorked,
      extractionStatus: entries.every(e => e.status === 'auto') ? 'auto' : 'manual_review',
      sourceFiles: entries.map(e => e.sourceFile)
    });
  });

  return employers;
}

module.exports = { extractFromPdf, buildEmployersFromDocs };
