const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const db = require('../db/database');
const { JWT_SECRET } = require('../middleware/auth');
const { genId, getFinancialYears } = require('../db/helpers');
const { UPLOAD_ROOT, compressImage, IMAGE_EXTS } = require('../middleware/upload');
const { formatSlot, slotSummary } = require('../db/appointments');
const DOCUMENT_CATEGORIES = require('../db/documentCategories');

const router = express.Router();
const PIN_REGEX = /^\d{8}$/;

// Convierte una imagen (JPEG/PNG/HEIC/WEBP) a PDF buffer usando Python/Pillow
function convertImageToPdf(imagePath) {
  return new Promise((resolve, reject) => {
    const script = `
import sys, io
from PIL import Image
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass
img = Image.open(sys.argv[1])
if img.mode not in ('RGB',):
    img = img.convert('RGB')
A4_W, A4_H = 1240, 1754
img.thumbnail((A4_W, A4_H), Image.LANCZOS)
canvas = Image.new('RGB', (A4_W, A4_H), (255, 255, 255))
x = (A4_W - img.width) // 2
y = (A4_H - img.height) // 2
canvas.paste(img, (x, y))
buf = io.BytesIO()
canvas.save(buf, 'PDF', resolution=150)
sys.stdout.buffer.write(buf.getvalue())
`;
    const { execFile } = require('child_process');
    const tmp = require('os').tmpdir() + '/retaux_img2pdf_' + Date.now() + '.py';
    require('fs').writeFileSync(tmp, script);
    execFile('python3', [tmp, imagePath], { maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      require('fs').unlinkSync(tmp);
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// Nombre canónico para el documento de identidad
const identityPdfName = (clientName) =>
  `2. Identity Document _ ${(clientName || 'Client').replace(/[/\\:*?"<>|]/g, '_')}.pdf`;

// Mapeo categoría de documento → código ATO de deducción (fallback cuando adminDedCode es null)
const CAT_TO_DED_MAP = {
  logbook:               'D1',  // gastos de auto → work-related car expenses
  work_travel:           'D2',  // viajes de trabajo (vuelos, taxis, no auto) → work-related travel
  work_expenses:         'D3',  // ropa, uniforme → clothing/laundry
  training:              'D4',  // cursos → self-education
  certifications:        'D5',  // licencias, habilitaciones → other work expenses
  tech_purchases:        'D5',  // tecnología, teléfono → other work-related expenses
  home_office:           'D6',  // home office
  investment_statements: 'D7',  // inversiones/dividendos → interest income & dividend deductions
  donation_receipts:     'D9',  // donaciones
};
const parseAdminAmt = (v) => parseFloat(String(v || '').replace(',', '.')) || 0;

// Orden canónico de categorías según ATO D1-D10 (para adjuntos y sección 8 del email)
const CATEGORY_ORDER = [
  'selfie_id',
  'payslips',
  'abn_income',
  'logbook',          // D1
  'work_travel',      // D2
  'work_expenses',    // D3
  'training',         // D4
  'certifications',   // D5
  'tech_purchases',   // D5
  'home_office',      // D6
  'investment_statements', // D7/D8
  'donation_receipts',     // D9
  'bank_statement',
];
const sortDocsByCategory = (docs) =>
  [...docs].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a.category);
    const ib = CATEGORY_ORDER.indexOf(b.category);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

// ── Auth helpers ──────────────────────────────────────────────────────────────

function setAdminSession(res, adminId, email) {
  const token = jwt.sign({ adminId, email, admin: true }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('retaux_admin', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
}

function requireAdmin(req, res, next) {
  const token = req.cookies.retaux_admin;
  if (!token) return res.redirect('/admin/login');
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p.admin || !p.adminId) return res.redirect('/admin/login');
    const admin = db.get('admins').find({ id: p.adminId }).value();
    if (!admin) return res.redirect('/admin/login');
    res.locals.adminUser = admin;
    req.adminUser = admin;
    next();
  } catch (e) {
    res.redirect('/admin/login');
  }
}

// ── Login / Logout ────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, pin } = req.body;
  const admin = db.get('admins').find({ email: (email || '').toLowerCase().trim() }).value();
  if (!admin || !(await bcrypt.compare(pin || '', admin.pinHash))) {
    return res.render('admin/login', { error: 'E-mail o clave incorrectos.' });
  }
  setAdminSession(res, admin.id, admin.email);
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  res.clearCookie('retaux_admin');
  res.redirect('/admin/login');
});

// ── Crear cuenta de admin (requiere ADMIN_CREATION_KEY) ───────────────────────

router.get('/crear-cuenta', (req, res) => {
  res.render('admin/crear-cuenta', { error: null, success: null });
});

// ── Tax Agent accounts ────────────────────────────────────────────────────────

function resolveAgentLabel(assignedAgent, sentToEmail) {
  const raw = (assignedAgent || '').toLowerCase();
  if (raw.includes('estiguan')) return 'Estiguan Navas';
  if (raw.includes('hisham') || raw.includes('ghanda') || raw.includes('gyan')) return 'Hisham & Ghanda';
  const emailRaw = (sentToEmail || '').toLowerCase();
  if (emailRaw.includes('estiguan')) return 'Estiguan Navas';
  if (emailRaw.includes('hisham') || emailRaw.includes('ghanda') || emailRaw.includes('gyan')) return 'Hisham & Ghanda';
  return '—';
}

function resolveEmailLabel(sentToEmail) {
  const emailRaw = (sentToEmail || '').toLowerCase();
  if (emailRaw.includes('estiguan')) return 'Estiguan Navas';
  if (emailRaw.includes('hisham') || emailRaw.includes('ghanda') || emailRaw.includes('gyan')) return 'Hisham & Ghanda';
  if (sentToEmail) return sentToEmail;
  return null;
}

router.get('/taxagent-accounts', requireAdmin, (req, res) => {
  const agents = db.get('users').filter(u => ['taxagent','taxagent_revoked','referrer','referrer_revoked'].includes(u.role)).value();

  // Include all paying clients, not just those already sent to an agent
  const paidUserIds = db.get('payments').filter({ status: 'paid' }).map('userId').value();
  const portalClients = db.get('users').filter(u => paidUserIds.includes(u.id)).map(u => {
    const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value() || {};
    const abn = u.abn || (u.employers && u.employers.length ? (u.employers[0].abn || '') : '');

    const agentLabel   = resolveAgentLabel(u.assignedAgent, u.taxAgentEmail);
    const sentToLabel  = resolveEmailLabel(u.taxAgentEmail);
    // "Ambos agentes": assigned to one, last report sent to another
    const bothAgents   = sentToLabel && agentLabel !== sentToLabel && agentLabel !== '—';

    return {
      id:          u.id,
      fullName:    u.fullName || u.email,
      email:       u.email,
      tfn:         u.tfn || '',
      abn,
      occupation:  u.occupation || '',
      sentAtRaw:   u.taxAgentSentAt || '',
      sentAt:      u.taxAgentSentAt ? new Date(u.taxAgentSentAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—',
      taxYear:     payment.taxYear || '—',
      grossIncome: u.taxAgentGrossIncome || '',
      returnAmt:   u.taxAgentReturnAmt   || '',
      notes:       u.taxAgentNotes       || '',
      submitted:   !!u.taxAgentSubmittedAt,
      submittedAt: u.taxAgentSubmittedAt ? new Date(u.taxAgentSubmittedAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : null,
      hasReport:   !!u.taxAgentReportHtml,
      agentLabel,
      sentToLabel,
      bothAgents,
    };
  }).sortBy(c => c.sentAtRaw).reverse().value();
  res.render('admin/taxagent-accounts', { agents, portalClients, error: null, success: null });
});

router.post('/taxagent-accounts/create', requireAdmin, async (req, res) => {
  const email    = (req.body.email || '').toLowerCase().trim();
  const password = (req.body.password || '').trim();
  const fullName = (req.body.fullName || '').trim();
  const role     = req.body.role === 'referrer' ? 'referrer' : 'taxagent';

  const reload = () => {
    const agents = db.get('users').filter(u => ['taxagent','taxagent_revoked','referrer','referrer_revoked'].includes(u.role)).value();
    const paidIds = db.get('payments').filter({ status: 'paid' }).map('userId').value();
    const portalClients = db.get('users').filter(u => paidIds.includes(u.id)).map(u => {
      const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value() || {};
      const abn = u.abn || (u.employers && u.employers.length ? (u.employers[0].abn || '') : '');
      const now = Date.now();
      const daysSince = u.taxAgentSentAt ? Math.floor((now - new Date(u.taxAgentSentAt)) / (1000*60*60*24)) : 0;
      const overdue = daysSince > 5 && !u.taxAgentGrossIncome && !u.taxAgentSubmittedAt;
      const agentLabel = resolveAgentLabel(u.assignedAgent, u.taxAgentEmail);
      const sentToLabel = resolveEmailLabel(u.taxAgentEmail);
      const bothAgents = sentToLabel && agentLabel !== sentToLabel && agentLabel !== '—';
      return { id: u.id, fullName: u.fullName || u.email, email: u.email, tfn: u.tfn || '', abn, occupation: u.occupation || '',
        sentAtRaw: u.taxAgentSentAt || '',
        sentAt: u.taxAgentSentAt ? new Date(u.taxAgentSentAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—',
        taxYear: payment.taxYear || '—', grossIncome: u.taxAgentGrossIncome || '', returnAmt: u.taxAgentReturnAmt || '',
        notes: u.taxAgentNotes || '', submitted: !!u.taxAgentSubmittedAt,
        submittedAt: u.taxAgentSubmittedAt ? new Date(u.taxAgentSubmittedAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : null,
        hasReport: !!u.taxAgentReportHtml, stage: u.taxReturnStage || 'processing', overdue, daysSince,
        agentLabel, sentToLabel, bothAgents };
    }).sortBy(c => c.sentAtRaw).reverse().value();
    return { agents, portalClients };
  };

  if (!email || !password || !fullName) {
    const { agents, portalClients } = reload();
    return res.render('admin/taxagent-accounts', { agents, portalClients, error: 'All fields are required.', success: null });
  }
  if (password.length < 8) {
    const { agents, portalClients } = reload();
    return res.render('admin/taxagent-accounts', { agents, portalClients, error: 'Password must be at least 8 characters.', success: null });
  }
  if (db.get('users').find({ email }).value()) {
    const { agents, portalClients } = reload();
    return res.render('admin/taxagent-accounts', { agents, portalClients, error: 'An account with that email already exists.', success: null });
  }

  const newEntry = { id: genId(), email, fullName, pinHash: await bcrypt.hash(password, 10), role, emailVerified: true, createdAt: new Date().toISOString() };
  if (role === 'referrer') {
    const { genReferralCode } = require('../db/helpers');
    newEntry.referralCode = genReferralCode(email);
  }
  db.get('users').push(newEntry).write();

  const { agents, portalClients } = reload();
  const label = role === 'referrer' ? 'Referrer' : 'Tax Agent';
  res.render('admin/taxagent-accounts', { agents, portalClients, error: null, success: `${label} account created for ${email}.` });
});

router.post('/taxagent-accounts/:id/revoke', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin/taxagent-accounts');
  const revokedRole = u.role === 'referrer' ? 'referrer_revoked' : 'taxagent_revoked';
  db.get('users').find({ id: req.params.id }).assign({ role: revokedRole }).write();
  res.redirect('/admin/taxagent-accounts');
});

router.post('/taxagent-accounts/:id/restore', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin/taxagent-accounts');
  const activeRole = u.role === 'referrer_revoked' ? 'referrer' : 'taxagent';
  db.get('users').find({ id: req.params.id }).assign({ role: activeRole }).write();
  res.redirect('/admin/taxagent-accounts');
});

router.post('/crear-cuenta', async (req, res) => {
  const { email, pin, pinConfirm, creationKey } = req.body;

  if ((creationKey || '').trim() !== (process.env.ADMIN_CREATION_KEY || '')) {
    return res.render('admin/crear-cuenta', { error: 'Clave de creación incorrecta.', success: null });
  }
  if (!email || !pin) {
    return res.render('admin/crear-cuenta', { error: 'Completá todos los campos.', success: null });
  }
  if (!PIN_REGEX.test(pin)) {
    return res.render('admin/crear-cuenta', { error: 'La clave debe ser exactamente 8 dígitos numéricos.', success: null });
  }
  if (pin !== pinConfirm) {
    return res.render('admin/crear-cuenta', { error: 'Las claves no coinciden.', success: null });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (db.get('admins').find({ email: normalizedEmail }).value()) {
    return res.render('admin/crear-cuenta', { error: 'Ya existe un admin con ese e-mail.', success: null });
  }

  db.get('admins').push({
    id: genId(),
    email: normalizedEmail,
    pinHash: await bcrypt.hash(pin, 10),
    createdAt: new Date().toISOString()
  }).write();

  res.render('admin/crear-cuenta', { error: null, success: `Cuenta creada para ${normalizedEmail}. Ya puede ingresar.` });
});

// ── A partir de acá todo requiere estar autenticado como admin ─────────────────

router.use(requireAdmin);

// ── Panel principal con buscador ──────────────────────────────────────────────

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { q, status } = req.query;

  let users = db.get('users').value();

  // Filtro por rol: 'referrer' muestra solo referidores puros; el resto muestra todos
  // (un referidor puede ser también cliente — se muestra en ambas vistas con badge)
  if (status === 'referrer') {
    users = users.filter(u => u.role === 'referrer');
  }

  // Filtro por texto (nombre completo o email)
  if (q && q.trim()) {
    const term = q.trim().toLowerCase();
    users = users.filter(u =>
      (u.fullName || '').toLowerCase().includes(term) ||
      (u.email || '').toLowerCase().includes(term) ||
      (u.referralCode || '').toLowerCase().includes(term)
    );
  }

  // Filtro por estado
  if (status === 'paid') {
    const paidIds = new Set(db.get('payments').filter({ status: 'paid' }).map('userId').value());
    users = users.filter(u => paidIds.has(u.id));
  } else if (status === 'pending') {
    const paidIds = new Set(db.get('payments').filter({ status: 'paid' }).map('userId').value());
    users = users.filter(u => !paidIds.has(u.id) && u.emailVerified);
  } else if (status === 'unverified') {
    users = users.filter(u => !u.emailVerified);
  } else if (status === 'linked') {
    users = users.filter(u => u.linkingStatus === 'linked');
  } else if (status === 'stage_paid') {
    users = users.filter(u => (u.taxReturnStage || 'paid') === 'paid');
  } else if (status === 'stage_processing') {
    users = users.filter(u => u.taxReturnStage === 'processing');
  } else if (status === 'stage_with_agent') {
    users = users.filter(u => u.taxReturnStage === 'with_agent');
  } else if (status === 'stage_issued') {
    users = users.filter(u => u.taxReturnStage === 'issued');
  } else if (status === 'stage_informal') {
    users = users.filter(u => u.taxReturnStage === 'informal');
  }

  const referrals = db.get('referrals').value();
  const documents = db.get('documents').value();
  const appointments = db.get('appointments').value();
  const payments = db.get('payments').value();

  const rows = users.map(u => ({
    ...u,
    _type: 'taxreturn',
    referralCount: referrals.filter(r => r.referrerUserId === u.id).length,
    docCount: documents.filter(d => d.userId === u.id).length,
    appt: appointments.find(a => a.userId === u.id),
    payment: payments.find(p => p.userId === u.id && p.status === 'paid')
  }));

  // Agregar solicitudes DASP a la lista
  const daspRequests = db.get('daspRequests').value();
  const daspRows = daspRequests.map(d => {
    const u = db.get('users').find({ id: d.userId }).value() || {};
    return {
      ...u,
      _type: 'dasp',
      _dasp: d,
      id: u.id,
      fullName: u.fullName || u.email || '—',
      email: u.email || '—',
      daspStatus: d.status || 'pending_review',
      payment: payments.find(p => p.userId === u.id && p.status === 'paid')
    };
  });

  // Filtrar DASP por texto también
  let filteredDasp = daspRows;
  if (q && q.trim()) {
    const term = q.trim().toLowerCase();
    filteredDasp = daspRows.filter(u =>
      (u.fullName || '').toLowerCase().includes(term) ||
      (u.email || '').toLowerCase().includes(term)
    );
  }

  // Combinar según filtro activo
  let finalRows;
  if (status === 'dasp') {
    finalRows = filteredDasp;
  } else if (status === 'taxreturn') {
    finalRows = rows; // solo Individual Tax Return, sin DASP
  } else if (status && status !== 'dasp') {
    finalRows = rows; // filtros paid/pending/unverified/referrer aplican solo a tax return
  } else {
    finalRows = [...rows, ...filteredDasp];
  }

  // Estimaciones pendientes de aceptación
  const pendingEstimates = db.get('users')
    .filter(u => u.taxEstimate && u.taxEstimate.status === 'pending')
    .map(u => ({ id: u.id, fullName: u.fullName || u.email, email: u.email, loadedAt: u.taxEstimate.loadedAt }))
    .value();

  // Pagos pendientes de confirmación manual
  const pendingPayments = db.get('payments').filter({ status: 'pending_manual' }).value().map(p => {
    const u = db.get('users').find({ id: p.userId }).value();
    return { ...p, userEmail: u ? u.email : '—', userName: u ? (u.fullName || u.email) : '—' };
  });

  const rejectedPayments = db.get('payments').filter({ status: 'rejected' }).value().map(p => {
    const u = db.get('users').find({ id: p.userId }).value();
    return { ...p, userEmail: u ? u.email : '—', userName: u ? (u.fullName || u.email) : '—' };
  });

  const pendingSuperPayments = db.get('super_payments').filter({ status: 'pending_manual' }).value().map(p => {
    const u = db.get('users').find({ id: p.userId }).value();
    return { ...p, userEmail: u ? u.email : '—', userName: u ? (u.fullName || u.email) : '—' };
  });

  // ── Base única de métricas ────────────────────────────────────────────────────
  // Todos los users reales (excluye cuenta de prueba; incluye referidores que también son clientes)
  const allUsersDB = db.get('users').value();
  const allRealUsers = allUsersDB.filter(u => u.email !== 'claude-test@retaux.com');
  const allRealUserIds = new Set(allRealUsers.map(u => u.id));

  // Pagos confirmados cuyos usuarios aún existen
  const allPaidPayments = db.get('payments').filter({ status: 'paid' })
    .value().filter(p => allRealUserIds.has(p.userId));
  const realPayments = allPaidPayments.filter(p => !p.courtesy);

  // IDs de usuarios con pago confirmado (real o cortesía)
  const allPaidUserIds   = new Set(allPaidPayments.map(p => p.userId));
  const realPaidUserIds  = new Set(realPayments.map(p => p.userId));

  // Usuarios con pago confirmado (base para kanban y métricas de proceso)
  const paidUsers = allRealUsers.filter(u => allPaidUserIds.has(u.id));

  // Métricas de cabecera
  const totalUsers    = allRealUsers.filter(u => u.role !== 'referrer').length;
  const totalPaid     = allPaidUserIds.size; // pagos reales + cortesías

  // Enviados al agente formal
  const totalSentToAgent = paidUsers.filter(u => u.taxReturnStage === 'with_agent').length;

  // Informal: gestionados directamente por RETAUX
  const totalInformal = paidUsers.filter(u => u.taxReturnStage === 'informal').length;

  // En proceso: sin stage asignado o en procesamiento
  const totalInProcess = paidUsers.filter(u => !u.taxReturnStage || u.taxReturnStage === 'processing').length;

  // Casos emitidos
  const totalIssued = paidUsers.filter(u => u.taxReturnStage === 'issued').length;

  // Con cortesía: usuarios con pago courtesy (no pagan, se les envía al agente igual)
  const courtesyUserIds = new Set(allPaidPayments.filter(p => p.courtesy).map(p => p.userId));
  const totalWithCollab = paidUsers.filter(u => courtesyUserIds.has(u.id)).length;

  // Ingresos (sólo pagos reales)
  const rev150 = realPayments.filter(p => (p.amountCents||0) >= 15000).length;
  const rev120 = realPayments.filter(p => (p.amountCents||0) >= 11000 && (p.amountCents||0) < 15000).length;
  const rev100 = realPayments.filter(p => (p.amountCents||0) < 11000 && (p.amountCents||0) > 0).length;
  const revenueFullCount     = realPayments.filter(p => !p.discountApplied).length;
  const revenueDiscountCount = realPayments.filter(p =>  p.discountApplied).length;
  const totalRevenue = realPayments.reduce((sum, p) => sum + (p.amountCents || 0), 0) / 100;
  const totalReferrals = db.get('referrals').size().value();
  const totalReferrers = db.get('users').filter({ role: 'referrer' }).size().value();

  // ── Métricas demográficas ─────────────────────────────────────────────────
  const allUsers = db.get('users').value();
  const today = new Date();

  // Grupos de edad
  const ageGroups = { '<25': 0, '25-30': 0, '30-35': 0, '35-40': 0, '40+': 0, 'N/A': 0 };
  // Años en Australia
  const auYears = { '<1': 0, '1-2': 0, '2-3': 0, '3-5': 0, '5+': 0, 'N/A': 0 };
  // Tipo de trabajo
  const jobCats = {};
  // Funnel por paso de onboarding
  const funnelSteps = { personal: 0, documents: 0, payment: 0, done: 0, paid: 0, appointment: 0 };
  const funnelUsers = { personal: [], documents: [], payment: [], done: [], paid: [], appointment: [] };
  const paidUserIds = allPaidUserIds; // reusar base ya calculada
  const apptUserIds = new Set(db.get('appointments').map('userId').value());

  allUsers.forEach(u => {
    // Edad
    if (u.birthDate) {
      const bd = new Date(u.birthDate);
      const age = Math.floor((today - bd) / (365.25 * 864e5));
      if (age < 25) ageGroups['<25']++;
      else if (age < 30) ageGroups['25-30']++;
      else if (age < 35) ageGroups['30-35']++;
      else if (age < 40) ageGroups['35-40']++;
      else ageGroups['40+']++;
    } else { ageGroups['N/A']++; }

    // Años en AU
    if (u.arrivalDateInAustralia) {
      const arr = new Date(u.arrivalDateInAustralia);
      const yrs = (today - arr) / (365.25 * 864e5);
      if (yrs < 1) auYears['<1']++;
      else if (yrs < 2) auYears['1-2']++;
      else if (yrs < 3) auYears['2-3']++;
      else if (yrs < 5) auYears['3-5']++;
      else auYears['5+']++;
    } else { auYears['N/A']++; }

    // Trabajo
    const cat = u.jobCategory || 'Sin especificar';
    jobCats[cat] = (jobCats[cat] || 0) + 1;

    // Funnel
    const mini = { id: u.id, name: u.fullName || u.email, email: u.email };
    if (paidUserIds.has(u.id)) { funnelSteps.paid++; funnelUsers.paid.push(mini); }
    if (apptUserIds.has(u.id)) { funnelSteps.appointment++; funnelUsers.appointment.push(mini); }
    else if (u.onboardingStep === 'done') { funnelSteps.done++; funnelUsers.done.push(mini); }
    else if (u.onboardingStep === 'payment') { funnelSteps.payment++; funnelUsers.payment.push(mini); }
    else if (u.onboardingStep === 'documents') { funnelSteps.documents++; funnelUsers.documents.push(mini); }
    else { funnelSteps.personal++; funnelUsers.personal.push(mini); }
  });

  const jobCatsSorted = Object.entries(jobCats).sort((a, b) => b[1] - a[1]);

  // ── Kanban por etapa del trámite (base: paidUsers = todos los usuarios con pago confirmado) ──
  const kanban = {
    processing: paidUsers
      .filter(u => !u.taxReturnStage || u.taxReturnStage === 'processing')
      .map(u => ({ id: u.id, fullName: u.fullName || u.email, email: u.email })),
    with_agent: paidUsers
      .filter(u => u.taxReturnStage === 'with_agent')
      .map(u => ({ id: u.id, fullName: u.fullName || u.email, email: u.email, sentAt: u.taxAgentSentAt || null, assignedAgent: u.assignedAgent, agentPaid: u.agentPaid, refundReturned: u.refundReturned })),
    informal: paidUsers
      .filter(u => u.taxReturnStage === 'informal')
      .map(u => ({ id: u.id, fullName: u.fullName || u.email, email: u.email })),
    issued: paidUsers
      .filter(u => u.taxReturnStage === 'issued')
      .map(u => ({ id: u.id, fullName: u.fullName || u.email, email: u.email }))
  };

  res.render('admin/dashboard', {
    users: finalRows,
    q: q || '',
    status: status || '',
    totalUsers,
    totalReferrers,
    totalPaid,
    totalReferrals,
    totalRevenue,
    revenueFullCount,
    revenueDiscountCount,
    totalSentToAgent,
    totalInProcess,
    totalInformal,
    totalIssued,
    totalWithCollab,
    pendingEstimates,
    pendingPayments,
    rejectedPayments,
    pendingSuperPayments,
    formatSlot,
    deleted: req.query.deleted === '1',
    reminded: parseInt(req.query.reminded) || 0,
    rev150, rev120, rev100,
    metrics: { ageGroups, auYears, jobCatsSorted, funnelSteps, funnelUsers },
    kanban
  });
});

// ── Detalle de usuario ────────────────────────────────────────────────────────

router.get('/user/:id', (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('Usuario no encontrado.');

  const taxYearProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value();
  const documents = db.get('documents').filter({ userId: u.id }).value();
  const appt = db.get('appointments').find({ userId: u.id }).value();
  const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value()
    || db.get('payments').find({ userId: u.id, status: 'pending_manual' }).value()
    || null;
  const superPayment = db.get('super_payments').find({ userId: u.id }).value() || null;
  const pendingSuperPayment = db.get('super_payments').find({ userId: u.id, status: 'pending_manual' }).value() || null;
  const referralsMade = db.get('referrals').filter({ referrerUserId: u.id }).value().map(r => {
    const ref = db.get('users').find({ id: r.referredUserId }).value();
    return { ...r, referredName: ref ? ref.fullName : 'Eliminado', referredEmail: ref ? ref.email : '' };
  });

  // Quién refirió a este usuario
  let referredByUser = null;
  if (u.referredByCode) {
    referredByUser = db.get('users').find({ referralCode: u.referredByCode }).value() || null;
  }

  // Sumar por código ATO (para el email del tax agent)
  const dedSums = {};
  // Sumar por categoría de documento (para mostrar en panel admin — más detallado)
  const catSums = {};
  const CAT_DISPLAY = {
    logbook:               { label: 'D1 — Gastos de auto',                             ato: 'D1' },
    work_travel:           { label: 'D2 — Viajes de trabajo (no auto)',                ato: 'D2' },
    work_expenses:         { label: 'D3 — Ropa, uniforme y lavandería',                ato: 'D3' },
    training:              { label: 'D4 — Educación y capacitación',                   ato: 'D4' },
    certifications:        { label: 'D5 — Certificaciones y licencias',                ato: 'D5' },
    tech_purchases:        { label: 'D5 — Tecnología y otros gastos de trabajo',       ato: 'D5' },
    home_office:           { label: 'D6 — Home office',                                ato: 'D6' },
    investment_statements: { label: 'D7 — Intereses e inversiones / D8 — Dividendos', ato: 'D7' },
    donation_receipts:     { label: 'D9 — Donaciones',                                 ato: 'D9' },
  };
  documents.forEach(d => {
    const ded = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!ded) return; // sin código ATO no hay categoría deducible
    const hasAmt = !!d.adminAmount;
    const amount = hasAmt ? parseAdminAmt(d.adminAmount) : 0;
    // Por ATO code — solo los que tienen monto (para email tax agent)
    if (hasAmt) {
      if (!dedSums[ded]) dedSums[ded] = { total: 0, docs: [] };
      dedSums[ded].total += amount;
      dedSums[ded].docs.push({ name: d.originalName, amount, receiptRef: d.adminReceiptRef || null, notes: d.adminNotes || null, category: d.category });
    }
    // Por categoría — todos los docs con código ATO (con o sin monto)
    const cat = d.category;
    if (!catSums[cat]) catSums[cat] = { total: 0, count: 0, withAmount: 0, label: (CAT_DISPLAY[cat] || {}).label || cat, ato: ded };
    catSums[cat].total += amount;
    catSums[cat].count++;
    if (hasAmt) catSums[cat].withAmount++;
  });
  Object.keys(dedSums).forEach(k => { dedSums[k].total = Math.round(dedSums[k].total * 100) / 100; });
  Object.keys(catSums).forEach(k => { catSums[k].total = Math.round(catSums[k].total * 100) / 100; });

  const daspRequest = db.get('daspRequests').find({ userId: u.id }).value() || null;

  res.render('admin/user-detail', {
    u, taxYearProfiles, documents,
    financialYears: getFinancialYears(),
    categories: DOCUMENT_CATEGORIES,
    referralsMade, appt, payment, superPayment, pendingSuperPayment, formatSlot,
    referredByUser, dedSums, catSums, daspRequest,
    saved: req.query.saved === '1',
    taxAgentSent: req.query.taxAgentSent === '1',
    verificationSent: req.query.verification_sent === '1',
    verificationError: req.query.verification_error === '1',
    notified: req.query.notified === '1',
    errorMsg: req.query.error || null
  });
});

// ── Cambiar estado de solicitud DASP ─────────────────────────────────────────

router.post('/dasp/:daspId/status', requireAdmin, (req, res) => {
  const { daspId } = req.params;
  const status = (req.body.status || 'pending_review').trim();
  const dasp = db.get('daspRequests').find({ id: daspId });
  if (!dasp.value()) return res.status(404).send('DASP no encontrado.');
  const userId = dasp.value().userId;
  dasp.assign({ status, updatedAt: new Date().toISOString() }).write();
  res.redirect(`/admin/user/${userId}/dasp-preview`);
});

// ── Preview DASP para el tax agent ───────────────────────────────────────────

router.get('/user/:id/dasp-preview', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('Usuario no encontrado.');
  const daspRequest = db.get('daspRequests').find({ userId: u.id }).value();
  if (!daspRequest) return res.redirect(`/admin/user/${u.id}`);
  const tfn = (u.profile && u.profile.tfn) ? u.profile.tfn : (u.tfn || null);
  res.render('admin/dasp-preview', {
    u, daspRequest, tfn,
    sentOk:   req.query.sent === '1',
    errorMsg: req.query.error || null,
  });
});

// ── HTML preview del email que recibirá el tax agent ─────────────────────────

router.get('/user/:id/taxagent-email-preview', (req, res, next) => {
  // Allow taxagent role to view their clients' reports
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');
  const token = req.cookies.retaux_token;
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      const u = db.get('users').find({ id: p.id }).value();
      if (u && u.role === 'taxagent') {
        const client = db.get('users').find({ id: req.params.id }).value();
        if (client && client.taxAgentSentAt) { req.readonly = true; return next(); }
        return res.status(403).send('Client not available.');
      }
    } catch(e) {}
  }
  requireAdmin(req, res, next);
}, (req, res) => {
  const { UPLOAD_ROOT } = require('../middleware/upload');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('Usuario no encontrado.');

  const allDocs = sortDocsByCategory(db.get('documents').filter({ userId: u.id }).value());
  const employers = u.employers || [];
  const tfn = (u.profile && u.profile.tfn) ? u.profile.tfn : (u.tfn || null);

  const allFyProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value()
    .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
  const clientFyProfile = allFyProfiles[0] || {};

  const val   = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;
  const fmt   = (v) => val(v) || '—';
  const fmtDate = (v) => { if (!v) return '—'; const p = v.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : v; };
  const fmtAUD = (v) => (v !== undefined && v !== null && v !== '' && Number(v) > 0) ? `$${Number(v).toFixed(2)}` : null;

  const S = '#0A0E5C', Y = '#FFC107', R = '#DC2626';
  const secHead = (title) => `<tr><td colspan="3" style="padding:9px 14px;background:${S};color:#fff;font-weight:700;font-size:0.82rem;letter-spacing:0.06em;text-transform:uppercase;">${title}</td></tr>`;
  const dataRow = (label, ato, value) => { const missing = !value; return `<tr><td style="padding:7px 14px;font-weight:600;color:#374151;width:38%;border-bottom:1px solid #F0F4F8;font-size:0.88rem;">${label}</td><td style="padding:7px 8px;color:#6B7280;font-size:0.78rem;width:8%;border-bottom:1px solid #F0F4F8;font-family:monospace;">${ato||''}</td><td style="padding:7px 14px;border-bottom:1px solid #F0F4F8;font-size:0.88rem;${missing?`color:${R};font-weight:600;`:'color:#111827;'}">${missing?'⚠ Missing':value}</td></tr>`; };
  const subHead = (title) => `<tr><td colspan="3" style="padding:7px 14px;background:#EFF6FF;color:#1D4ED8;font-weight:700;font-size:0.8rem;border-bottom:1px solid #DBEAFE;">${title}</td></tr>`;

  // dedSums
  const dedSums = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amt = parseAdminAmt(d.adminAmount);
    if (!dedSums[code]) dedSums[code] = { total: 0 };
    dedSums[code].total += amt;
  });
  Object.keys(dedSums).forEach(k => { dedSums[k].total = Math.round(dedSums[k].total * 100) / 100; });

  const CAT_DISPLAY_EMAIL = {
    logbook:               { label: 'D1 — Work-related car expenses',                    ato: 'D1' },
    work_travel:           { label: 'D2 — Work-related travel expenses',                 ato: 'D2' },
    work_expenses:         { label: 'D3 — Clothing, laundry & dry-cleaning',             ato: 'D3' },
    training:              { label: 'D4 — Work-related self-education',                  ato: 'D4' },
    certifications:        { label: 'D5 — Certifications & licences',                    ato: 'D5' },
    tech_purchases:        { label: 'D5 — Technology & other work expenses',             ato: 'D5' },
    home_office:           { label: 'D6 — Home office expenses',                         ato: 'D6' },
    investment_statements: { label: 'D7/D8 — Interest income & dividend deductions',     ato: 'D7' },
    donation_receipts:     { label: 'D9 — Gifts or donations',                           ato: 'D9' },
  };
  const catSumsEmail = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amt = parseAdminAmt(d.adminAmount);
    const cat = d.category;
    if (!catSumsEmail[cat]) catSumsEmail[cat] = { total: 0, count: 0, label: (CAT_DISPLAY_EMAIL[cat] || {}).label || cat, ato: code, docs: [] };
    catSumsEmail[cat].total += amt;
    catSumsEmail[cat].count++;
    catSumsEmail[cat].docs.push({ name: d.originalName || d.storedFilename, amount: amt, receiptRef: d.adminReceiptRef || null });
  });
  Object.keys(catSumsEmail).forEach(k => { catSumsEmail[k].total = Math.round(catSumsEmail[k].total * 100) / 100; });

  // Empleadores
  let empHTML = '';
  if (!employers.length) { empHTML = dataRow('Employers', '', null); }
  else { employers.forEach((emp, i) => { empHTML += subHead(`Employer ${i+1}: ${emp.name || '—'}`); empHTML += dataRow('ABN', 'ABN', fmt(emp.abn)); empHTML += dataRow('Gross Income', '1', fmtAUD(emp.grossIncome)); empHTML += dataRow('Tax Withheld', '2', fmtAUD(emp.taxWithheld)); empHTML += dataRow('Period From', '', fmt(emp.periodFrom)); empHTML += dataRow('Period To', '', fmt(emp.periodTo)); }); }

  // Deducciones
  const DEDUCTION_LIST = [
    { label:'D1 — Work-related car expenses',                ato:'D1',  key:'deductionD1'  },
    { label:'D2 — Work-related travel expenses',             ato:'D2',  key:'deductionD2'  },
    { label:'D3 — Clothing, laundry & dry-cleaning',         ato:'D3',  key:'deductionD3'  },
    { label:'D4 — Work-related self-education expenses',     ato:'D4',  key:'deductionD4'  },
    { label:'D5 — Other work-related expenses',              ato:'D5',  key:'deductionD5'  },
    { label:'D6 — Home office expenses',                     ato:'D6',  key:'deductionD6'  },
    { label:'D7 — Interest income deductions',               ato:'D7',  key:'deductionD7'  },
    { label:'D8 — Dividend deductions',                      ato:'D8',  key:'deductionD8'  },
    { label:'D9 — Gifts or donations',                       ato:'D9',  key:'deductionD9'  },
    { label:'D10 — Cost of managing tax affairs',            ato:'D10', key:'deductionD10' },
  ];
  let deductHTML = '', totalDeductions = 0;
  DEDUCTION_LIST.forEach(d => {
    const amount = d.ato === 'D1' ? u[d.key] : (dedSums[d.ato] ? dedSums[d.ato].total : u[d.key]);
    const fmted = fmtAUD(amount);
    if (fmted) totalDeductions += Number(amount);
    deductHTML += dataRow(d.label, d.ato, fmted);
    if (d.ato === 'D1' && clientFyProfile && clientFyProfile.carWorkKm) {
      const km = Number(clientFyProfile.carWorkKm), aud = (km * 0.88).toFixed(2);
      deductHTML += `<tr><td colspan="3" style="padding:5px 14px 8px 28px;background:#EFF6FF;border-bottom:1px solid #BFDBFE;font-size:0.82rem;color:#1D4ED8;">🚗 <strong>${km} km × $0.88 = AUD $${aud}</strong>${km > 5000 ? ' ⚠ supera 5,000 km' : ''}</td></tr>`;
    }
    if (d.ato !== 'D1') {
      Object.values(catSumsEmail).filter(cs => cs.ato === d.ato).forEach(cs => {
        deductHTML += `<tr><td colspan="3" style="padding:3px 14px 3px 28px;background:#F0FDF4;border-bottom:1px solid #D1FAE5;font-size:0.78rem;color:#166534;">&nbsp;&nbsp;↳ <strong>${cs.label}</strong>: AUD $${cs.total.toFixed(2)} <span style="color:#6B7280;">(${cs.count} factura${cs.count!==1?'s':''})</span>${cs.docs.map(doc=>`<span style="display:block;padding-left:16px;color:#4B5563;font-size:0.73rem;">• ${doc.name}${doc.receiptRef?' #'+doc.receiptRef:''} — AUD $${doc.amount.toFixed(2)}</span>`).join('')}</td></tr>`;
      });
    }
  });
  deductHTML += `<tr><td colspan="2" style="padding:8px 14px;font-weight:700;font-size:0.88rem;background:#FFF8E1;border-top:2px solid ${Y};">TOTAL DEDUCTIONS</td><td style="padding:8px 14px;font-weight:700;font-size:0.88rem;background:#FFF8E1;border-top:2px solid ${Y};">${totalDeductions > 0 ? `$${totalDeductions.toFixed(2)}` : '—'}</td></tr>`;

  // Documentos — solo listar nombres, no leer binario
  const UNSUPPORTED_EXTS = ['.heic', '.heif', '.webp', '.avif'];
  const resolvePath = (d) => {
    const candidates = [
      path.join(UPLOAD_ROOT, u.id, d.storedFilename),
      path.join(UPLOAD_ROOT, u.id, 'general', d.storedFilename),
      path.join(UPLOAD_ROOT, u.id, d.taxYear || 'general', d.storedFilename),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  };
  const CAT_LABELS_EMAIL = { selfie_id:'Identity Document (Passport / ID)', payslips:'Payslips', abn_income:'ABN Income Records', logbook:'D1 — Work-related car expenses', work_travel:'D2 — Work-related travel expenses', work_expenses:'D3 — Clothing, laundry & dry-cleaning', training:'D4 — Work-related self-education', certifications:'D5 — Certifications & licences', tech_purchases:'D5 — Technology & other work expenses', home_office:'D6 — Home office expenses', investment_statements:'D7/D8 — Investment & dividend statements', donation_receipts:'D9 — Gifts or donations', bank_statement:'Bank Statement' };
  const docsByCat = {}, notFound = [], incompatibleList = [];
  allDocs.forEach(d => {
    const finalPath = resolvePath(d);
    const catLabel = CAT_LABELS_EMAIL[d.category] || d.category || 'Other';
    const ext = path.extname((d.originalName || d.storedFilename) || '').toLowerCase();
    if (!finalPath) { notFound.push({ name: d.originalName || d.storedFilename, catLabel }); return; }
    if (UNSUPPORTED_EXTS.includes(ext)) { incompatibleList.push({ name: d.originalName || d.storedFilename, catLabel, ext }); return; }
    if (!docsByCat[catLabel]) docsByCat[catLabel] = [];
    docsByCat[catLabel].push(d.originalName || d.storedFilename);
  });
  let docsHTML = '';
  const totalAttached = Object.values(docsByCat).reduce((s, arr) => s + arr.length, 0);
  if (totalAttached === 0 && !notFound.length) { docsHTML = `<tr><td colspan="3" style="padding:8px 14px;color:${R};font-weight:600;">⚠ No documents uploaded</td></tr>`; }
  else {
    Object.entries(docsByCat).forEach(([cat, files]) => { docsHTML += subHead(`${cat} (${files.length} file${files.length>1?'s':''})`); files.forEach(f => { docsHTML += `<tr><td colspan="3" style="padding:5px 14px 5px 28px;color:#111827;font-size:0.85rem;border-bottom:1px solid #F0F4F8;">📎 ${f}</td></tr>`; }); });
    if (incompatibleList.length) { docsHTML += subHead(`⚠ Archivos incompatibles — irán en bundle descargable (${incompatibleList.length})`); incompatibleList.forEach(f => { docsHTML += `<tr><td colspan="3" style="padding:5px 14px 5px 28px;color:#92400E;font-size:0.85rem;border-bottom:1px solid #F0F4F8;">📦 [${f.ext}] ${f.name} <em>(${f.catLabel})</em></td></tr>`; }); }
    if (notFound.length) { docsHTML += subHead(`✗ Archivos no encontrados en servidor (${notFound.length})`); notFound.forEach(f => { docsHTML += `<tr><td colspan="3" style="padding:5px 14px 5px 28px;color:${R};font-size:0.85rem;border-bottom:1px solid #F0F4F8;">✗ ${f.name} <em>(${f.catLabel})</em></td></tr>`; }); }
  }

  const dateStr = new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'long', year:'numeric' });
  const clientName = u.fullName || u.email;

  const emailHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Email Preview — ${clientName}</title></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #E5E7EB;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
  <div style="background:${S};padding:24px 28px;">
    <div style="font-size:1.25rem;font-weight:700;color:#fff;margin-bottom:6px;">Individual Tax Return — Client File</div>
    <div style="font-size:0.85rem;color:rgba(255,255,255,0.65);">Prepared for tax agent review · ${dateStr}</div>
  </div>
  <div style="padding:16px 28px;background:#FFFBEB;border-bottom:1px solid #FDE68A;">
    <p style="margin:0;font-size:0.92rem;color:#78350F;">Please find below the complete tax return information for <strong>${clientName}</strong>. All supporting documents are attached to this email, labelled by category. If any information is marked <span style="color:${R};font-weight:600;">⚠ Missing</span>, please contact the client before lodging.</p>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
    ${secHead('1. Personal Information')}
    ${dataRow('Full Name','',fmt(u.fullName))}
    ${dataRow('Email','',fmt(u.email))}
    ${dataRow('Phone / Mobile','',fmt(u.phone || u.mobile))}
    ${dataRow('Date of Birth','',fmtDate(u.birthDate))}
    ${dataRow('Gender','',fmt(u.gender))}
    ${dataRow('Country of Birth','',fmt(u.countryOfBirth || u.nationality))}
    ${dataRow('Nationality','',fmt(u.nationality))}
    ${dataRow('Tax File Number (TFN)','TFN',fmt(tfn))}
    ${dataRow('ABN','ABN',fmt(u.abn))}
    ${dataRow('Main Salary and Wages Occupation','',fmt(u.occupation))}
    ${clientFyProfile && clientFyProfile.jobsDescription ? dataRow('Jobs / Roles Performed','',fmt(clientFyProfile.jobsDescription)) : ''}
    ${clientFyProfile && clientFyProfile.workLocations ? dataRow('Work Locations','',fmt(clientFyProfile.workLocations)) : ''}
    ${dataRow('Current Address','',fmt(u.currentAddress))}
    ${dataRow('Suburb','',fmt(u.suburb))}
    ${dataRow('State','',fmt(u.state))}
    ${dataRow('Postcode','',fmt(u.postcode))}
    ${secHead('Bank Account Details (Refund)')}
    ${dataRow('Bank / Institution','',fmt(u.bankInstitution))}
    ${dataRow('Account Holder Name','',fmt(u.bankAccountName))}
    ${dataRow('BSB','',fmt(u.bankBSB || u.bsb))}
    ${dataRow('Account Number','',fmt(u.bankAccount || u.accountNumber))}
    ${dataRow('Bank Name','',fmt(u.bankName))}
    ${secHead('2. Visa & Residency')}
    ${dataRow('Visa Subclass','',fmt(u.currentVisaSubclass))}
    ${dataRow('Visa Start Date','',fmt(u.visaStartDate))}
    ${dataRow('Visa End Date','',fmt(u.visaEndDate))}
    ${dataRow('Tax Residency Status','',fmt(u.taxResidencyStatus))}
    ${dataRow('First Year as Resident','',fmt(u.firstYearResident))}
    ${dataRow('Date Arrived in Australia','',fmt(u.dateArrived))}
    ${secHead('3. Employment Income')}
    ${empHTML}
    ${secHead('4. Other Income')}
    ${dataRow('Bank Interest','10',fmtAUD(u.bankInterest))}
    ${dataRow('Other Income','',fmtAUD(u.otherIncome))}
    ${(() => {
      const abnDocs = allDocs.filter(d => d.category === 'abn_income');
      if (!abnDocs.length) return '';
      const total = Math.round(abnDocs.reduce((s, d) => s + parseAdminAmt(d.adminAmount), 0) * 100) / 100;
      const abn = u.abn || (employers.length ? (employers[0].abn || '') : '');
      if (!total) return '';
      return `<tr><td colspan="3" style="padding:6px 14px 6px 28px;background:#FFF8E1;border-bottom:1px solid #FDE68A;font-size:0.82rem;color:#92400E;">
        🧾 <strong>ABN Income (included in Other Income):</strong> AUD $${total.toFixed(2)}${abn ? ` &nbsp;<span style="font-family:monospace;background:#FEF3C7;padding:1px 6px;border-radius:3px;">ABN ${abn}</span>` : ''}
        ${abnDocs.map(d => `<div style="padding-left:16px;color:#78350F;font-size:0.78rem;">• ${d.originalName||d.storedFilename}${parseAdminAmt(d.adminAmount)>0?' — $'+parseAdminAmt(d.adminAmount).toFixed(2):''}</div>`).join('')}
      </td></tr>`;
    })()}
    ${secHead('5. Deductions')}
    ${deductHTML}
    ${secHead('6. Vehicle Information')}
    ${dataRow('Has Work-Related Vehicle','',clientFyProfile.hasCar?'Yes':'No')}
    ${clientFyProfile.hasCar ? `${dataRow('Make','',fmt(clientFyProfile.carBrand))}${dataRow('Model','',fmt(clientFyProfile.carModel))}${dataRow('Year','',fmt(clientFyProfile.carYear))}${dataRow('Plate','',fmt(clientFyProfile.carPlate))}${dataRow('Work-Related Km','D1',clientFyProfile.carWorkKm?`${clientFyProfile.carWorkKm} km`:'—')}` : ''}
    ${secHead('7. Private Health Insurance (Medicare)')}
    ${dataRow('Has Private Health Insurance','',clientFyProfile.hasHealthInsurance?'Yes':'No')}
    ${clientFyProfile.hasHealthInsurance?`
    ${dataRow('Provider','',fmt(clientFyProfile.healthProvider))}
    ${dataRow('Member Number','',fmt(clientFyProfile.healthMemberNumber))}
    ${dataRow('Plan Type','',fmt(clientFyProfile.healthPlanType))}
    ${dataRow('Cover From','',fmt(clientFyProfile.healthStartDate))}
    ${dataRow('Cover To','',fmt(clientFyProfile.healthEndDate))}
    `:''}
    ${secHead(`8. Documents Attached (${totalAttached} file${totalAttached!==1?'s':''})`)}
    ${docsHTML}
  </table>
  <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">
    This file was prepared by RETAUX (www.retaux.com) on behalf of the client and is intended solely for the named tax agent. For queries contact hola@retaux.com
  </div>
</div>
</body></html>`;

  // Envolver en página con banner de preview
  const page = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Preview — ${clientName}</title>
<style>body{margin:0;background:#1e293b;font-family:Arial,sans-serif;} .banner{position:sticky;top:0;z-index:99;background:#B45309;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;font-size:0.88rem;} .banner strong{font-size:1rem;} .banner a{color:#FDE68A;font-weight:700;text-decoration:none;margin-left:auto;} .wrap{padding:0 0 40px;}</style>
</head><body>
<div class="banner">
  <span>👁</span>
  <div><strong>VISTA PREVIA DEL EMAIL</strong> — no se ha enviado nada. Este es el HTML exacto que recibirá el tax agent para <strong>${clientName}</strong>.</div>
  <a href="/admin/user/${u.id}/taxagent-preview">← Volver a preparación</a>
</div>
<div class="wrap">${emailHTML}</div>
</body></html>`;

  res.send(page);
});

// ── Preview antes de enviar al tax agent ─────────────────────────────────────

router.get('/user/:id/taxagent-preview', requireAdmin, (req, res) => {
  const { UPLOAD_ROOT } = require('../middleware/upload');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const allDocs = sortDocsByCategory(db.get('documents').filter({ userId: u.id }).value());
  const employers = u.employers || [];
  const tfn = (u.profile && u.profile.tfn) ? u.profile.tfn : (u.tfn || null);

  const CAT_LABELS = {
    selfie_id:            'Identity Document (Passport / ID)',
    payslips:             'Payslips',
    abn_income:           'ABN Income Records',
    logbook:              'D1 — Work-related car expenses',
    work_travel:          'D2 — Work-related travel expenses',
    work_expenses:        'D3 — Clothing, laundry & dry-cleaning',
    training:             'D4 — Work-related self-education',
    certifications:       'D5 — Certifications & licences',
    tech_purchases:       'D5 — Technology & other work expenses',
    home_office:          'D6 — Home office expenses',
    investment_statements:'D7/D8 — Investment & dividend statements',
    donation_receipts:    'D9 — Gifts or donations',
    bank_statement:       'Bank Statement',
  };

  const resolvePath = (d) => {
    const candidates = [
      path.join(UPLOAD_ROOT, u.id, d.storedFilename),
      path.join(UPLOAD_ROOT, u.id, 'general', d.storedFilename),
      path.join(UPLOAD_ROOT, u.id, d.taxYear || 'general', d.storedFilename),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  };

  const docsFound = [];
  const docsNotFound = [];
  allDocs.forEach(d => {
    const catLabel = CAT_LABELS[d.category] || d.category || 'Other';
    const originalName = d.originalName || d.storedFilename;
    if (resolvePath(d)) docsFound.push({ catLabel, originalName });
    else docsNotFound.push({ catLabel, originalName });
  });

  // Sumar adminAmount por código — usa adminDedCode si existe, sino CAT_TO_DED_MAP
  const dedSums = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amount = parseAdminAmt(d.adminAmount);
    if (!dedSums[code]) dedSums[code] = { total: 0, docs: [] };
    dedSums[code].total += amount;
    dedSums[code].docs.push({ name: d.originalName || d.storedFilename, amount, receiptRef: d.adminReceiptRef || null });
  });
  Object.keys(dedSums).forEach(k => { dedSums[k].total = Math.round(dedSums[k].total * 100) / 100; });

  // Docs sin monto por código ATO (para mostrar aviso en taxagent-preview)
  const dedPending = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || d.adminAmount) return;
    dedPending[code] = (dedPending[code] || 0) + 1;
  });

  // Auto-poblar deductionDX desde taxYearProfile del cliente si el admin aún no lo cargó
  const fyProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value();
  const fyProfile = fyProfiles && fyProfiles.length ? fyProfiles[0] : null;

  const FY_MAP = {
    deductionD1:  'ded_d1',
    deductionD2:  'ded_d2',
    deductionD3:  'ded_d3',
    deductionD4:  'ded_d4',
    deductionD5:  'ded_d5',
    deductionD6:  'ded_d6',
    deductionD9:  'ded_d9',
    deductionD10: 'ded_d10',
  };

  const autoPatch = {};
  if (fyProfile) {
    Object.entries(FY_MAP).forEach(([adminField, fyField]) => {
      if (!u[adminField] && fyProfile[fyField] != null) {
        autoPatch[adminField] = parseFloat(fyProfile[fyField]) || 0;
      }
    });
  }
  // Siempre sobrescribir con dedSums cuando existen facturas asignadas (excepto D1 que va por km)
  Object.entries(dedSums).forEach(([code, data]) => {
    if (code === 'D1') return;
    const field = 'deduction' + code;
    if (data.total > 0) autoPatch[field] = data.total;
  });

  if (Object.keys(autoPatch).length > 0) {
    db.get('users').find({ id: u.id }).assign(autoPatch).write();
    Object.assign(u, autoPatch);
  }

  // catSumsEmail — archivos agrupados por categoría (para mostrar desglose en preview)
  const CAT_DISPLAY_PREV = {
    logbook:           { label: 'D1 — Gastos de auto',                         ato: 'D1' },
    work_travel:       { label: 'D2 — Viajes de trabajo (no auto)',             ato: 'D2' },
    work_expenses:     { label: 'D3 — Ropa, uniforme y lavandería',             ato: 'D3' },
    training:          { label: 'D4 — Educación y capacitación',                ato: 'D4' },
    certifications:        { label: 'D5 — Certificaciones y licencias',                 ato: 'D5' },
    tech_purchases:        { label: 'D5 — Tecnología y otros gastos de trabajo',        ato: 'D5' },
    home_office:           { label: 'D6 — Home office',                                 ato: 'D6' },
    investment_statements: { label: 'D7/D8 — Inversiones e intereses / Dividendos',    ato: 'D7' },
    donation_receipts:     { label: 'D9 — Donaciones',                                  ato: 'D9' },
  };
  const catSumsEmail = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amt = parseAdminAmt(d.adminAmount);
    const cat = d.category;
    const key = `${cat}__${code}`;
    if (!catSumsEmail[key]) catSumsEmail[key] = { total: 0, count: 0, label: (CAT_DISPLAY_PREV[cat] || {}).label || cat, ato: code, docs: [] };
    catSumsEmail[key].total += amt;
    catSumsEmail[key].count++;
    catSumsEmail[key].docs.push({ name: d.originalName || d.storedFilename, amount: amt, receiptRef: d.adminReceiptRef || null });
  });
  Object.keys(catSumsEmail).forEach(k => { catSumsEmail[k].total = Math.round(catSumsEmail[k].total * 100) / 100; });

  // Sumar facturas ABN income para mostrar en "Otros ingresos"
  let abnIncomeTotal = 0;
  const abnIncomeDocs = [];
  allDocs.filter(d => d.category === 'abn_income').forEach(d => {
    const amt = parseAdminAmt(d.adminAmount);
    abnIncomeTotal += amt;
    abnIncomeDocs.push({ name: d.originalName || d.storedFilename, amount: amt });
  });
  abnIncomeTotal = Math.round(abnIncomeTotal * 100) / 100;
  const abnNumber = u.abn || (employers.length ? (employers[0].abn || '') : '');

  const daspRequest = db.get('daspRequests').find({ userId: u.id }).value() || null;
  const hasTaxReturn = !!(db.get('payments').find({ userId: u.id, status: 'paid' }).value());
  // Si el cliente solo tiene DASP y no tax return, redirigir directamente
  if (daspRequest && !hasTaxReturn) {
    return res.redirect(`/admin/user/${u.id}/dasp-preview`);
  }
  res.render('admin/taxagent-preview', { u, employers, tfn, docsFound, docsNotFound, dedSums, dedPending, catSumsEmail, fyProfile, abnIncomeTotal, abnIncomeDocs, abnNumber, daspRequest });
});

// ── Formulario ENPRESA pre-llenado ────────────────────────────────────────────
function buildEnpresaFormHtml({ u, employers, tfn, clientFyProfile, dedSums, allDocs, dateStr, signature }) {
  const val  = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : '';
  const fmtA = (v) => (v !== undefined && v !== null && v !== '' && Number(v) > 0) ? `$${Number(v).toFixed(2)} AUD` : '';
  const yesNo = (v) => v ? '☑ Yes  ☐ No' : '☐ Yes  ☑ No';
  const blank = (v) => val(v) || '_______________';

  // ABN income total desde documentos
  const abnIncomeDocs = allDocs.filter(d => d.category === 'abn_income');
  const abnIncomeTotal = Math.round(abnIncomeDocs.reduce((s, d) => s + (parseFloat(String(d.adminAmount||'').replace(',','.')) || 0), 0) * 100) / 100;
  const abnNumber = val(u.abn) || (employers.length ? val(employers[0].abn) : '');

  const S = '#0A0E5C', Y = '#FFC107';

  const sec = (n, title) => `
    <tr><td colspan="2" style="background:${S};color:#fff;font-weight:700;font-size:0.82rem;letter-spacing:0.06em;text-transform:uppercase;padding:8px 14px;">
      SECTION ${n} — ${title}
    </td></tr>`;

  const row = (label, value, highlight) => `
    <tr style="${highlight ? 'background:#FFFBEB;' : ''}">
      <td style="padding:7px 14px;font-weight:600;color:#374151;width:45%;border-bottom:1px solid #F0F4F8;font-size:0.85rem;">${label}</td>
      <td style="padding:7px 14px;color:#111827;border-bottom:1px solid #F0F4F8;font-size:0.85rem;font-family:${value && value.match(/^\$/) ? 'monospace' : 'inherit'};">${value || '<span style="color:#9CA3AF;">—</span>'}</td>
    </tr>`;

  const subrow = (label, value) => `
    <tr style="background:#F8FAFC;">
      <td style="padding:5px 14px 5px 28px;color:#6B7280;font-size:0.82rem;border-bottom:1px solid #F0F4F8;">↳ ${label}</td>
      <td style="padding:5px 14px;color:#374151;font-size:0.82rem;border-bottom:1px solid #F0F4F8;">${value || '—'}</td>
    </tr>`;

  let empRows = '';
  if (employers.length === 0) {
    empRows = row('Employer', '—');
  } else {
    employers.forEach((emp, i) => {
      empRows += row(`Employer ${i+1}`, val(emp.name));
      empRows += subrow('ABN', val(emp.abn));
      empRows += subrow('Gross Income (Item 1)', fmtA(emp.grossIncome));
      empRows += subrow('Tax Withheld (Item 2)', fmtA(emp.taxWithheld));
      empRows += subrow('Period', `${val(emp.periodFrom) || '—'} → ${val(emp.periodTo) || '—'}`);
    });
  }

  const km = clientFyProfile && clientFyProfile.carWorkKm ? Number(clientFyProfile.carWorkKm) : 0;
  const deductionD1 = u.deductionD1 || (km ? km * 0.88 : 0);

  const clientRef = `RETAUX-${u.id.slice(0,8).toUpperCase()}`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>ENPRESA Client Details Form — ${val(u.fullName) || clientRef}</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #E5E7EB;">

  <!-- Header -->
  <div style="background:${S};padding:24px 28px;">
    <div style="font-size:0.8rem;font-weight:700;color:${Y};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">ENPRESA OF ACCOUNTING & FINANCE</div>
    <div style="font-size:1.3rem;font-weight:700;color:#fff;margin-bottom:4px;">Individual Tax Return — Client Details Form</div>
    <div style="font-size:0.83rem;color:rgba(255,255,255,0.65);">Income Year 2025–26 · Prepared ${dateStr} · Ref: ${clientRef}</div>
  </div>

  <!-- Privacy notice -->
  <div style="padding:10px 20px;background:#FEF3C7;border-bottom:1px solid #FDE68A;font-size:0.8rem;color:#92400E;">
    ⚠ <strong>Confidential:</strong> Client contact details are withheld. Use Ref <strong>${clientRef}</strong> for all correspondence. TFN provided separately via secure channel.
    Tax services provided under the supervision of The Accounting Academy Services Pty Ltd.
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">

    ${sec(1, 'Personal Details')}
    ${row('Full Legal Name', blank(u.fullName), true)}
    ${row('Date of Birth', blank(u.birthDate))}
    ${row('Main Salary and Wages Occupation', blank(u.occupation))}
    ${row('Current Address', blank(u.currentAddress))}
    ${row('ABN', blank(abnNumber))}
    ${row('Tax File Number (TFN)', '⚠ Provided separately via secure channel')}
    ${row('Client Reference', clientRef)}

    ${sec(2, 'Contact')}
    ${row('Email', '⚠ Withheld — contact via RETAUX platform')}
    ${row('Phone', '⚠ Withheld — contact via RETAUX platform')}

    ${sec(3, 'Residency & Visa Status')}
    ${row('Australian Resident for Tax Purposes', yesNo(u.taxResidencyStatus === 'resident' || !u.taxResidencyStatus))}
    ${row('Visa Subclass', blank(u.currentVisaSubclass))}
    ${row('Visa Start Date', blank(u.visaStartDate))}
    ${row('Visa End Date', blank(u.visaEndDate))}
    ${row('Date Arrived in Australia', blank(u.dateArrived))}
    ${row('Nationality', blank(u.nationality))}

    ${sec(4, 'Employment Income')}
    ${empRows}
    ${row('More Than One Employer During the Year', employers.length > 1 ? '☑ Yes  ☐ No' : '☐ Yes  ☑ No')}

    ${sec(5, 'Other Income')}
    ${row('ABN / Sole Trader Income', abnIncomeTotal > 0 ? `☑ Yes — ${fmtA(abnIncomeTotal)} (${abnIncomeDocs.length} invoice${abnIncomeDocs.length!==1?'s':''})` : '☐ Yes  ☑ No')}
    ${abnIncomeTotal > 0 ? subrow('ABN', blank(abnNumber)) : ''}
    ${abnIncomeTotal > 0 ? abnIncomeDocs.map(d => subrow('Invoice', `${d.originalName||''} ${d.adminAmount ? '— $'+d.adminAmount : ''}`)).join('') : ''}
    ${row('Bank Interest / Term Deposits', u.bankInterest > 0 ? `☑ Yes — ${fmtA(u.bankInterest)}` : '☐ Yes  ☑ No')}
    ${row('Other Income', u.otherIncome > 0 ? `☑ Yes — ${fmtA(u.otherIncome)}` : '☐ Yes  ☑ No')}

    ${sec(6, 'Deductions')}
    ${row('Work-Related Car Expenses (D1)', deductionD1 > 0 ? `☑ Yes — ${fmtA(deductionD1)}` : '☐ Yes  ☑ No')}
    ${deductionD1 > 0 && km > 0 ? subrow('Method / Kilometres', `Cents per km — ${km} km × $0.88`) : ''}
    ${clientFyProfile && clientFyProfile.vehicles && clientFyProfile.vehicles.length ? clientFyProfile.vehicles.map(v => subrow('Vehicle', `${v.brand||''} ${v.model||''} ${v.year||''} — ${v.plate||''}`)).join('') : ''}
    ${row('Clothing, Uniform & Laundry (D3)', u.deductionD3 > 0 ? `☑ Yes — ${fmtA(u.deductionD3)}` : '☐ Yes  ☑ No')}
    ${row('Self-Education Expenses (D4)', u.deductionD4 > 0 ? `☑ Yes — ${fmtA(u.deductionD4)}` : '☐ Yes  ☑ No')}
    ${row('Tools, Technology & Other Work Expenses (D5)', u.deductionD5 > 0 ? `☑ Yes — ${fmtA(u.deductionD5)}` : '☐ Yes  ☑ No')}
    ${row('Home Office Expenses (D6)', u.deductionD6 > 0 ? `☑ Yes — ${fmtA(u.deductionD6)}` : '☐ Yes  ☑ No')}
    ${row('Gifts or Donations (D9)', u.deductionD9 > 0 ? `☑ Yes — ${fmtA(u.deductionD9)}` : '☐ Yes  ☑ No')}
    ${row('Cost of Managing Tax Affairs (D10)', u.deductionD10 > 0 ? `☑ Yes — ${fmtA(u.deductionD10)}` : '☐ Yes  ☑ No')}

    ${sec('4b', 'Private Health Insurance')}
    ${row('Has Private Health Insurance', yesNo(clientFyProfile && clientFyProfile.hasHealthInsurance))}
    ${clientFyProfile && clientFyProfile.hasHealthInsurance ? `
      ${subrow('Provider', blank(clientFyProfile.healthProvider))}
      ${subrow('Member Number', blank(clientFyProfile.healthMemberNumber))}
      ${subrow('Plan Type', blank(clientFyProfile.healthPlanType))}
      ${subrow('Cover Period', `${blank(clientFyProfile.healthStartDate)} → ${blank(clientFyProfile.healthEndDate)}`)}
    ` : ''}

    ${sec('12', 'Bank Account Details (Refund)')}
    ${row('Account Holder Name', blank(u.bankAccountName))}
    ${row('BSB', blank(u.bankBSB || u.bsb))}
    ${row('Account Number', blank(u.bankAccount || u.accountNumber))}
    ${row('Bank Name', blank(u.bankName))}

    <!-- Signature block -->
    <tr><td colspan="2" style="padding:20px 14px;">
      <div style="border:1px solid #E5E7EB;border-radius:6px;padding:14px 16px;background:#F9FAFB;">
        <div style="font-size:0.78rem;font-weight:700;color:${S};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Client Declaration</div>
        <div style="font-size:0.8rem;color:#374151;margin-bottom:14px;">I declare that the information provided in this form and in all supporting documents is true and correct to the best of my knowledge. I authorise ENPRESA OF ACCOUNTING & FINANCE, acting under the supervision of The Accounting Academy Services Pty Ltd, to use this information solely for the agreed tax services.</div>
        <div style="display:flex;gap:40px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.75rem;color:#6B7280;margin-bottom:4px;">Client Full Name</div>
            <div style="border-bottom:1.5px solid #374151;min-width:200px;padding-bottom:2px;font-size:0.9rem;color:#111827;">${signature ? signature.name : (val(u.fullName) || '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;')}</div>
          </div>
          <div>
            <div style="font-size:0.75rem;color:#6B7280;margin-bottom:4px;">Date</div>
            <div style="border-bottom:1.5px solid #374151;min-width:120px;padding-bottom:2px;font-size:0.9rem;color:${signature ? '#111827' : '#9CA3AF'};">${signature ? signature.date : dateStr}</div>
          </div>
          <div>
            <div style="font-size:0.75rem;color:#6B7280;margin-bottom:4px;">(e)Signature</div>
            <div style="border-bottom:1.5px solid #374151;min-width:200px;padding-bottom:2px;font-size:0.9rem;color:#065F46;">${signature ? '✅ Firmado electrónicamente — ' + signature.signedAt : '&nbsp;'}</div>
          </div>
        </div>
      </div>
    </td></tr>

  </table>

  <div style="padding:12px 20px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.75rem;color:#9CA3AF;">
    ENPRESA OF ACCOUNTING &amp; FINANCE · Tax services provided under the supervision of The Accounting Academy Services Pty Ltd · Confidential
  </div>
</div>
</body></html>`;
}

// ── Enviar email al tax agent ─────────────────────────────────────────────────

const _multer = require('multer');
const _multerMemory = _multer({ storage: _multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function handleTaxAgentUpload(req, res, next) {
  _multerMemory.array('extraFiles', 20)(req, res, (err) => {
    if (err) {
      console.error('[TAXAGENT UPLOAD] Multer error:', err.message);
      req.multerError = err.message;
    }
    console.log(`[TAXAGENT UPLOAD] Extra files received: ${(req.files || []).length}`);
    next();
  });
}

router.post('/user/:id/send-verification', requireAdmin, async (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');
  if (u.emailVerified) return res.redirect(`/admin/user/${u.id}?info=already_verified`);

  const crypto = require('crypto');
  const CODE_TTL_MS = 48 * 60 * 60 * 1000; // 48h para códigos manuales
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.get('users').find({ id: u.id }).assign({ verificationCode: code, verificationCodeExpires: expires }).write();

  try {
    const { sendWelcomeVerification } = require('../lib/emails');
    await Promise.race([
      sendWelcomeVerification({ ...u, verificationCode: code, verificationCodeExpires: expires }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
    ]);
    console.log(`[ADMIN] Código de verificación enviado a ${u.email}: ${code}`);
    res.redirect(`/admin/user/${u.id}?verification_sent=1`);
  } catch (e) {
    console.error(`[ADMIN] Error enviando verificación a ${u.email}:`, e.message);
    res.redirect(`/admin/user/${u.id}?verification_error=1`);
  }
});

router.post('/user/:id/send-taxagent', requireAdmin, handleTaxAgentUpload, async (req, res) => {
  try {
  const { sendMail } = require('../lib/mailer');
  const { UPLOAD_ROOT } = require('../middleware/upload');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const taxAgentEmail = (req.body.taxAgentEmail || '').trim(); // kept for compat, no longer required

  // ── Guardar cambios del formulario de preview en la DB ────────────────────
  const str = (k) => (req.body[k] || '').trim() || undefined;
  const num = (k) => (req.body[k] !== '' && req.body[k] !== undefined) ? Number(req.body[k]) : undefined;

  const updates = {
    fullName:            str('fullName'),
    birthDate:           str('birthDate'),
    nationality:         str('nationality'),
    phone:               str('phone'),
    occupation:          str('occupation'),
    currentAddress:      str('currentAddress'),
    currentVisaSubclass: str('currentVisaSubclass'),
    taxResidencyStatus:  str('taxResidencyStatus'),
    visaStartDate:       str('visaStartDate'),
    visaEndDate:         str('visaEndDate'),
    dateArrived:         str('dateArrived'),
    firstYearResident:   str('firstYearResident'),
    bankInterest:        num('bankInterest'),
    otherIncome:         num('otherIncome'),
    deductionD1:         num('deductionD1'),
    deductionD3:         num('deductionD3'),
    deductionD4:         num('deductionD4'),
    deductionD5:         num('deductionD5'),
    deductionD6:         num('deductionD6'),
    deductionD9:         num('deductionD9'),
    deductionD10:        num('deductionD10'),
  };
  const tfnVal = str('tfn');
  if (tfnVal) { updates.tfn = tfnVal; updates.profile = { ...(u.profile || {}), tfn: tfnVal }; }

  // Empleadores — reconstruir array desde los campos emp_name_N, emp_abn_N, etc.
  const existingEmps = u.employers || [];
  if (existingEmps.length > 0) {
    updates.employers = existingEmps.map((emp, i) => ({
      ...emp,
      name:        str(`emp_name_${i}`)     || emp.name,
      abn:         str(`emp_abn_${i}`)      || emp.abn,
      grossIncome: num(`emp_gross_${i}`)    ?? emp.grossIncome,
      taxWithheld: num(`emp_withheld_${i}`) ?? emp.taxWithheld,
      periodFrom:  str(`emp_from_${i}`)     || emp.periodFrom,
      periodTo:    str(`emp_to_${i}`)       || emp.periodTo,
    }));
  }

  // Solo pisar campos con valor
  const patch = {};
  Object.entries(updates).forEach(([k, v]) => { if (v !== undefined) patch[k] = v; });
  db.get('users').find({ id: u.id }).assign(patch).write();

  // ── Guardar datos de auto + seguro en taxYearProfile ────────────────────────
  const strFy = (k) => (req.body[k] !== undefined && req.body[k] !== '') ? String(req.body[k]).trim() : undefined;
  const numFy = (k) => (req.body[k] !== undefined && req.body[k] !== '') ? Number(req.body[k]) : undefined;

  const fyPatch = {};
  // Leer array de vehículos desde campos indexados v_brand_0, v_km_0, etc.
  const vCount = parseInt(req.body.vehicleCount) || 0;
  const taVehicles = [];
  for (let i = 0; i < Math.max(vCount, 10); i++) {
    const brand = (req.body[`v_brand_${i}`] || '').trim();
    const model = (req.body[`v_model_${i}`] || '').trim();
    const year  = (req.body[`v_year_${i}`]  || '').trim();
    const plate = (req.body[`v_plate_${i}`] || '').trim().toUpperCase();
    const km    = parseFloat(req.body[`v_km_${i}`]) || 0;
    if (brand || model || plate || km) taVehicles.push({ brand, model, year, plate, km });
  }
  const fyCar = {
    vehicles:  taVehicles.length ? taVehicles : undefined,
    hasCar:    taVehicles.length > 0 ? true : undefined,
    carBrand:  taVehicles[0] ? taVehicles[0].brand : undefined,
    carModel:  taVehicles[0] ? taVehicles[0].model : undefined,
    carYear:   taVehicles[0] ? taVehicles[0].year  : undefined,
    carPlate:  taVehicles[0] ? taVehicles[0].plate : undefined,
    carWorkKm: taVehicles[0] ? taVehicles[0].km    : undefined,
  };
  const fyHealth = {
    hasHealthInsurance: req.body.hasHealthInsurance === '1' ? true : (req.body.hasHealthInsurance === '' ? false : undefined),
    healthProvider:     strFy('healthProvider'),
    healthMemberNumber: strFy('healthMemberNumber'),
    healthPlanType:     strFy('healthPlanType'),
    healthStartDate:    strFy('healthStartDate'),
    healthEndDate:      strFy('healthEndDate'),
  };
  Object.entries({ ...fyCar, ...fyHealth }).forEach(([k, v]) => { if (v !== undefined) fyPatch[k] = v; });

  if (Object.keys(fyPatch).length > 0) {
    const existingFyProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value()
      .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
    const targetFyProfile = existingFyProfiles[0];
    if (targetFyProfile) {
      db.get('taxYearProfiles').find({ id: targetFyProfile.id }).assign(fyPatch).write();
    }
  }

  // Recargar usuario con datos actualizados
  const allDocs = sortDocsByCategory(db.get('documents').filter({ userId: u.id }).value());
  const freshU  = db.get('users').find({ id: u.id }).value();
  const employers = freshU.employers || [];
  const tfn = (freshU.profile && freshU.profile.tfn) ? freshU.profile.tfn : (freshU.tfn || null);

  // Sumar montos de facturas por código de deducción
  const dedSums = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amt = parseAdminAmt(d.adminAmount);
    if (!dedSums[code]) dedSums[code] = { total: 0 };
    dedSums[code].total += amt;
  });
  Object.keys(dedSums).forEach(k => { dedSums[k].total = Math.round(dedSums[k].total * 100) / 100; });

  // Perfil del año fiscal (refrescar después del patch)
  const allFyProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value()
    .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
  const clientFyProfile = allFyProfiles[0] || {};
  const taxYear = clientFyProfile.taxYear || '2025-26';

  const val  = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;
  const fmt  = (v) => val(v) || '—';
  const fmtDate = (v) => { if (!v) return '—'; const p = v.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : v; };
  const fmtAUD = (v) => (v !== undefined && v !== null && v !== '' && Number(v) > 0) ? `$${Number(v).toFixed(2)}` : null;

  const CAT_LABELS = {
    selfie_id:            'Identity Document (Passport / ID)',
    payslips:             'Payslips',
    abn_income:           'ABN Income Records',
    logbook:              'D1 — Work-related car expenses',
    work_travel:          'D2 — Work-related travel expenses',
    work_expenses:        'D3 — Clothing, laundry & dry-cleaning',
    training:             'D4 — Work-related self-education',
    certifications:       'D5 — Certifications & licences',
    tech_purchases:       'D5 — Technology & other work expenses',
    home_office:          'D6 — Home office expenses',
    investment_statements:'D7/D8 — Investment & dividend statements',
    donation_receipts:    'D9 — Gifts or donations',
    bank_statement:       'Bank Statement',
  };

  const DEDUCTION_LIST = [
    { label:'D1 — Work-related car expenses',               ato:'D1',  key:'deductionD1'  },
    { label:'D2 — Work-related travel expenses',            ato:'D2',  key:'deductionD2'  },
    { label:'D3 — Clothing, laundry & dry-cleaning',        ato:'D3',  key:'deductionD3'  },
    { label:'D4 — Work-related self-education expenses',    ato:'D4',  key:'deductionD4'  },
    { label:'D5 — Other work-related expenses',             ato:'D5',  key:'deductionD5'  },
    { label:'D6 — Home office expenses',                    ato:'D6',  key:'deductionD6'  },
    { label:'D7 — Interest income deductions',              ato:'D7',  key:'deductionD7'  },
    { label:'D8 — Dividend deductions',                     ato:'D8',  key:'deductionD8'  },
    { label:'D9 — Gifts or donations',                      ato:'D9',  key:'deductionD9'  },
    { label:'D10 — Cost of managing tax affairs',           ato:'D10', key:'deductionD10' },
  ];

  // ── Helpers HTML ──────────────────────────────────────────────────────────
  const S  = '#0A0E5C'; // navy
  const Y  = '#FFC107'; // yellow
  const R  = '#DC2626'; // red missing

  const secHead = (title) =>
    `<tr><td colspan="3" style="padding:9px 14px;background:${S};color:#fff;font-weight:700;font-size:0.82rem;letter-spacing:0.06em;text-transform:uppercase;">${title}</td></tr>`;

  const dataRow = (label, ato, value) => {
    const missing = !value;
    return `<tr>
      <td style="padding:7px 14px;font-weight:600;color:#374151;width:38%;border-bottom:1px solid #F0F4F8;font-size:0.88rem;">${label}</td>
      <td style="padding:7px 8px;color:#6B7280;font-size:0.78rem;width:8%;border-bottom:1px solid #F0F4F8;font-family:monospace;">${ato||''}</td>
      <td style="padding:7px 14px;border-bottom:1px solid #F0F4F8;font-size:0.88rem;${missing?`color:${R};font-weight:600;`:'color:#111827;'}">${missing?'⚠ Missing':value}</td>
    </tr>`;
  };

  const subHead = (title) =>
    `<tr><td colspan="3" style="padding:7px 14px;background:#EFF6FF;color:#1D4ED8;font-weight:700;font-size:0.8rem;border-bottom:1px solid #DBEAFE;">${title}</td></tr>`;

  // ── Sección: empleadores ──────────────────────────────────────────────────
  let empHTML = '';
  if (employers.length === 0) {
    empHTML = dataRow('Employers', '', null);
  } else {
    employers.forEach((emp, i) => {
      empHTML += subHead(`Employer ${i+1}: ${emp.name || '—'}`);
      empHTML += dataRow('ABN',          'ABN', fmt(emp.abn));
      empHTML += dataRow('Gross Income', '1',   fmtAUD(emp.grossIncome) || null);
      empHTML += dataRow('Tax Withheld', '2',   fmtAUD(emp.taxWithheld) || null);
      empHTML += dataRow('Period From',  '',    fmt(emp.periodFrom));
      empHTML += dataRow('Period To',    '',    fmt(emp.periodTo));
    });
  }

  // catSums para desglose en email (misma lógica que user-detail)
  const CAT_DISPLAY_EMAIL = {
    logbook:               { label: 'D1 — Work-related car expenses',                    ato: 'D1' },
    work_travel:           { label: 'D2 — Work-related travel expenses',                 ato: 'D2' },
    work_expenses:         { label: 'D3 — Clothing, laundry & dry-cleaning',             ato: 'D3' },
    training:              { label: 'D4 — Work-related self-education',                  ato: 'D4' },
    certifications:        { label: 'D5 — Certifications & licences',                    ato: 'D5' },
    tech_purchases:        { label: 'D5 — Technology & other work expenses',             ato: 'D5' },
    home_office:           { label: 'D6 — Home office expenses',                         ato: 'D6' },
    investment_statements: { label: 'D7/D8 — Interest income & dividend deductions',     ato: 'D7' },
    donation_receipts:     { label: 'D9 — Gifts or donations',                           ato: 'D9' },
  };
  const catSumsEmail = {};
  allDocs.forEach(d => {
    const code = d.adminDedCode || CAT_TO_DED_MAP[d.category];
    if (!code || !d.adminAmount) return;
    const amt = parseAdminAmt(d.adminAmount);
    const cat = d.category;
    if (!catSumsEmail[cat]) catSumsEmail[cat] = { total: 0, count: 0, label: (CAT_DISPLAY_EMAIL[cat] || {}).label || cat, ato: code, docs: [] };
    catSumsEmail[cat].total += amt;
    catSumsEmail[cat].count++;
    catSumsEmail[cat].docs.push({ name: d.originalName || d.storedFilename, amount: amt, receiptRef: d.adminReceiptRef || null });
  });
  Object.keys(catSumsEmail).forEach(k => { catSumsEmail[k].total = Math.round(catSumsEmail[k].total * 100) / 100; });

  // ── Sección: deducciones ──────────────────────────────────────────────────
  let deductHTML = '';
  let totalDeductions = 0;
  DEDUCTION_LIST.forEach(d => {
    const amount = d.ato === 'D1'
      ? freshU[d.key]
      : (dedSums[d.ato] ? dedSums[d.ato].total : freshU[d.key]);
    const fmted = fmtAUD(amount);
    if (fmted) totalDeductions += Number(amount);
    deductHTML += dataRow(d.label, d.ato, fmted);

    // D1: mostrar fórmula km
    if (d.ato === 'D1' && clientFyProfile && clientFyProfile.carWorkKm) {
      const km = Number(clientFyProfile.carWorkKm);
      const aud = (km * 0.88).toFixed(2);
      deductHTML += `<tr><td colspan="3" style="padding:5px 14px 8px 28px;background:#EFF6FF;border-bottom:1px solid #BFDBFE;font-size:0.82rem;color:#1D4ED8;">
        🚗 <strong>${km} km × $0.88 = AUD $${aud}</strong>${km > 5000 ? ' &nbsp;<span style="color:#92400E;font-size:0.75rem;">⚠ supera 5,000 km — verificar logbook</span>' : ''}
      </td></tr>`;
    }

    // Para otros códigos: mostrar desglose por categoría si hay facturas
    if (d.ato !== 'D1') {
      const catsForCode = Object.values(catSumsEmail).filter(cs => cs.ato === d.ato);
      if (catsForCode.length > 0) {
        catsForCode.forEach(cs => {
          deductHTML += `<tr><td colspan="3" style="padding:3px 14px 3px 28px;background:#F0FDF4;border-bottom:1px solid #D1FAE5;font-size:0.78rem;color:#166534;">
            &nbsp;&nbsp;↳ <strong>${cs.label}</strong>: AUD $${cs.total.toFixed(2)}
            <span style="color:#6B7280;"> (${cs.count} factura${cs.count !== 1 ? 's' : ''})</span>
            ${cs.docs.map(doc => `<span style="display:block;padding-left:16px;color:#4B5563;font-size:0.73rem;">• ${doc.name}${doc.receiptRef ? ' #'+doc.receiptRef : ''} — AUD $${doc.amount.toFixed(2)}</span>`).join('')}
          </td></tr>`;
        });
      }
    }
  });
  deductHTML += `<tr>
    <td colspan="2" style="padding:8px 14px;font-weight:700;font-size:0.88rem;background:#FFF8E1;border-top:2px solid ${Y};">TOTAL DEDUCTIONS</td>
    <td style="padding:8px 14px;font-weight:700;font-size:0.88rem;background:#FFF8E1;border-top:2px solid ${Y};">${totalDeductions > 0 ? `$${totalDeductions.toFixed(2)}` : '—'}</td>
  </tr>`;

  // ── Sección: documentos adjuntos ──────────────────────────────────────────
  // Resolver rutas primero para saber qué hay disponible
  const resolvePath = (d) => {
    // Probar todas las ubicaciones posibles:
    // selfie_id se guarda sin subcarpeta; el resto puede estar en taxYear/, general/, o raíz
    const candidates = [
      path.join(UPLOAD_ROOT, u.id, d.storedFilename),                          // raíz (selfie)
      path.join(UPLOAD_ROOT, u.id, 'general', d.storedFilename),               // general/ (más común)
      path.join(UPLOAD_ROOT, u.id, d.taxYear || 'general', d.storedFilename),  // taxYear/ si es distinto
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  };

  // Formatos que Brevo no acepta como adjuntos → van al bundle de descarga
  const UNSUPPORTED_EXTS = ['.heic', '.heif', '.webp', '.avif'];
  const attachments = [];
  const notFound = [];
  const incompatible = []; // archivos con formato no soportado por Brevo
  const clientFullName = freshU.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || freshU.email || 'Client';
  for (const d of allDocs) {
    const finalPath = resolvePath(d);
    if (!finalPath) {
      notFound.push(d.originalName || d.storedFilename);
      console.warn(`[TAXAGENT EMAIL] Archivo no encontrado: ${d.storedFilename} (userId=${u.id})`);
      continue;
    }
    const catLabel = CAT_LABELS[d.category] || d.category || 'Other';

    // selfie_id: siempre convertir a PDF con nombre canónico
    if (d.category === 'selfie_id') {
      try {
        const pdfBuf = await convertImageToPdf(finalPath);
        const pdfName = identityPdfName(clientFullName);
        attachments.push({ name: pdfName, content: pdfBuf.toString('base64'), catLabel, originalName: pdfName });
        continue;
      } catch (e) {
        console.error('[TAXAGENT EMAIL] selfie_id PDF conversion failed:', e.message);
        // fallback: continúa con el flujo normal
      }
    }

    const fileName = `[${catLabel}] ${d.originalName || d.storedFilename}`;
    const ext = path.extname((d.originalName || d.storedFilename) || '').toLowerCase();
    if (UNSUPPORTED_EXTS.includes(ext)) {
      incompatible.push({ path: finalPath, name: fileName, catLabel, originalName: d.originalName || d.storedFilename });
      console.warn(`[TAXAGENT EMAIL] Formato no soportado por Brevo (${ext}): ${d.storedFilename}`);
      continue;
    }
    const content = fs.readFileSync(finalPath).toString('base64');
    attachments.push({ name: fileName, content, catLabel, originalName: d.originalName || d.storedFilename });
  }

  // Agrupar docs por categoría para listarlos en el email
  const docsByCat = {};
  attachments.forEach(a => {
    if (!docsByCat[a.catLabel]) docsByCat[a.catLabel] = [];
    docsByCat[a.catLabel].push(a.originalName);
  });

  let docsHTML = '';
  if (Object.keys(docsByCat).length === 0) {
    docsHTML = `<tr><td colspan="3" style="padding:8px 14px;color:${R};font-weight:600;">⚠ No documents uploaded</td></tr>`;
  } else {
    Object.entries(docsByCat).forEach(([cat, files]) => {
      docsHTML += subHead(`${cat} (${files.length} file${files.length>1?'s':''})`);
    });
    if (notFound.length) {
      docsHTML += subHead(`⚠ Files referenced but not found on server (${notFound.length})`);
      notFound.forEach(f => {
        docsHTML += `<tr><td colspan="3" style="padding:5px 14px 5px 28px;color:${R};font-size:0.85rem;border-bottom:1px solid #F0F4F8;">✗ ${f}</td></tr>`;
      });
    }
  }

  const dateStr = new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'long', year:'numeric' });
  const clientName = freshU.fullName || freshU.email;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #E5E7EB;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

  <!-- Header -->
  <div style="background:${S};padding:24px 28px;">
    <div style="font-size:1.25rem;font-weight:700;color:#fff;margin-bottom:6px;">Individual Tax Return — Client File</div>
    <div style="font-size:0.85rem;color:rgba(255,255,255,0.65);">Prepared for tax agent review · ${dateStr}</div>
  </div>

  <!-- Intro -->
  <div style="padding:16px 28px;background:#FFFBEB;border-bottom:1px solid #FDE68A;">
    <p style="margin:0;font-size:0.92rem;color:#78350F;">
      Please find below the complete tax return information for <strong>${clientName}</strong>.
      All supporting documents are attached to this email, labelled by category.
      If any information is marked <span style="color:${R};font-weight:600;">⚠ Missing</span>, please contact the client before lodging.
    </p>
  </div>

  <!-- Data table -->
  <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">

    ${secHead('1. Personal Information')}
    ${dataRow('Full Name',             '',    fmt(freshU.fullName))}
    ${dataRow('Email',                 '',    fmt(freshU.email))}
    ${dataRow('Phone / Mobile',        '',    fmt(freshU.phone || freshU.mobile))}
    ${dataRow('Date of Birth',         '',    fmtDate(freshU.birthDate))}
    ${dataRow('Gender',                '',    fmt(freshU.gender))}
    ${dataRow('Country of Birth',      '',    fmt(freshU.countryOfBirth || freshU.nationality))}
    ${dataRow('Nationality',           '',    fmt(freshU.nationality))}
    ${dataRow('Tax File Number (TFN)', 'TFN', fmt(tfn))}
    ${dataRow('ABN',                   'ABN', fmt(freshU.abn))}
    ${dataRow('Main Salary and Wages Occupation', '', fmt(freshU.occupation))}
    ${dataRow('Current Address',       '',    fmt(freshU.currentAddress))}
    ${dataRow('Suburb',                '',    fmt(freshU.suburb))}
    ${dataRow('State',                 '',    fmt(freshU.state))}
    ${dataRow('Postcode',              '',    fmt(freshU.postcode))}
    ${secHead('Bank Account Details (Refund)')}
    ${dataRow('Bank / Institution',     '',    fmt(freshU.bankInstitution))}
    ${dataRow('Account Holder Name',   '',    fmt(freshU.bankAccountName))}
    ${dataRow('BSB',                   '',    fmt(freshU.bankBSB || freshU.bsb))}
    ${dataRow('Account Number',        '',    fmt(freshU.bankAccount || freshU.accountNumber))}
    ${dataRow('Bank Name',             '',    fmt(freshU.bankName))}

    ${secHead('2. Visa & Residency')}
    ${dataRow('Visa Subclass',           '', fmt(freshU.currentVisaSubclass))}
    ${dataRow('Visa Start Date',         '', fmt(freshU.visaStartDate))}
    ${dataRow('Visa End Date',           '', fmt(freshU.visaEndDate))}
    ${dataRow('Tax Residency Status',    '', fmt(freshU.taxResidencyStatus))}
    ${dataRow('First Year as Resident',  '', fmt(freshU.firstYearResident))}
    ${dataRow('Date Arrived in Australia','',fmt(freshU.dateArrived))}

    ${secHead('3. Employment Income')}
    ${empHTML}

    ${secHead('4. Other Income')}
    ${dataRow('Bank Interest',  '10', fmtAUD(freshU.bankInterest))}
    ${dataRow('Other Income',   '',   fmtAUD(freshU.otherIncome))}

    ${secHead('5. Deductions')}
    ${deductHTML}
    ${secHead('6. Vehicle Information')}
    ${dataRow('Has Work-Related Vehicle', '', clientFyProfile.hasCar ? 'Yes' : 'No')}
    ${clientFyProfile.hasCar ? (() => {
      const km = clientFyProfile.carWorkKm ? Number(clientFyProfile.carWorkKm) : null;
      const kmDeduction = km ? (km * 0.88).toFixed(2) : null;
      const kmOverLimit = km && km > 5000;
      return `
    ${dataRow('Make',             '', fmt(clientFyProfile.carBrand))}
    ${dataRow('Model',            '', fmt(clientFyProfile.carModel))}
    ${dataRow('Year',             '', fmt(clientFyProfile.carYear))}
    ${dataRow('Plate',            '', fmt(clientFyProfile.carPlate))}
    ${dataRow('Purchase Price',   '', clientFyProfile.carPurchasePrice ? `$${Number(clientFyProfile.carPurchasePrice).toFixed(2)}` : '—')}
    ${dataRow('Work-Related Km',  'D1', km ? `${km} km` : '—')}
    ${km ? `<tr><td colspan="3" style="padding:8px 14px;background:#EFF6FF;border-bottom:1px solid #BFDBFE;">
      <span style="font-size:0.85rem;color:#1D4ED8;">
        🚗 <strong>${km} km × $0.88 = <span style="font-size:1rem;">AUD $${kmDeduction}</span></strong>
        &nbsp;·&nbsp; <span style="font-size:0.78rem;">ATO cents-per-km method${kmOverLimit ? ' — ⚠ supera 5,000 km, se requiere logbook' : ''}</span>
      </span>
    </td></tr>` : ''}`;
    })() : ''}
    ${secHead('7. Private Health Insurance (Medicare)')}
    ${dataRow('Has Private Health Insurance', '', clientFyProfile.hasHealthInsurance ? 'Yes' : 'No')}
    ${clientFyProfile.hasHealthInsurance ? `
    ${dataRow('Provider',        '', fmt(clientFyProfile.healthProvider))}
    ${dataRow('Member Number',   '', fmt(clientFyProfile.healthMemberNumber))}
    ${dataRow('Plan Type',       '', fmt(clientFyProfile.healthPlanType))}
    ${dataRow('Cover From',      '', fmt(clientFyProfile.healthStartDate))}
    ${dataRow('Cover To',        '', fmt(clientFyProfile.healthEndDate))}
    ` : ''}

    ${secHead(`8. Documents Attached (${attachments.length} file${attachments.length!==1?'s':''})`)}
    ${docsHTML}

  </table>

  <!-- Footer -->
  <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">
    This file was prepared by RETAUX (www.retaux.com) on behalf of the client and is intended solely for the named tax agent.
    For queries contact hola@retaux.com
  </div>
</div>
</body></html>`;

  // Agregar archivos extra subidos desde el formulario de preview
  const extraAttachments = (req.files || []).map(f => ({
    name: f.originalname,
    content: f.buffer.toString('base64'),
    catLabel: 'Extra',
    originalName: f.originalname
  }));

  // Calcular tamaño total de adjuntos compatibles
  const allAttachmentsFull = [
    ...attachments.map(a => ({ name: a.name, content: a.content, catLabel: a.catLabel, originalName: a.originalName })),
    ...extraAttachments
  ];
  const totalBytes = allAttachmentsFull.reduce((sum, a) => sum + Buffer.from(a.content, 'base64').length, 0);
  const LIMIT_BYTES = 15 * 1024 * 1024; // 15MB margen seguro

  // Necesita bundle si los archivos son demasiado grandes O si hay archivos incompatibles (HEIC, etc.)
  const needsBundle = totalBytes > LIMIT_BYTES || incompatible.length > 0;

  let mailAttachments = allAttachmentsFull;
  let downloadSection = '';

  if (needsBundle) {
    const crypto = require('crypto');
    const bundleToken = crypto.randomBytes(24).toString('hex');
    const bundleExpiry = null; // sin vencimiento

    // El bundle incluye TODOS los archivos del usuario (compatibles + incompatibles)
    const bundleFiles = [];
    for (const d of allDocs) {
      const finalPath = resolvePath(d);
      if (finalPath) {
        const catLabel = CAT_LABELS[d.category] || d.category || 'Other';
        bundleFiles.push({ path: finalPath, name: `[${catLabel}] ${d.originalName || d.storedFilename}` });
      }
    }
    extraAttachments.forEach(e => {
      const tmpPath = path.join(UPLOAD_ROOT, u.id, '_extra_' + e.originalName);
      fs.writeFileSync(tmpPath, Buffer.from(e.content, 'base64'));
      bundleFiles.push({ path: tmpPath, name: e.originalName, tmp: true });
    });

    db.get('taxBundles').push({
      token: bundleToken,
      userId: u.id,
      clientName,
      files: bundleFiles,
      createdAt: new Date().toISOString(),
      expiresAt: bundleExpiry
    }).write();

    const bundleUrl = `https://retaux.com/taxagent-bundle/${bundleToken}`;
    const totalMB = (totalBytes / 1024 / 1024).toFixed(1);

    let bundleReason = '';
    if (totalBytes > LIMIT_BYTES && incompatible.length > 0) {
      bundleReason = `The documents exceed the email size limit (${totalMB} MB) and include ${incompatible.length} file(s) in formats not supported as email attachments (e.g. HEIC/iPhone photos).`;
    } else if (totalBytes > LIMIT_BYTES) {
      bundleReason = `The client's documents total <strong>${totalMB} MB</strong> which exceeds email attachment limits.`;
    } else {
      const incompatNames = incompatible.map(f => f.originalName).join(', ');
      bundleReason = `${incompatible.length} file(s) are in a format not supported as email attachments (HEIC/iPhone photos): <em>${incompatNames}</em>. All files are available via the link below.`;
    }

    downloadSection = `
  <!-- Download Link Section -->
  <div style="padding:16px 28px;background:#EFF6FF;border:2px solid #3B82F6;border-radius:6px;margin:16px 28px;">
    <p style="margin:0 0 8px;font-size:0.95rem;font-weight:700;color:#1D4ED8;">📦 Documents Download Link</p>
    <p style="margin:0 0 10px;font-size:0.88rem;color:#374151;">${bundleReason}</p>
    <a href="${bundleUrl}" style="display:inline-block;background:#1D4ED8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:0.9rem;">
      ⬇ Download All Documents
    </a>
  </div>`;

    // Si solo hay incompatibles pero el tamaño es OK → adjuntar los compatibles además del link
    if (totalBytes <= LIMIT_BYTES && incompatible.length > 0) {
      mailAttachments = allAttachmentsFull; // adjuntar los compatibles normalmente
    } else {
      mailAttachments = []; // solo el link, sin adjuntos
    }
  }

  // Insertar sección de descarga en el HTML (antes del footer)
  const finalHtml = downloadSection
    ? html.replace('<!-- Footer -->', downloadSection + '\n  <!-- Footer -->')
    : html;

  // Enviar por email — destinatarios desde el formulario
  const sendToRaw   = (req.body.sendTo   || '').trim();
  if (!sendToRaw) return res.redirect(`/admin/user/${u.id}?error=no_recipient`);
  const sendCcExtraEarly = (req.body.sendCc || '').trim();

  const includeClientData    = req.body.includeClientData === '1';
  const includeEnpresa       = req.body.includeEnpresa === '1';
  const includeTaxResidency  = req.body.includeTaxResidency === '1';
  const requireSignature  = req.body.requireSignature === '1';

  // Guardar HTML del informe en la DB + opciones ENPRESA por cliente
  const dbPatch = {
    taxReturnStage:           'with_agent',
    taxAgentSentAt:           new Date().toISOString(),
    taxAgentReportHtml:       finalHtml,
    requiresEnpresaSignature: requireSignature,
  };
  if (includeEnpresa || requireSignature) dbPatch.taxAgentEmail = sendToRaw;
  const assignedAgentVal = (req.body.assignedAgent || '').trim();
  if (assignedAgentVal) dbPatch.assignedAgent = assignedAgentVal;
  db.get('users').find({ id: u.id }).assign(dbPatch).write();

  // ── Generar formularios ENPRESA como PDF (TAA + Engagement Letter) ───────────
  const enpresaAttachments = [];
  if (includeEnpresa) {
    const consentSig = freshU.declarationSignedAt
      ? { name: freshU.declarationSignedName, date: new Date(freshU.declarationSignedAt).toLocaleDateString('en-AU'), signedAt: new Date(freshU.declarationSignedAt).toLocaleString('en-AU') }
      : freshU.consentSignedAt
        ? { name: freshU.consentSignedName, date: new Date(freshU.consentSignedAt).toLocaleDateString('en-AU'), signedAt: new Date(freshU.consentSignedAt).toLocaleString('en-AU') }
        : null;
    const safeName = (freshU.fullName || freshU.email).replace(/[^a-zA-Z0-9._-]/g, '_');
    const taxYear  = clientFyProfile?.taxYear || '2025-26';

    // 1. TAA Client Details Form (DOCX)
    try {
      const { fillTaaDocx } = require('../lib/fillTaaDocx');
      const dedD1 = dedSums?.D1?.total ?? dedSums?.d1 ?? 0;
      const dedD3 = dedSums?.D3?.total ?? dedSums?.d3 ?? 0;
      const dedD4 = dedSums?.D4?.total ?? dedSums?.d4 ?? 0;
      const dedD5 = dedSums?.D5?.total ?? dedSums?.d5 ?? 0;
      const taaBuf = await fillTaaDocx({
        fullName:        (freshU.fullName && !freshU.fullName.includes('@')) ? freshU.fullName : (consentSig?.name || freshU.email),
        email:           freshU.email,
        phone:           freshU.phone || freshU.mobile || '',
        address:         freshU.currentAddress || freshU.address || '',
        suburb:          freshU.suburb || '',
        state:           freshU.state || '',
        postcode:        freshU.postcode || '',
        dob:             freshU.dateOfBirth || freshU.birthDate || '',
        gender:          freshU.gender || '',
        countryBirth:    freshU.countryOfBirth || freshU.nationality || '',
        citizenship:     freshU.nationality || '',
        occupation:      freshU.occupation || '',
        employers:       (employers || []).map(e => e.employerName || e.name || '').filter(Boolean),
        visaSubclass:    freshU.currentVisaSubclass || freshU.visaSubclass || '',
        hasVisa:         !!(freshU.currentVisaSubclass || freshU.visaSubclass),
        hasSpouse:       !!(freshU.spouseName || freshU.maritalStatus === 'married' || freshU.maritalStatus === 'defacto'),
        spouseName:      freshU.spouseName || '',
        hasAbn:          !!(allDocs?.some(d => d.category === 'abn_income')) || !!freshU.abn,
        hasPhi:          !!(allDocs?.some(d => d.category === 'health_insurance' && d.adminAmount)),
        hasHomeOffice:   false,
        hasWorkExp:      false,
        hasDonation:     false,
        bankAccountName: freshU.bankAccountName || '',
        bsb:             freshU.bankBSB || freshU.bsb || '',
        accountNumber:   freshU.bankAccount || freshU.accountNumber || '',
        bankName:        freshU.bankName || '',
        hasForeign:      !!(freshU.taxResidencyForeign || freshU.hasForeignIncome),
        hasHomeOffice:   !!(dedSums?.D1?.total || dedSums?.d1),
        hasDonation:     !!(dedSums?.D9?.total || dedSums?.d9),
        ded_d1: dedD1,
        ded_d2: dedSums?.D2?.total ?? dedSums?.d2 ?? 0,
        ded_d3: dedD3,
        ded_d4: dedD4,
        ded_d5: dedD5,
        sigAt: consentSig?.signedAt || new Date().toISOString(),
      });
      const taaContent = taaBuf.toString('base64');
      if (!taaContent) throw new Error('Buffer TAA vacío');
      enpresaAttachments.push({
        name:    `3. ENPRESA_TAA_ClientDetailsForm_${safeName}.pdf`,
        content: taaContent,
      });
    } catch (e) { console.error('[ENPRESA TAA] Error generando DOCX:', e.message); }

    // 2. Engagement Letter
    try {
      const { generateEngagementPdf } = require('../lib/enpresaEngagementPdf');
      const engBuf = await generateEngagementPdf({ u: freshU, signature: consentSig, dateStr });
      const engContent = engBuf.toString('base64');
      if (!engContent) throw new Error('Buffer Engagement vacío');
      enpresaAttachments.push({
        name:    `1. ENPRESA_EngagementLetter_${safeName}.pdf`,
        content: engContent,
      });
    } catch (e) { console.error('[ENPRESA Engagement] Error generando PDF:', e.message); }

    // 3. Tax Deductions Individual (Excel)
    try {
      const { fillDeductionsXlsx } = require('../lib/fillDeductionsXlsx');
      const d1Doc = allDocs.find(d => d.category === 'vehicle' && d.adminKm);
      const d1Km = d1Doc ? parseFloat(d1Doc.adminKm) : null;
      const xlsxBuf = await fillDeductionsXlsx({ user: freshU, dedSums, taxYear, d1Km });
      const xlsxContent = xlsxBuf.toString('base64');
      if (!xlsxContent) throw new Error('Buffer Excel vacío');
      enpresaAttachments.push({
        name:    `TaxDeductions_${safeName}_${taxYear}.xlsx`,
        content: xlsxContent,
      });
    } catch (e) { console.error('[ENPRESA Excel] Error generando XLSX:', e.message); }
  }

  // ── Individual Tax Return HTML → PDF (siempre que se incluyan datos del cliente) ─
  if (includeClientData) {
    try {
      const os       = require('os');
      const { execSync } = require('child_process');
      const safeNamePdf = (freshU.fullName || freshU.email).replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpDir   = path.join(os.tmpdir(), 'retaux_taxreturn_' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      const htmlFile = path.join(tmpDir, 'TaxReturn.html');
      const pdfFile  = path.join(tmpDir, 'TaxReturn.pdf');
      // Para el PDF se eliminan propiedades CSS que hacen que LibreOffice
      // inserte una página en blanco al inicio o rompa el layout de impresión
      const pdfHtml = html
        .replace('overflow:hidden;', '')
        .replace('border-radius:8px;', '')
        .replace('box-shadow:0 2px 8px rgba(0,0,0,0.06);', '')
        .replace('margin:24px auto;', 'margin:0;')
        .replace('max-width:700px;', 'max-width:100%;')
        .replace('background:#F3F4F6;', 'background:#fff;')
        .replace('<head>', '<head><style>@page{margin:12mm 10mm;}body{margin:0!important;padding:0!important;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}div:first-of-type{page-break-before:avoid;}table{page-break-inside:auto;}tr{page-break-inside:avoid;}</style>');
      fs.writeFileSync(htmlFile, pdfHtml, 'utf8');
      execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${htmlFile}"`, { timeout: 45000 });
      if (fs.existsSync(pdfFile)) {
        const pdfBuf = fs.readFileSync(pdfFile);
        enpresaAttachments.push({
          name:    `3. Individual Tax Return_${safeNamePdf}.pdf`,
          content: pdfBuf.toString('base64'),
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } else {
        console.error('[TAX RETURN PDF] LibreOffice no generó el PDF');
      }
    } catch (e) { console.error('[TAX RETURN PDF] Error:', e.message); }
  }

  // ── Tax Residency Declaration (DOCX → PDF) ────────────────────────────────
  if (includeTaxResidency) {
    try {
      const taxResDir  = path.join(__dirname, '..', 'TaxResidencyDeclarations');
      const safeName   = (freshU.fullName || freshU.email).replace(/[^a-zA-Z0-9._-]/g, '_');
      const taxYear    = clientFyProfile?.taxYear || '2025-26';
      // Buscar el DOCX del cliente normalizando el nombre
      const normalize  = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const nameKey    = normalize(freshU.fullName || '');
      const files      = fs.readdirSync(taxResDir);
      const match      = files.find(f => normalize(f).includes(nameKey) && f.endsWith('.docx'));
      if (match) {
        const docxPath   = path.join(taxResDir, match);
        const tmpPdfDir  = path.join(require('os').tmpdir(), 'retaux_taxres');
        fs.mkdirSync(tmpPdfDir, { recursive: true });
        const { execSync } = require('child_process');
        execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpPdfDir}" "${docxPath}"`, { timeout: 30000 });
        const pdfName    = match.replace('.docx', '.pdf');
        const pdfPath    = path.join(tmpPdfDir, pdfName);
        if (fs.existsSync(pdfPath)) {
          const pdfBuf = fs.readFileSync(pdfPath);
          enpresaAttachments.push({
            name:    `TaxResidencyDeclaration_${safeName}_${taxYear}.pdf`,
            content: pdfBuf.toString('base64'),
          });
          // Guardar en carpeta del cliente
          const clientUploadsDir = path.join(__dirname, '..', 'uploads', freshU.id, 'general');
          fs.mkdirSync(clientUploadsDir, { recursive: true });
          fs.copyFileSync(pdfPath, path.join(clientUploadsDir, `TaxResidencyDeclaration_${safeName}_${taxYear}.pdf`));
          fs.unlinkSync(pdfPath);
          console.log(`[TAX RESIDENCY] PDF generado y adjuntado para ${freshU.fullName}`);
        } else {
          console.error('[TAX RESIDENCY] LibreOffice no generó el PDF');
        }
      } else {
        console.warn(`[TAX RESIDENCY] No se encontró DOCX para: ${freshU.fullName}`);
      }
    } catch (e) { console.error('[TAX RESIDENCY] Error:', e.message); }
  }

  const sendCcExtra = sendCcExtraEarly;
  const sendSubject = (req.body.sendSubject || `[RETAUX] Tax Return — ${clientName}`).trim();

  const toList = sendToRaw.split(',').map(e => e.trim()).filter(Boolean);
  const ccList = ['hola@retaux.com'];
  if (sendCcExtra) sendCcExtra.split(',').map(e => e.trim()).filter(Boolean).forEach(e => { if (!ccList.includes(e)) ccList.push(e); });

  // Adjuntar bank statement si existe
  const bankStatementAttachments = [];
  const bankStmtDocs = db.get('documents').filter({ userId: u.id, category: 'bank_statement' }).value() || [];
  const safeBsName = (freshU.fullName || freshU.email).replace(/[^a-zA-Z0-9._-]/g, '_');
  bankStmtDocs.forEach((bsDoc, idx) => {
    try {
      const bsPath = resolvePath(bsDoc);
      if (!bsPath) { console.error('[BANK STATEMENT] Archivo no encontrado:', bsDoc.storedFilename); return; }
      const bsContent = fs.readFileSync(bsPath).toString('base64');
      if (bsContent) {
        const bsExt = path.extname(bsDoc.storedFilename) || path.extname(bsDoc.originalName) || '';
        const suffix = bankStmtDocs.length > 1 ? `_${idx + 1}` : '';
        bankStatementAttachments.push({
          name:    `4. Bank Statement_ ${safeBsName}${suffix}${bsExt}`,
          content: bsContent,
        });
      }
    } catch (e) { console.error('[BANK STATEMENT] Error adjuntando:', e.message); }
  });

  // Si no incluye datos del cliente: solo se envían los PDFs ENPRESA
  let emailHtml          = includeClientData ? finalHtml : (enpresaAttachments.length ? '<p>Please find the ENPRESA forms attached.</p>' : '<p>No content selected.</p>');
  // Filtrar adjuntos sin content (evita error "content is missing in attachment" en Brevo)
  const safeMailAttachments = mailAttachments.filter(a => a.content && a.content.length > 0);
  const emailAttachments = [
    ...(includeClientData ? safeMailAttachments.map(a => ({ name: a.name, content: a.content })) : []),
    ...enpresaAttachments,
    ...bankStatementAttachments,
  ];

  // Brevo rechaza emails >20MB — si el total supera el límite, quitar adjuntos de cliente
  // (los PDFs ENPRESA y bank statement son siempre pequeños y se mantienen)
  const BREVO_HARD_LIMIT = 19 * 1024 * 1024; // 19MB margen
  const totalEmailBytes = emailAttachments.reduce((s, a) => s + (a.content ? Buffer.from(a.content, 'base64').length : 0), 0);
  if (totalEmailBytes > BREVO_HARD_LIMIT) {
    console.warn(`[TAXAGENT EMAIL] Email demasiado grande (${(totalEmailBytes/1024/1024).toFixed(1)}MB) — forzando bundle y quitando adjuntos de cliente`);
    // Regenerar bundle si no se había generado
    if (!downloadSection) {
      const crypto = require('crypto');
      const bundleToken = crypto.randomBytes(24).toString('hex');
      const bundleFiles = [];
      for (const d of allDocs) {
        const finalPath = resolvePath(d);
        if (finalPath) {
          const catLabel = CAT_LABELS[d.category] || d.category || 'Other';
          bundleFiles.push({ path: finalPath, name: `[${catLabel}] ${d.originalName || d.storedFilename}` });
        }
      }
      db.get('taxBundles').push({ token: bundleToken, userId: u.id, clientName, files: bundleFiles, createdAt: new Date().toISOString(), expiresAt: null }).write();
      const bundleUrl = `https://retaux.com/taxagent-bundle/${bundleToken}`;
      const totalMB = (totalEmailBytes / 1024 / 1024).toFixed(1);
      const fallbackSection = `<div style="padding:16px 28px;background:#EFF6FF;border:2px solid #3B82F6;border-radius:6px;margin:16px 28px;"><p style="margin:0 0 8px;font-size:0.95rem;font-weight:700;color:#1D4ED8;">📦 Documents Download Link</p><p style="margin:0 0 10px;font-size:0.88rem;color:#374151;">The client's documents total <strong>${totalMB} MB</strong> which exceeds email attachment limits. All files available via the link below.</p><a href="${bundleUrl}" style="display:inline-block;background:#1D4ED8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:0.9rem;">⬇ Download All Documents</a></div>`;
      // Reemplazar HTML con bundle link
      emailHtml = (emailHtml || finalHtml).replace('<!-- Footer -->', fallbackSection + '\n  <!-- Footer -->');
    }
    // Quitar todos los adjuntos de cliente, mantener solo ENPRESA y bank statement
    emailAttachments.splice(0, emailAttachments.length,
      ...enpresaAttachments,
      ...bankStatementAttachments
    );
  }
  const emailText = [
    includeClientData ? `Tax return file for ${clientName}. ${mailAttachments.length} document(s) attached.` : '',
    enpresaAttachments.length ? `ENPRESA forms included: ${enpresaAttachments.map(a => a.name).join(', ')}.` : '',
    bankStatementAttachments.length ? `Bank statement included.` : '',
  ].filter(Boolean).join(' ');

  try {
    await sendMail({
      to:          toList,
      cc:          ccList,
      subject:     sendSubject,
      html:        emailHtml,
      text:        emailText,
      attachments: emailAttachments,
    });
    console.log(`[TAXAGENT SEND] Email sent for ${clientName} — to: ${toList.join(', ')} — clientData:${includeClientData} enpresa:${includeEnpresa}`);
  } catch (e) {
    console.error('[TAXAGENT SEND] Email error:', e.message);
  }

  // ── Google Drive: crear carpeta del cliente y subir todos los archivos ────────
  try {
    const { createFolder, uploadBuffer, uploadFile } = require('../lib/googleDrive');
    const driveTaxYear = clientFyProfile?.taxYear || '2025-26';
    const folderName = `${clientName} — ${driveTaxYear}`;
    const folderId = await createFolder(folderName);

    // Subir PDFs ENPRESA (TAA + Engagement Letter)
    for (const att of enpresaAttachments) {
      await uploadBuffer(folderId, att.name, Buffer.from(att.content, 'base64'));
    }

    // Subir documentos del cliente
    if (includeClientData) {
      const clientDocs = db.get('documents').filter({ userId: freshU.id }).value();
      for (const doc of clientDocs) {
        const subdir = doc.taxYear || doc.category || 'general';
        const candidates = [
          path.join(__dirname, '..', 'uploads', freshU.id, subdir, doc.storedFilename),
          path.join(__dirname, '..', 'uploads', freshU.id, 'general', doc.storedFilename),
          path.join(__dirname, '..', 'uploads', freshU.id, doc.storedFilename),
        ];
        const filePath = candidates.find(p => fs.existsSync(p));
        if (filePath) {
          await uploadFile(folderId, doc.originalName, filePath);
        }
      }
    }

    console.log(`[DRIVE] Carpeta creada para ${clientName}: ${folderId}`);
    db.get('users').find({ id: freshU.id }).assign({ driveFolderId: folderId }).write();
  } catch (e) {
    console.error('[DRIVE] Error subiendo archivos:', e.message);
  }

  res.redirect(`/admin/user/${u.id}?taxAgentSent=1`);
  } catch (fatalErr) {
    console.error('[TAXAGENT FATAL] Error no capturado en send-taxagent:', fatalErr.message, fatalErr.stack?.split('\n')[1]);
    if (!res.headersSent) res.redirect(`/admin/user/${req.params.id}?error=taxagent_fatal`);
  }
});

// ── Reenvío rápido del informe del tax agent (desde user-detail) ──────────────

// ── Descargar TAA DOCX para un cliente ───────────────────────────────────────
router.get('/user/:id/download-taa-docx', requireAdmin, async (req, res) => {
  try {
    const { fillTaaDocx } = require('../lib/fillTaaDocx');
    const u = db.get('users').find({ id: req.params.id }).value();
    if (!u) return res.status(404).send('User not found');

    const allDocs   = db.get('documents').filter({ userId: u.id }).value();
    const employers = u.employers || [];
    const taxYear   = '2025-26';

    const dedSums = {};
    const CAT_TO_DED_MAP_LOCAL = { vehicle:'D1', clothing:'D3', self_education:'D4', phone:'D5', internet:'D5', home_office:'D5', other_work:'D9' };
    allDocs.forEach(d => {
      const code = d.adminDedCode || CAT_TO_DED_MAP_LOCAL[d.category];
      if (!code || !d.adminAmount) return;
      const amt = parseFloat(String(d.adminAmount).replace(/[^0-9.]/g, '')) || 0;
      if (!dedSums[code]) dedSums[code] = { total: 0 };
      dedSums[code].total += amt;
    });

    const consentSig = u.declarationSignedAt
      ? { signedAt: u.declarationSignedAt }
      : u.consentSignedAt ? { signedAt: u.consentSignedAt } : null;

    const buf = await fillTaaDocx({
      fullName:        (u.fullName && !u.fullName.includes('@')) ? u.fullName : u.email,
      email:           u.email,
      phone:           u.phone || u.mobile || '',
      address:         u.currentAddress || u.address || '',
      suburb:          u.suburb || '',
      state:           u.state || '',
      postcode:        u.postcode || '',
      dob:             u.dateOfBirth || u.birthDate || '',
      gender:          u.gender || '',
      countryBirth:    u.countryOfBirth || u.nationality || '',
      citizenship:     u.nationality || '',
      occupation:      u.occupation || '',
      employers:       employers.map(e => e.employerName || e.name || '').filter(Boolean),
      visaSubclass:    u.currentVisaSubclass || u.visaSubclass || '',
      hasVisa:         !!(u.currentVisaSubclass || u.visaSubclass),
      hasSpouse:       !!(u.spouseName || u.maritalStatus === 'married' || u.maritalStatus === 'defacto'),
      spouseName:      u.spouseName || '',
      hasAbn:          !!(allDocs.some(d => d.category === 'abn_income')) || !!u.abn,
      hasPhi:          !!(allDocs.some(d => d.category === 'health_insurance' && d.adminAmount)),
      hasForeign:      !!(u.taxResidencyForeign || u.hasForeignIncome),
      hasHomeOffice:   !!(dedSums.D1?.total),
      hasWorkExp:      false,
      hasDonation:     !!(dedSums.D9?.total),
      bankAccountName: u.bankAccountName || '',
      bsb:             u.bankBSB || u.bsb || '',
      accountNumber:   u.bankAccount || u.accountNumber || '',
      bankName:        u.bankName || '',
      ded_d1: dedSums.D1?.total || 0,
      ded_d2: dedSums.D2?.total || 0,
      ded_d3: dedSums.D3?.total || 0,
      ded_d4: dedSums.D4?.total || 0,
      ded_d5: dedSums.D5?.total || 0,
      sigAt:   consentSig?.signedAt || new Date().toISOString(),
    });

    const safeName = (u.fullName || u.email).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ENPRESA_TAA_${safeName}_${taxYear}.pdf"`);
    res.send(buf);
  } catch (e) {
    console.error('[TAA DOCX] Error:', e.message);
    res.status(500).send('Error generating TAA DOCX: ' + e.message);
  }
});

// ── Enviar solicitud de firma de autorización ATO ─────────────────────────────
router.post('/user/:id/send-consent', requireAdmin, async (req, res) => {
  const { sendConsentRequest } = require('../lib/emails');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');
  try {
    await sendConsentRequest(u);
    return res.redirect(`/admin/user/${u.id}?success=consent_sent#consent`);
  } catch (e) {
    return res.redirect(`/admin/user/${u.id}?error=consent_failed#consent`);
  }
});

router.post('/user/:id/resend-taxagent', requireAdmin, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const { UPLOAD_ROOT } = require('../middleware/upload');
  const path = require('path');
  const fs   = require('fs');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const html = u.taxAgentReportHtml;
  if (!html) return res.redirect(`/admin/user/${u.id}?error=no_report`);

  const clientName = u.fullName || u.email;

  // Recolectar adjuntos del usuario
  const allDocs = sortDocsByCategory(db.get('documents').filter({ userId: u.id }).value());
  const attachments = [];
  for (const d of allDocs) {
    const candidates = [
      d.storedPath,
      d.path,
      d.storedFilename ? path.join(UPLOAD_ROOT, u.id, d.storedFilename) : null,
      d.storedFilename ? path.join(UPLOAD_ROOT, d.storedFilename) : null,
    ].filter(Boolean);
    let found = null;
    for (const p of candidates) { if (fs.existsSync(p)) { found = p; break; } }
    if (!found) continue;
    const ext = path.extname(found).toLowerCase();
    const INCOMPATIBLE = ['.heic', '.heif', '.tiff', '.tif', '.bmp', '.webp'];
    if (INCOMPATIBLE.includes(ext)) continue;
    try {
      const content = fs.readFileSync(found).toString('base64');
      const catLabel = d.category || 'Document';
      const fileName = `[${catLabel}] ${d.originalName || d.storedFilename}`;
      attachments.push({ name: fileName, content });
    } catch (_) {}
  }

  try {
    await sendMail({
      to:      'hola@retaux.com',
      subject: `[RETAUX] Tax Return — ${clientName}`,
      html,
      text:    `Tax return file for ${clientName}. ${attachments.length} document(s) attached.`,
      attachments,
    });
    db.get('users').find({ id: u.id }).assign({ taxAgentSentAt: new Date().toISOString() }).write();
    console.log(`[RESEND TAXAGENT] Sent for ${clientName} — ${attachments.length} attachments`);
  } catch (e) {
    console.error('[RESEND TAXAGENT] Error:', e.message);
  }

  res.redirect(`/admin/user/${u.id}?taxAgentSent=1`);
});

// ── Informe de emisión al cliente ─────────────────────────────────────────────

router.post('/user/:id/emit', requireAdmin, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const grossIncome   = parseFloat(req.body.grossIncome)  || 0;
  const refundAmount  = parseFloat(req.body.refundAmount) || 0;
  const atoRef        = (req.body.atoRef || '').trim();
  const adminNotes    = (req.body.adminNotes || '').trim();

  // Recopilar deducciones cargadas en el usuario
  const DED_LABELS = {
    D1: 'D1 — Work-related car expenses',
    D3: 'D3 — Work-related clothing, laundry & dry-cleaning',
    D4: 'D4 — Work-related self-education',
    D5: 'D5 — Technology & other work-related',
    D6: 'D6 — Home office expenses',
    D9: 'D9 — Gifts or donations',
    D10: 'D10 — Cost of managing tax affairs',
  };
  const dedRows = Object.entries(DED_LABELS).map(([code, label]) => {
    const val = parseFloat(u['deduction' + code]) || 0;
    return val > 0 ? `<tr><td style="padding:10px 4px;border-bottom:1px solid #eef1f4;font-size:14px;color:#1a2430;">${label}</td><td style="padding:10px 4px;border-bottom:1px solid #eef1f4;font-size:14px;text-align:right;color:#1a2430;">AUD ${val.toFixed(2)}</td></tr>` : '';
  }).join('');
  const totalDed = Object.keys(DED_LABELS).reduce((s, c) => s + (parseFloat(u['deduction' + c]) || 0), 0);
  const invoiceNo = 'RTX-EM-' + u.id.slice(0, 6).toUpperCase();
  const emitDate  = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const firstName = (u.fullName || u.email).split(' ')[0];
  const taxYear   = (db.get('payments').find({ userId: u.id, status: 'paid' }).value() || {}).taxYear || '2024-25';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RETAUX — Lodgement Report ${invoiceNo}</title></head>
<body style="margin:0;padding:30px 0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1a2430;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr>
      <td style="padding:28px 32px;">
        <span style="font-family:Arial,sans-serif;font-size:26px;font-weight:900;">
          <span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span>
        </span>
      </td>
      <td align="right" style="padding:28px 32px;">
        <p style="margin:0;color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;">LODGEMENT REPORT</p>
        <p style="margin:4px 0 0;color:#8fa3b8;font-size:12px;">Tax Return — FY ${taxYear}</p>
      </td>
    </tr>
  </table>

  <div style="padding:32px;">

    <div style="background:#e0f4ff;border-left:4px solid #38BDF8;padding:16px 20px;border-radius:6px;margin-bottom:28px;font-size:14px;line-height:1.6;">
      Hi <strong>${firstName}</strong>! Great news — your Australian tax return has been lodged with the ATO. Here is your official lodgement report.
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="vertical-align:top;padding-right:16px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Client</p>
          <p style="margin:0;font-size:14px;">${u.fullName}<br><span style="color:#7a8a9a;">${u.email}</span></p>
        </td>
        <td style="vertical-align:top;text-align:center;padding-right:16px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Report No.</p>
          <p style="margin:0;font-size:14px;font-weight:700;font-family:'Courier New',monospace;">${invoiceNo}</p>
        </td>
        <td style="vertical-align:top;text-align:right;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Date</p>
          <p style="margin:0;font-size:14px;">${emitDate}</p>
        </td>
      </tr>
    </table>

    ${atoRef ? `<div style="margin-bottom:24px;"><p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">ATO Reference</p><p style="margin:0;font-size:14px;font-family:'Courier New',monospace;font-weight:700;">${atoRef}</p></div>` : ''}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:11px;text-transform:uppercase;color:#7a8a9a;border-bottom:2px solid #eef1f4;padding:8px 4px;">Description</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;color:#7a8a9a;border-bottom:2px solid #eef1f4;padding:8px 4px;">Amount (AUD)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;font-weight:600;">Gross Income — FY ${taxYear}</td>
          <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;text-align:right;font-weight:600;">AUD ${grossIncome.toFixed(2)}</td>
        </tr>
        ${dedRows}
        ${totalDed > 0 ? `<tr><td style="padding:10px 4px;border-bottom:2px solid #060C14;font-size:14px;font-weight:600;color:#7a8a9a;">Total Deductions</td><td style="padding:10px 4px;border-bottom:2px solid #060C14;font-size:14px;text-align:right;color:#16a34a;font-weight:600;">− AUD ${totalDed.toFixed(2)}</td></tr>` : ''}
      </tbody>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;border-radius:8px;margin-top:10px;">
      <tr>
        <td style="padding:18px 22px;color:#8fa3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Estimated Refund</td>
        <td style="padding:18px 22px;text-align:right;color:#F0C040;font-size:28px;font-weight:700;">AUD ${refundAmount.toFixed(2)}</td>
      </tr>
    </table>

    ${adminNotes ? `<div style="background:#fff8e6;border-left:4px solid #F0C040;padding:14px 16px;border-radius:6px;font-size:13px;color:#5a4a10;margin-top:24px;line-height:1.6;"><strong>Notes from our team:</strong><br>${adminNotes}</div>` : ''}

    <div style="margin-top:24px;padding:16px 20px;border:1px solid #eef1f4;border-radius:8px;background:#fafbfc;">
      <p style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:#7a8a9a;letter-spacing:0.5px;">Registered Tax Agent</p>
      <p style="margin:0;font-size:14px;line-height:1.7;">Ghada Charbine<br>Tax Practitioners Board (TPB) Registration No. 65195004<br>ABN 58 624 412 713</p>
    </div>

    <div style="text-align:center;margin:32px 0;">
      <a href="https://retaux.com/dashboard" style="background:#38BDF8;color:#060C14;text-decoration:none;font-weight:700;padding:15px 34px;border-radius:30px;display:inline-block;font-size:15px;">View my case status →</a>
    </div>

    <div style="background:#eef1f4;border-radius:6px;padding:14px 16px;font-size:12px;color:#7a8a9a;line-height:1.6;margin-top:8px;">
      The refund amount is an estimate based on the information provided. The final amount is determined by the ATO and may vary. Funds are typically deposited within 2–4 weeks of lodgement.
    </div>

  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr><td style="padding:24px 32px;text-align:center;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:900;"><span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span></p>
      <p style="margin:0;color:#8fa3b8;font-size:12px;line-height:1.8;">hola@retaux.com &nbsp;|&nbsp; www.retaux.com<br>Australia</p>
    </td></tr>
  </table>

</div></body></html>`;

  await sendMail({
    to: u.email,
    subject: `Your Australian tax return has been lodged — ${invoiceNo}`,
    bcc: ['ghadacharbine50@gmail.com', 'hishamcharbine@gmail.com', 'hola@retaux.com'],
    text: `Hi ${firstName},\n\nYour tax return for FY ${taxYear} has been lodged with the ATO.\n\nGross Income: AUD ${grossIncome.toFixed(2)}\nTotal Deductions: AUD ${totalDed.toFixed(2)}\nEstimated Refund: AUD ${refundAmount.toFixed(2)}\n${atoRef ? `ATO Reference: ${atoRef}\n` : ''}\nFunds are typically deposited within 2–4 weeks.\n\nhola@retaux.com | www.retaux.com`,
    html
  });

  db.get('users').find({ id: u.id }).assign({
    taxReturnStage: 'issued',
    emittedAt: new Date().toISOString(),
    emitGross: grossIncome,
    emitRefund: refundAmount,
    emitAtoRef: atoRef || null
  }).write();

  res.redirect(`/admin/user/${u.id}?emitted=1`);
});

// ── Editar datos del cliente desde admin ──────────────────────────────────────

router.post('/user/:id/edit', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const str  = (k) => (req.body[k] || '').trim() || undefined;
  const num  = (k) => (req.body[k] !== '' && req.body[k] !== undefined) ? Number(req.body[k]) : undefined;

  const fields = {
    fullName:            str('fullName'),
    birthDate:           str('birthDate'),
    nationality:         str('nationality'),
    phone:               str('phone'),
    currentAddress:      str('currentAddress'),
    currentVisaSubclass: str('currentVisaSubclass'),
    taxResidencyStatus:  str('taxResidencyStatus'),
    visaStartDate:       str('visaStartDate'),
    visaEndDate:         str('visaEndDate'),
    dateArrived:         str('dateArrived'),
    firstYearResident:   str('firstYearResident'),
    bankAccountName:     str('bankAccountName'),
    bankBSB:             str('bankBSB'),
    bankAccount:         str('bankAccount'),
    bankInterest:        num('bankInterest'),
    otherIncome:         num('otherIncome'),
    deductionD1:         num('deductionD1'),
    deductionD3:         num('deductionD3'),
    deductionD4:         num('deductionD4'),
    deductionD5:         num('deductionD5'),
    deductionD6:         num('deductionD6'),
    deductionD9:         num('deductionD9'),
    deductionD10:        num('deductionD10'),
  };

  // TFN va en u.profile.tfn (igual que el onboarding) y también en u.tfn para compatibilidad
  const tfn = str('tfn');
  if (tfn) {
    fields.tfn = tfn;
    if (!u.profile) fields.profile = { tfn };
    else fields.profile = { ...u.profile, tfn };
  }

  // Solo guardar campos que vinieron con valor (no pisar con undefined)
  const update = {};
  Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) update[k] = v; });

  db.get('users').find({ id: u.id }).assign(update).write();

  console.log(`[ADMIN EDIT] ${Object.keys(update).join(', ')} actualizado en usuario ${u.email}`);
  res.redirect(`/admin/user/${u.id}?saved=1`);
});

// ── Actualizar turno / estimado ───────────────────────────────────────────────

router.post('/user/:id/appointment', (req, res) => {
  const { estimatedRefund, status, adminNotes } = req.body;
  const appt = db.get('appointments').find({ userId: req.params.id });
  if (appt.value()) {
    const updates = {};
    if (estimatedRefund !== undefined && estimatedRefund !== '') updates.estimatedRefund = Number(estimatedRefund);
    if (status) updates.status = status;
    if (adminNotes !== undefined) updates.adminNotes = adminNotes;
    appt.assign(updates).write();
  }
  res.redirect('/admin/user/' + req.params.id + '?saved=1');
});

// ── Actualizar estado de linking ──────────────────────────────────────────────

router.post('/user/:id/linking', (req, res) => {
  const updates = {};
  if (['not_started', 'submitted', 'linked'].includes(req.body.linkingStatus)) {
    updates.linkingStatus = req.body.linkingStatus;
  }
  if (req.body.adminNotes !== undefined) updates.adminNotes = req.body.adminNotes;
  db.get('users').find({ id: req.params.id }).assign(updates).write();
  res.redirect('/admin/user/' + req.params.id + '?saved=1');
});

// ── Actualizar etapa del trámite (post-pago) ─────────────────────────────────

const TAX_RETURN_STAGES = ['paid', 'processing', 'with_agent', 'informal', 'issued'];

router.post('/user/:id/stage', (req, res) => {
  const update = {};
  if (TAX_RETURN_STAGES.includes(req.body.taxReturnStage)) {
    update.taxReturnStage = req.body.taxReturnStage;
  }
  if (req.body.assignedAgent !== undefined) {
    update.assignedAgent = req.body.assignedAgent || '';
  }
  if (req.body.agentPaid !== undefined) {
    update.agentPaid = req.body.agentPaid === 'true';
    update.agentPaidAt = update.agentPaid ? (req.body.agentPaidAt || new Date().toISOString()) : null;
  }
  if (req.body.refundReturned !== undefined) {
    update.refundReturned = req.body.refundReturned === 'true';
    update.refundReturnedAt = update.refundReturned ? (req.body.refundReturnedAt || new Date().toISOString()) : null;
  }
  if (Object.keys(update).length) {
    db.get('users').find({ id: req.params.id }).assign(update).write();
  }
  res.redirect('/admin/user/' + req.params.id + '?saved=1');
});

// ── Servir comprobante de pago ────────────────────────────────────────────────

router.get('/payment-proof/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename); // sanitize
  const filepath = path.join(__dirname, '..', 'uploads', 'payment-proofs', filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Archivo no encontrado');
  res.sendFile(filepath);
});

// ── Confirmar pago manual pendiente ──────────────────────────────────────────

router.post('/payment/:id/confirm', requireAdmin, async (req, res) => {
  const payment = db.get('payments').find({ id: req.params.id }).value();
  if (!payment) return res.redirect('/admin');

  const { sendPaymentConfirmed, sendReferralCode } = require('../lib/emails');

  db.get('payments').find({ id: req.params.id }).assign({
    status: 'paid',
    paidAt: new Date().toISOString()
  }).write();

  // Credit referral points
  const referral = db.get('referrals').find({ referredUserId: payment.userId }).value();
  if (referral && referral.status === 'pending') {
    db.get('referrals').find({ id: referral.id }).assign({ status: 'paid', paidAt: new Date().toISOString() }).write();
    const referrer = db.get('users').find({ id: referral.referrerUserId }).value();
    if (referrer) {
      db.get('users').find({ id: referrer.id }).assign({
        referralPoints: (referrer.referralPoints || 0) + 20
      }).write();
    }
  }

  db.get('users').find({ id: payment.userId }).assign({ onboardingStep: 'done', taxReturnStage: 'processing' }).write();

  const user = db.get('users').find({ id: payment.userId }).value();
  try { await sendPaymentConfirmed(user); } catch(e) { console.error('[EMAIL] sendPaymentConfirmed:', e.message); }
  try { await sendReferralCode(user); } catch(e) { console.error('[EMAIL] sendReferralCode:', e.message); }

  res.redirect('/admin/user/' + payment.userId + '?saved=1');
});

// ── Marcar como cortesía / pago $0 (influencer, colaborador, etc.) ───────────

// ── Cambiar/quitar referidor de un usuario ────────────────────────────────────
router.post('/user/:id/set-custom-price', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const raw = (req.body.customPrice || '').trim();
  const price = raw === '' ? null : Math.round(Number(raw));
  const reason = (req.body.customPriceReason || '').trim() || null;

  db.get('users').find({ id: u.id }).assign({
    customPrice: price,
    customPriceReason: reason
  }).write();

  res.redirect(`/admin/user/${u.id}`);
});

router.post('/user/:id/change-referrer', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const { referralCode } = req.body;
  const code = (referralCode || '').trim().toUpperCase();

  // Eliminar referral record anterior si existe
  const oldReferral = db.get('referrals').find({ referredUserId: u.id }).value();
  if (oldReferral) {
    // Revertir puntos del referidor anterior
    const oldReferrer = db.get('users').find({ id: oldReferral.referrerUserId }).value();
    if (oldReferrer && oldReferral.status === 'paid') {
      db.get('users').find({ id: oldReferrer.id }).assign({
        referralPoints: Math.max(0, (oldReferrer.referralPoints || 0) - 20)
      }).write();
    }
    db.get('referrals').remove({ referredUserId: u.id }).write();
  }

  if (!code) {
    // Sin referidor — limpiar
    db.get('users').find({ id: u.id }).assign({ referredByCode: null, discountApplied: false }).write();
    return res.redirect(`/admin/user/${u.id}?saved=1`);
  }

  const newReferrer = db.get('users').find({ referralCode: code }).value();
  if (!newReferrer) return res.redirect(`/admin/user/${u.id}?error=Código de referido no encontrado`);

  // Crear nuevo referral record
  const { genId } = require('../db/helpers');
  const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value();
  const newStatus = payment ? 'paid' : 'pending';
  db.get('referrals').push({
    id: genId(),
    referrerUserId: newReferrer.id,
    referredUserId: u.id,
    status: newStatus,
    createdAt: new Date().toISOString(),
    paidAt: newStatus === 'paid' ? new Date().toISOString() : null,
    note: 'Asignado manualmente desde admin'
  }).write();

  // Si ya pagó, sumar puntos al nuevo referidor
  if (newStatus === 'paid') {
    db.get('users').find({ id: newReferrer.id }).assign({
      referralPoints: (newReferrer.referralPoints || 0) + 20
    }).write();
  }

  db.get('users').find({ id: u.id }).assign({ referredByCode: code }).write();
  res.redirect(`/admin/user/${u.id}?saved=1`);
});

router.post('/user/:id/mark-courtesy', requireAdmin, async (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  // Si ya tiene un pago pendiente, cancelarlo primero
  const existing = db.get('payments').find({ userId: u.id }).value();
  if (existing) {
    db.get('payments').find({ id: existing.id }).assign({
      status: 'courtesy',
      courtesyAt: new Date().toISOString()
    }).write();
  }

  const { genId, getFinancialYears } = require('../db/helpers');

  // Crear registro de pago cortesía si no existía
  if (!existing) {
    db.get('payments').push({
      id: genId(),
      userId: u.id,
      status: 'courtesy',
      amountCents: 0,
      taxYear: getFinancialYears()[0],
      courtesyAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      note: req.body.note || 'Cortesía'
    }).write();
  }

  // Marcar el pago como paid en la DB para que el sistema lo trate igual
  const payment = db.get('payments').find({ userId: u.id }).value();
  db.get('payments').find({ id: payment.id }).assign({
    status: 'paid',
    amountCents: 0,
    paidAt: new Date().toISOString(),
    courtesy: true,
    courtesyNote: req.body.note || 'Cortesía'
  }).write();

  db.get('users').find({ id: u.id }).assign({
    onboardingStep: 'done',
    taxReturnStage: 'processing'
  }).write();

  console.log(`[CORTESÍA] Pago $0 registrado para ${u.email} por admin`);
  res.redirect('/admin/user/' + u.id + '?saved=1');
});

// ── Admin rechaza pago pendiente ──────────────────────────────────────────────

router.post('/payment/:id/reject', requireAdmin, async (req, res) => {
  const payment = db.get('payments').find({ id: req.params.id }).value();
  if (!payment) return res.redirect('/admin');

  const { sendPaymentRejectedNotification } = require('../lib/emails');

  db.get('payments').find({ id: req.params.id }).assign({
    status: 'rejected',
    rejectedAt: new Date().toISOString()
  }).write();

  db.get('users').find({ id: payment.userId }).assign({ onboardingStep: 'payment' }).write();

  const user = db.get('users').find({ id: payment.userId }).value();
  try { await sendPaymentRejectedNotification(user); } catch(e) { console.error('[ADMIN] Reject email error:', e.message); }

  res.redirect('/admin?rejected=1');
});

// ── Confirmar pago de superannuation ─────────────────────────────────────────

router.post('/super-payment/:id/confirm', requireAdmin, async (req, res) => {
  const sp = db.get('super_payments').find({ id: req.params.id }).value();
  if (!sp) return res.redirect('/admin');

  const { sendSuperPaymentReceipt } = require('../lib/emails');

  db.get('super_payments').find({ id: req.params.id }).assign({
    status: 'paid',
    paidAt: new Date().toISOString()
  }).write();

  const user = db.get('users').find({ id: sp.userId }).value();
  try { await sendSuperPaymentReceipt(user); } catch(e) { console.error('[ADMIN] Super receipt error:', e.message); }

  res.redirect('/admin?super_confirmed=1');
});

// ── Rechazar pago de superannuation ──────────────────────────────────────────

router.post('/super-payment/:id/reject', requireAdmin, async (req, res) => {
  const sp = db.get('super_payments').find({ id: req.params.id }).value();
  if (!sp) return res.redirect('/admin');

  db.get('super_payments').find({ id: req.params.id }).assign({
    status: 'rejected',
    rejectedAt: new Date().toISOString()
  }).write();

  res.redirect('/admin?super_rejected=1');
});

// ── Actualizar estado de referido ─────────────────────────────────────────────

router.post('/referral/:id/status', (req, res) => {
  const { status, returnTo } = req.body;
  if (['pending', 'eligible', 'paid'].includes(status)) {
    db.get('referrals').find({ id: req.params.id }).assign({
      status,
      ...(status === 'paid' ? { paidAt: new Date().toISOString() } : {})
    }).write();
  }
  res.redirect(returnTo || '/admin');
});

// ── Panel de referidos ────────────────────────────────────────────────────────

router.get('/referrals', (req, res) => {
  const users     = db.get('users').value();
  const referrals = db.get('referrals').value();

  // Lista plana: un registro por referido, ordenado por fecha desc
  const referralsList = referrals
    .map(ref => {
      const referrer = users.find(u => u.id === ref.referrerUserId);
      const referred = users.find(u => u.id === ref.referredUserId);
      const dateRaw  = ref.paidAt || ref.createdAt || '';
      const monthKey = dateRaw ? dateRaw.slice(0, 7) : '';
      const monthLabel = dateRaw
        ? new Date(dateRaw).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
        : 'Sin fecha';
      return {
        referrerName:    referrer ? (referrer.fullName || referrer.email) : '—',
        referrerEmail:   referrer ? referrer.email : '—',
        referrerBSB:     referrer ? (referrer.bsb || '') : '',
        referrerAccount: referrer ? (referrer.accountNumber || '') : '',
        referredName:    referred ? (referred.fullName || referred.email) : '—',
        referredEmail:   referred ? referred.email : '—',
        status:          ref.status || 'pending',
        monthKey,        // '2025-06' — para filtro
        monthLabel,      // 'junio 2025' — para mostrar
        dateDisplay:     dateRaw ? new Date(dateRaw).toLocaleDateString('es-AR') : '—'
      };
    })
    .sort((a, b) => (b.monthKey > a.monthKey ? 1 : b.monthKey < a.monthKey ? -1 : 0));

  // Meses únicos para el selector
  const months = [...new Set(referralsList.map(r => r.monthKey).filter(Boolean))]
    .sort().reverse()
    .map(key => ({
      key,
      label: referralsList.find(r => r.monthKey === key)?.monthLabel || key
    }));

  // Totales globales (no cambian con filtros)
  const totalPaidRefs  = referralsList.filter(r => r.status === 'paid').length;
  const totalPending   = referralsList.filter(r => r.status !== 'paid').length;
  const totalReferrers = new Set(referralsList.map(r => r.referrerEmail)).size;
  const totalPaidOut   = totalPaidRefs * 20;

  res.render('admin/referrals', {
    referralsList, months,
    totalReferrers, totalPaidRefs, totalPending, totalPaidOut
  });
});

// ── Calendario de turnos ──────────────────────────────────────────────────────

router.get('/calendar', (req, res) => {
  const summary = slotSummary();
  res.render('admin/calendar', { summary, formatSlot });
});

// ── Descarga de documentos ────────────────────────────────────────────────────

router.get('/user/:id/document/:docId/download', async (req, res) => {
  const doc = db.get('documents').find({ id: req.params.docId, userId: req.params.id }).value();
  if (!doc) return res.status(404).send('No encontrado.');
  const candidates = [
    path.join(UPLOAD_ROOT, req.params.id, doc.taxYear || 'general', doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, 'general', doc.storedFilename),
  ];
  const p = candidates.find(c => fs.existsSync(c));
  if (!p) return res.status(404).send('Archivo no encontrado en el servidor.');

  if (doc.category === 'selfie_id') {
    const user = db.get('users').find({ id: req.params.id }).value();
    const clientName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Client';
    try {
      const pdfBuf = await convertImageToPdf(p);
      const dlName = identityPdfName(clientName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
      return res.send(pdfBuf);
    } catch (e) {
      console.error('convertImageToPdf error:', e.message);
      // fallback a archivo original
    }
  }

  res.download(p, doc.originalName);
});

router.get('/user/:id/document/:docId/view', async (req, res) => {
  const doc = db.get('documents').find({ id: req.params.docId, userId: req.params.id }).value();
  if (!doc) return res.status(404).send('No encontrado.');
  const candidates = [
    path.join(UPLOAD_ROOT, req.params.id, doc.taxYear || 'general', doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, 'general', doc.storedFilename),
  ];
  const p = candidates.find(c => fs.existsSync(c));
  if (!p) return res.status(404).send('Archivo no encontrado en el servidor.');

  const ext = (doc.originalName || '').split('.').pop().toLowerCase();
  if (ext === 'docx') {
    try {
      const result = await mammoth.convertToHtml({ path: p });
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>${doc.originalName}</title>
        <style>body{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 24px;line-height:1.6;color:#111;}
        table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:6px 10px;}
        img{max-width:100%;}
        </style></head><body>${result.value}</body></html>`;
      return res.send(html);
    } catch (e) {
      return res.status(500).send('No se pudo convertir el archivo .docx.');
    }
  }

  if (doc.category === 'selfie_id') {
    const user = db.get('users').find({ id: req.params.id }).value();
    const clientName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Client';
    try {
      const pdfBuf = await convertImageToPdf(p);
      const dlName = identityPdfName(clientName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${dlName}"`);
      return res.send(pdfBuf);
    } catch (e) {
      console.error('convertImageToPdf error:', e.message);
      // fallback a archivo original
    }
  }

  res.setHeader('Content-Disposition', `inline; filename="${doc.originalName}"`);
  res.sendFile(p);
});

// ── Extracción automática de datos de documento (OCR / Claude vision) ────────
router.post('/user/:id/document/:docId/extract', requireAdmin, async (req, res) => {
  const doc = db.get('documents').find({ id: req.params.docId, userId: req.params.id }).value();
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  const candidates = [
    path.join(UPLOAD_ROOT, req.params.id, doc.taxYear || 'general', doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, doc.storedFilename),
    path.join(UPLOAD_ROOT, req.params.id, 'general', doc.storedFilename),
  ];
  const filePath = candidates.find(c => fs.existsSync(c));
  if (!filePath) return res.status(404).json({ error: 'Archivo no encontrado' });

  const ext = (doc.originalName || '').split('.').pop().toLowerCase();

  // ── Paso 1: intentar extracción de texto nativa (PDF / DOCX) ────────────
  let rawText = '';
  try {
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      rawText = data.text || '';
    } else if (ext === 'docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      rawText = result.value || '';
    }
  } catch (_) {}

  // Si tiene suficiente texto, parseamos con regex y devolvemos lo que haya
  if (rawText.length > 30) {
    const extracted = parseTextForFields(rawText);
    // Devolver siempre si hay texto — aunque monto esté vacío el admin puede corregirlo
    if (rawText.length > 30) return res.json(extracted);
  }

  // ── Paso 2: Claude vision para imágenes o PDFs escaneados ───────────────
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.json({ monto: '', descripcion: '', fecha: '', _warning: 'sin_api_key' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: ANTHROPIC_KEY });

    let mediaType, fileContent;
    const fileBuf = fs.readFileSync(filePath);

    // Detectar tipo real por magic bytes (ignora extensión incorrecta)
    function detectMime(buf) {
      if (buf[0]===0xFF && buf[1]===0xD8) return 'image/jpeg';
      if (buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47) return 'image/png';
      if (buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46) return 'image/webp';
      if (buf[0]===0x47 && buf[1]===0x49 && buf[2]===0x46) return 'image/gif';
      if (buf[0]===0x25 && buf[1]===0x50 && buf[2]===0x44 && buf[3]===0x46) return 'application/pdf';
      return null;
    }

    const detectedMime = detectMime(fileBuf);
    fileContent = fileBuf.toString('base64');

    if (detectedMime === 'application/pdf' || ext === 'pdf') {
      mediaType = 'application/pdf';
    } else if (detectedMime && detectedMime.startsWith('image/')) {
      mediaType = detectedMime;
    } else if (['jpg','jpeg','png','webp','gif'].includes(ext)) {
      const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif' };
      mediaType = mimeMap[ext];
    } else {
      return res.json({ monto: '', descripcion: '', fecha: '' });
    }

    const isPdf = mediaType === 'application/pdf';
    const source = isPdf
      ? { type: 'base64', media_type: 'application/pdf', data: fileContent }
      : { type: 'base64', media_type: mediaType, data: fileContent };

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: isPdf ? 'document' : 'image', source },
          { type: 'text', text: 'Extract from this document: 1) the total amount (number only, no currency symbol), 2) a brief description of the service or item (max 60 chars), 3) the date (DD/MM/YYYY). Reply ONLY as JSON: {"monto":"","descripcion":"","fecha":""}' }
        ]
      }]
    });

    const text = message.content[0].text.trim();
    // Non-greedy: captura el primer objeto JSON completo sin incluir llaves de texto posterior
    const match = text.match(/\{[^{}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return res.json({ monto: parsed.monto || '', descripcion: parsed.descripcion || '', fecha: parsed.fecha || '' });
    }
    return res.json({ monto: '', descripcion: '', fecha: '' });
  } catch (e) {
    console.error('[EXTRACT]', e.message);
    return res.status(500).json({ error: 'Error al procesar el archivo' });
  }
});

function parseTextForFields(text) {
  const result = { monto: '', descripcion: '', fecha: '' };

  // Monto: buscar patrones como $1,234.56 o 1234.56 o Total: 500
  const montoMatch = text.match(/(?:total|amount|monto|subtotal|invoice total)[^\d]*(\d[\d,\.]+)/i)
    || text.match(/\$\s*(\d[\d,\.]+)/);
  if (montoMatch) result.monto = montoMatch[1].replace(/,/g, '');

  // Fecha: DD/MM/YYYY o YYYY-MM-DD o Month DD, YYYY
  const fechaMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (fechaMatch) result.fecha = fechaMatch[1];

  // Descripción: primera línea no vacía con al menos 5 caracteres
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
  if (lines.length) result.descripcion = lines[0].slice(0, 60);

  return result;
}

// ── Guardar notas admin en documento ─────────────────────────────────────────

// ── Guardar notas de todos los documentos de un usuario en un solo POST ───────
// ── Upload de documento desde el panel admin ─────────────────────────────────

const _adminUpload = _multer({
  storage: _multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, req.params.id, 'general');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
});

router.post('/user/:id/upload-doc', requireAdmin, _adminUpload.array('adminFile', 30), async (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u || !req.files || !req.files.length) return res.redirect(`/admin/user/${req.params.id}?saved=1`);

  const category = (req.body.category || 'work_expenses').trim();
  const amount   = (req.body.amount   || '').trim();
  const notes    = (req.body.notes    || '').trim();
  const dedCode  = (req.body.dedCode  || '').trim();
  const { genId } = require('../db/helpers');

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    let finalSize = file.size;
    if (IMAGE_EXTS.has(ext)) {
      finalSize = await compressImage(file.path);
    }
    db.get('documents').push({
      id:             genId(),
      userId:         u.id,
      taxYear:        'general',
      category,
      originalName:   file.originalname,
      storedFilename: file.filename,
      sizeBytes:      finalSize,
      uploadedAt:     new Date().toISOString(),
      uploadedBy:     'admin',
      adminAmount:    amount || null,
      adminNotes:     notes  || null,
      adminDedCode:   dedCode || null,
    }).write();
  }

  res.redirect(`/admin/user/${req.params.id}?saved=1#docs`);
});

router.post('/user/:id/document-notes', requireAdmin, (req, res) => {
  const body = req.body;
  // docId viene como array de hidden inputs
  const docIds = Array.isArray(body.docId) ? body.docId : (body.docId ? [body.docId] : []);
  docIds.forEach(id => {
    const amount     = (body[`amount_${id}`]     || '').trim();
    const receiptRef = (body[`receiptRef_${id}`] || '').trim();
    const notes      = (body[`notes_${id}`]      || '').trim();
    const dedCode    = (body[`dedCode_${id}`]    || '').trim();
    db.get('documents').find({ id }).assign({
      adminAmount:     amount     || null,
      adminReceiptRef: receiptRef || null,
      adminNotes:      notes      || null,
      adminDedCode:    dedCode    || null,
    }).write();
  });
  res.redirect(`/admin/user/${req.params.id}?saved=1`);
});

router.post('/user/:id/document/:docId/delete', requireAdmin, (req, res) => {
  const doc = db.get('documents').find({ id: req.params.docId, userId: req.params.id }).value();
  if (!doc) return res.json({ ok: false, error: 'No encontrado' });
  const { UPLOAD_ROOT } = require('../middleware/upload');
  const candidates = [
    path.join(UPLOAD_ROOT, doc.userId, doc.storedFilename),
    path.join(UPLOAD_ROOT, doc.userId, 'general', doc.storedFilename),
    path.join(UPLOAD_ROOT, doc.userId, doc.taxYear || 'general', doc.storedFilename),
  ];
  candidates.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
  db.get('documents').remove({ id: req.params.docId }).write();
  res.json({ ok: true });
});

router.post('/document/:docId/notes', requireAdmin, (req, res) => {
  const doc = db.get('documents').find({ id: req.params.docId }).value();
  if (!doc) return res.status(404).send('No encontrado.');
  const amount     = (req.body.amount     || '').trim();
  const receiptRef = (req.body.receiptRef || '').trim();
  const notes      = (req.body.notes      || '').trim();
  db.get('documents').find({ id: req.params.docId }).assign({
    adminAmount:     amount     || null,
    adminReceiptRef: receiptRef || null,
    adminNotes:      notes      || null,
  }).write();
  res.redirect(`/admin/user/${doc.userId}#doc-${req.params.docId}`);
});

// ── Eliminar usuario ──────────────────────────────────────────────────────────

router.post('/user/:id/delete', (req, res) => {
  const userId = req.params.id;
  const user = db.get('users').find({ id: userId }).value();
  if (!user) return res.redirect('/admin');

  // Borrar usuario y todos sus datos relacionados
  db.get('users').remove({ id: userId }).write();
  db.get('documents').remove({ userId }).write();
  db.get('taxYearProfiles').remove({ userId }).write();
  db.get('payments').remove({ userId }).write();
  db.get('appointments').remove({ userId }).write();
  db.get('referrals').remove({ referredUserId: userId }).write();
  db.get('daspRequests').remove({ userId }).write();

  // Borrar archivos subidos
  const fs = require('fs');
  const uploadDir = require('path').join(UPLOAD_ROOT, userId);
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  console.log(`[ADMIN] Usuario eliminado: ${user.email} por ${req.adminUser.email}`);
  res.redirect('/admin?deleted=1');
});

// ── Export Excel con todos los datos de usuarios ──────────────────────────────

router.get('/export/users.xlsx', async (req, res) => {
  const ExcelJS = require('exceljs');
  const users = db.get('users').value();
  const payments = db.get('payments').value();
  const referrals = db.get('referrals').value();
  const documents = db.get('documents').value();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RETAUX';
  wb.created = new Date();

  // ── Hoja 1: Usuarios ──
  const ws = wb.addWorksheet('Usuarios');
  ws.columns = [
    { header: 'ID', key: 'id', width: 20 },
    { header: 'Nombre completo', key: 'fullName', width: 25 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Email verificado', key: 'emailVerified', width: 18 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Nacionalidad', key: 'nationality', width: 18 },
    { header: 'Dirección', key: 'currentAddress', width: 35 },
    { header: 'Visa', key: 'currentVisaSubclass', width: 15 },
    { header: 'Inicio visa', key: 'visaStartDate', width: 15 },
    { header: 'Fin visa', key: 'visaEndDate', width: 15 },
    { header: 'TFN', key: 'tfn', width: 15 },
    { header: 'Nombre cuenta bancaria', key: 'bankAccountName', width: 25 },
    { header: 'BSB', key: 'bsb', width: 12 },
    { header: 'Número de cuenta', key: 'accountNumber', width: 20 },
    { header: 'Código de referido', key: 'referralCode', width: 18 },
    { header: 'Referido por', key: 'referredByCode', width: 18 },
    { header: 'Puntos referidos (AUD)', key: 'referralPoints', width: 22 },
    { header: 'Estado onboarding', key: 'onboardingStep', width: 20 },
    { header: 'Pago confirmado', key: 'paid', width: 18 },
    { header: 'Monto pagado (AUD)', key: 'amountPaid', width: 20 },
    { header: 'Fecha pago', key: 'paidAt', width: 20 },
    { header: 'Documentos subidos', key: 'docCount', width: 20 },
    { header: 'Fecha registro', key: 'createdAt', width: 22 },
  ];

  // Header style
  ws.getRow(1).font = { bold: true, color: { argb: 'FF060920' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC107' } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 22;

  users.forEach(u => {
    const payment = payments.find(p => p.userId === u.id && p.status === 'paid');
    ws.addRow({
      id: u.id,
      fullName: u.fullName || '',
      email: u.email || '',
      emailVerified: u.emailVerified ? 'Sí' : 'No',
      phone: u.phone || '',
      nationality: u.nationality || '',
      currentAddress: u.currentAddress || '',
      currentVisaSubclass: u.currentVisaSubclass || '',
      visaStartDate: u.visaStartDate || '',
      visaEndDate: u.visaEndDate || '',
      tfn: u.tfn || '',
      bankAccountName: u.bankAccountName || '',
      bsb: u.bsb || '',
      accountNumber: u.accountNumber || '',
      referralCode: u.referralCode || '',
      referredByCode: u.referredByCode || '',
      referralPoints: u.referralPoints || 0,
      onboardingStep: u.onboardingStep || '',
      paid: payment ? 'Sí' : 'No',
      amountPaid: payment ? (payment.amountCents || 0) / 100 : '',
      paidAt: payment ? payment.paidAt : '',
      docCount: documents.filter(d => d.userId === u.id).length,
      createdAt: u.createdAt || '',
    });
  });

  // Alternate row colors
  ws.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: rowNumber % 2 === 0 ? 'FFF0F4F8' : 'FFFFFFFF' }
      };
    }
  });

  // ── Hoja 2: Documentos subidos ──
  const wsDocs = wb.addWorksheet('Documentos');
  wsDocs.columns = [
    { header: 'Usuario', key: 'userName', width: 25 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Categoría', key: 'category', width: 20 },
    { header: 'Archivo original', key: 'originalName', width: 35 },
    { header: 'Año fiscal', key: 'taxYear', width: 15 },
    { header: 'Fecha subida', key: 'uploadedAt', width: 22 },
  ];
  wsDocs.getRow(1).font = { bold: true, color: { argb: 'FF060920' } };
  wsDocs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4FC3F7' } };
  wsDocs.getRow(1).height = 22;

  documents.forEach(d => {
    const u = users.find(u => u.id === d.userId);
    wsDocs.addRow({
      userName: u ? u.fullName : d.userId,
      email: u ? u.email : '',
      category: d.category || '',
      originalName: d.originalName || d.storedFilename || '',
      taxYear: d.taxYear || 'general',
      uploadedAt: d.uploadedAt || d.createdAt || '',
    });
  });

  // ── Hoja 3: Referidos ──
  const wsRef = wb.addWorksheet('Referidos');
  wsRef.columns = [
    { header: 'Referidor', key: 'referrerName', width: 25 },
    { header: 'Email referidor', key: 'referrerEmail', width: 30 },
    { header: 'Referido', key: 'referredName', width: 25 },
    { header: 'Email referido', key: 'referredEmail', width: 30 },
    { header: 'Estado', key: 'status', width: 15 },
    { header: 'Fecha', key: 'createdAt', width: 22 },
    { header: 'Fecha pago', key: 'paidAt', width: 22 },
  ];
  wsRef.getRow(1).font = { bold: true, color: { argb: 'FF060920' } };
  wsRef.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF69F0AE' } };
  wsRef.getRow(1).height = 22;

  referrals.forEach(r => {
    const referrer = users.find(u => u.id === r.referrerUserId);
    const referred = users.find(u => u.id === r.referredUserId);
    wsRef.addRow({
      referrerName: referrer ? referrer.fullName : r.referrerUserId,
      referrerEmail: referrer ? referrer.email : '',
      referredName: referred ? referred.fullName : r.referredUserId,
      referredEmail: referred ? referred.email : '',
      status: r.status || '',
      createdAt: r.createdAt || '',
      paidAt: r.paidAt || '',
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="retaux-usuarios-${new Date().toISOString().slice(0,10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Gestión de referidores ────────────────────────────────────────────────────

router.get('/referrers', (req, res) => {
  const referrers = db.get('users').filter({ role: 'referrer' }).value();
  const referrals = db.get('referrals').value();
  const list = referrers.map(u => {
    const myRefs = referrals.filter(r => r.referrerUserId === u.id);
    const paid = myRefs.filter(r => r.status === 'paid').length;
    return { ...u, referredCount: myRefs.length, paidCount: paid, earned: paid * 20 };
  });
  res.render('admin/referrers', { referrers: list, success: req.query.success || null, error: req.query.error || null });
});

router.post('/referrers/create', async (req, res) => {
  const { fullName, email, pin, codeSuffix } = req.body;
  const redirect = (err) => res.redirect(`/admin/referrers?error=${encodeURIComponent(err)}`);

  const suffixClean = (codeSuffix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!fullName || !email || !pin || !suffixClean) return redirect('Completá todos los campos.');
  if (!PIN_REGEX.test(pin)) return redirect('La clave debe tener exactamente 8 dígitos numéricos.');
  if (suffixClean.length < 3 || suffixClean.length > 6) return redirect('El código debe tener entre 3 y 6 caracteres alfanuméricos.');

  const code = `RTX-${suffixClean}`;
  const normalizedEmail = email.toLowerCase().trim();

  if (db.get('users').find({ referralCode: code }).value()) return redirect('Ese código ya existe. Elegí otro.');
  if (db.get('users').find({ email: normalizedEmail }).value()) return redirect('Ya existe una cuenta con ese e-mail.');

  const pinHash = await bcrypt.hash(pin, 10);
  db.get('users').push({
    id: genId(),
    fullName: fullName.trim(),
    email: normalizedEmail,
    pinHash,
    role: 'referrer',
    emailVerified: true,
    referralCode: code,
    referredByCode: null,
    referralPoints: 0,
    createdAt: new Date().toISOString()
  }).write();

  try {
    const { sendReferrerWelcomeEmail } = require('../lib/emails');
    await sendReferrerWelcomeEmail({ fullName: fullName.trim(), email: normalizedEmail, referralCode: code });
    console.log(`[REFERRER WELCOME] Email sent to ${normalizedEmail}`);
  } catch (emailErr) {
    console.error(`[REFERRER WELCOME] Email failed for ${normalizedEmail}: ${emailErr.message}`);
  }

  res.redirect(`/admin/referrers?success=${encodeURIComponent('Referidor creado exitosamente.')}`);
});

// ── Export ZIP con todos los archivos de usuarios ─────────────────────────────

router.get('/export/files.zip', (req, res) => {
  const archiver = require('archiver');
  const users = db.get('users').value();
  const documents = db.get('documents').value();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="retaux-archivos-${new Date().toISOString().slice(0,10)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('ZIP error:', err); res.end(); });
  archive.pipe(res);

  documents.forEach(d => {
    const u = users.find(u => u.id === d.userId);
    const userName = (u ? u.fullName : d.userId).replace(/[^a-zA-Z0-9_\- ]/g, '_');
    const filePath = path.join(UPLOAD_ROOT, d.userId, d.taxYear || 'general', d.storedFilename);
    if (fs.existsSync(filePath)) {
      const folder = `${userName} (${u ? u.email : d.userId})/${d.taxYear || 'general'}/${d.category || 'general'}`;
      archive.file(filePath, { name: `${folder}/${d.originalName || d.storedFilename}` });
    }
  });

  archive.finalize();
});

// ── Export Excel: lista completa de clientes enviados al tax agent ────────────

router.get('/export/taxagent-clients.xlsx', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const NAVY  = 'FF0A0E5C';
  const GOLD  = 'FFFFC107';
  const WHITE = 'FFFFFFFF';
  const YELLOW= 'FFFFF2CC';
  const GREY  = 'FFF0F4F8';

  const clients = db.get('users').filter(u => u.taxAgentSentAt).value();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RETAUX';
  wb.created = new Date();

  const ws = wb.addWorksheet('Tax Agent Clients');
  ws.columns = [
    { key: 'num',    width: 5  },
    { key: 'name',   width: 28 },
    { key: 'email',  width: 30 },
    { key: 'tfn',    width: 16 },
    { key: 'sentAt', width: 16 },
    { key: 'taxYear',width: 12 },
    { key: 'gross',  width: 20 },
    { key: 'ret',    width: 20 },
    { key: 'notes',  width: 30 },
  ];

  // Title row
  ws.mergeCells('A1:I1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'RETAUX — Tax Agent Client List';
  titleCell.font = { bold: true, color: { argb: GOLD }, size: 13 };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Subtitle
  ws.mergeCells('A2:I2');
  const subCell = ws.getCell('A2');
  subCell.value = `Generated: ${new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'long', year:'numeric' })} — ${clients.length} client(s)`;
  subCell.font = { italic: true, color: { argb: 'FF888888' }, size: 9 };
  subCell.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 16;

  // Header row
  const headers = ['#', 'Full Name', 'Email', 'TFN', 'Sent to Agent', 'Tax Year', 'Gross Income (AUD)', 'Tax Return (AUD)', 'Notes'];
  const hRow = ws.addRow(headers);
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: GOLD } } };
  });
  ws.getRow(3).height = 20;

  // Data rows
  clients.forEach((u, i) => {
    const payment = db.get('payments').find({ userId: u.id, status: 'paid' }).value() || {};
    const sentDate = u.taxAgentSentAt ? new Date(u.taxAgentSentAt).toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit', year:'numeric' }) : '';
    const row = ws.addRow([
      i + 1,
      u.fullName || u.email,
      u.email,
      u.tfn || '',
      sentDate,
      payment.taxYear || '',
      u.taxAgentGrossIncome || '',
      u.taxAgentReturnAmt  || '',
      u.taxAgentNotes      || '',
    ]);
    const fillColor = i % 2 === 0 ? WHITE : GREY;
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      cell.font = { size: 10 };
      cell.alignment = { vertical: 'middle' };
    });
    // Yellow fill on editable columns (gross / return / notes)
    [7, 8, 9].forEach(colIdx => {
      row.getCell(colIdx).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    });
    row.height = 18;
  });

  // Legend
  ws.addRow([]);
  const legendRow = ws.addRow(['', 'Yellow cells = editable by tax agent (Gross Income, Tax Return, Notes)']);
  legendRow.getCell(2).font = { italic: true, size: 9, color: { argb: 'FF999999' } };

  // Freeze panes below header
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  const dateStr = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="RETAUX-TaxAgent-Clients-${dateStr}.xlsx"`);
  await wb.xlsx.write(res);
});

// ── Export ZIP Tax Agent: Excel + todos los documentos del cliente ────────────

router.get('/export/user/:id-taxagent.zip', requireAdmin, async (req, res) => {
  const ExcelJS  = require('exceljs');
  const archiver = require('archiver');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const allDocs = db.get('documents').filter({ userId: u.id }).value();

  const INCOME_CATS = {
    payslips:             'Income - Payslips',
    abn_income:           'Income - ABN Income',
    investment_statements:'Income - Investment Statements',
  };
  const DEDUCTION_CATS = {
    certifications:   'Deductions - Certifications',
    training:         'Deductions - Training & Courses',
    work_expenses:    'Deductions - Uniforms & Tools',
    tech_purchases:   'Deductions - Technology',
    home_office:      'Deductions - Home Office',
    donation_receipts:'Deductions - Donations',
  };
  const ALL_CAT_FOLDERS = { ...INCOME_CATS, ...DEDUCTION_CATS, selfie_id: 'Identity Document' };

  // ── Build Excel in memory ─────────────────────────────────────────────────
  const NAVY       = 'FF0A0E5C';
  const WHITE      = 'FFFFFFFF';
  const YELLOW     = 'FFFFF2CC';
  const MISSING_RED= 'FFFFC7CE';
  const GREEN_BG   = 'FFE2EFDA';
  const BLUE_SEC   = 'FF1D4ED8';
  const LIGHT_BLUE = 'FFE8F0FE';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RETAUX';
  wb.created = new Date();

  const applyHeader = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: WHITE }, size: 11 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 22;
  };
  const val = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;
  const addField = (ws, label, atoCode, value, note) => {
    const missing = !value;
    const row = ws.addRow([label, atoCode || '', value || '⚠ MISSING', note || '']);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(2).font = { color: { argb: 'FF555555' }, italic: true, size: 10 };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: missing ? MISSING_RED : YELLOW } };
    row.getCell(3).font = { size: 10, bold: missing };
    row.getCell(4).font = { color: { argb: 'FF555555' }, italic: true, size: 9 };
    row.height = 18;
  };
  const addSectionTitle = (ws, title, cols) => {
    const row = ws.addRow([title]);
    row.font = { bold: true, color: { argb: WHITE }, size: 10 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE_SEC } };
    row.height = 20;
    if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
  };
  const addCatHeader = (ws, label, cols) => {
    const row = ws.addRow([label]);
    row.font = { bold: true, size: 10, color: { argb: NAVY } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_BLUE } };
    row.height = 19;
    if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
  };

  // Sheet 1: Individual Info
  const ws1 = wb.addWorksheet('Individual Info');
  ws1.columns = [{ header:'Field', width:32 },{ header:'ATO Code', width:12 },{ header:'Response', width:40 },{ header:'Notes', width:40 }];
  applyHeader(ws1);
  addSectionTitle(ws1, 'PERSONAL INFORMATION', 4);
  addField(ws1,'Full Name',null,val(u.fullName),'As per passport');
  addField(ws1,'Date of Birth',null,val(u.birthDate),'DD/MM/YYYY');
  addField(ws1,'Tax File Number (TFN)','TFN',val(u.profile&&u.profile.tfn?u.profile.tfn:u.tfn),'Confidential');
  addField(ws1,'Nationality',null,val(u.nationality),null);
  addField(ws1,'Visa Subclass',null,val(u.currentVisaSubclass),'e.g. 417 Working Holiday');
  addField(ws1,'Visa Start Date',null,val(u.visaStartDate),null);
  addField(ws1,'Visa End Date',null,val(u.visaEndDate),null);
  addField(ws1,'Tax Residency Status',null,val(u.taxResidencyStatus),'Resident / Foreign Resident / WHM');
  addField(ws1,'First Year as Resident',null,val(u.firstYearResident),null);
  addField(ws1,'Date Arrived in Australia',null,val(u.dateArrived),null);
  ws1.addRow([]);
  addSectionTitle(ws1,'CURRENT ADDRESS',4);
  addField(ws1,'Address (Australia)',null,val(u.currentAddress),'Full street address');
  ws1.addRow([]);
  addSectionTitle(ws1,'IDENTITY DOCUMENT (PHOTO)',4);
  const selfieDoc = allDocs.find(d => d.category === 'selfie_id');
  if (selfieDoc) {
    const r = ws1.addRow(['Passport / ID Photo','', selfieDoc.originalName||selfieDoc.storedFilename||'—', 'See: Identity Document/' + (selfieDoc.originalName||selfieDoc.storedFilename||'')]);
    r.getCell(3).fill = { type:'pattern',pattern:'solid',fgColor:{argb:GREEN_BG} };
    r.getCell(3).font = { color:{argb:'FF217346'},bold:true,size:10 };
    r.height = 18;
  } else {
    const r = ws1.addRow(['Passport / ID Photo','','⚠ MISSING — Required','Client must upload via RETAUX portal']);
    r.getCell(3).fill = { type:'pattern',pattern:'solid',fgColor:{argb:MISSING_RED} };
    r.getCell(3).font = { bold:true,size:10 };
    r.height = 18;
  }

  // Sheet 2: Income
  const ws2 = wb.addWorksheet('Income');
  ws2.columns = [{ header:'Field', width:34 },{ header:'ATO Code', width:12 },{ header:'Detail / File', width:38 },{ header:'Amount (AUD)', width:18 },{ header:'Notes', width:32 }];
  applyHeader(ws2);
  const employers = u.employers || [];
  addSectionTitle(ws2,'EMPLOYMENT INCOME',5);
  if (employers.length > 0) {
    employers.forEach((emp, i) => {
      ws2.addRow([]);
      const hdr = ws2.addRow([`Employer ${i+1}: ${emp.name||'—'}`]);
      hdr.font = { bold:true,size:10 };
      hdr.fill = { type:'pattern',pattern:'solid',fgColor:{argb:LIGHT_BLUE} };
      ws2.mergeCells(hdr.number,1,hdr.number,5);
      const ef = (label,ato,detail,amount,note) => {
        const missing = detail===null||detail===undefined||String(detail).trim()==='';
        const r = ws2.addRow([label,ato||'',missing?'⚠ MISSING':String(detail),amount!=null?Number(amount):'',note||'']);
        r.getCell(3).fill = { type:'pattern',pattern:'solid',fgColor:{argb:missing?MISSING_RED:YELLOW} };
        r.getCell(4).numFmt = '$#,##0.00'; r.height=17;
      };
      ef('ABN','ABN',val(emp.abn),null,null);
      ef('Gross Income','1',null,emp.grossIncome,'Total gross earnings');
      ef('Tax Withheld','2',null,emp.taxWithheld,'PAYG withheld');
      ef('Period From',null,val(emp.periodFrom),null,null);
      ef('Period To',null,val(emp.periodTo),null,null);
    });
  } else { ws2.addRow(['No employers recorded','','','','']); }
  ws2.addRow([]);
  addSectionTitle(ws2,'OTHER INCOME',5);
  const biR = ws2.addRow(['Bank Interest','10','',val(u.bankInterest)?Number(u.bankInterest):'','From annual bank statement']);
  biR.getCell(4).numFmt='$#,##0.00';
  const oiR = ws2.addRow(['Other Income',null,'',val(u.otherIncome)?Number(u.otherIncome):'',null]);
  oiR.getCell(4).numFmt='$#,##0.00';
  ws2.addRow([]);
  addSectionTitle(ws2,'INCOME DOCUMENTS — see Documents/ folder in ZIP',5);
  Object.entries(INCOME_CATS).forEach(([catId, catLabel]) => {
    addCatHeader(ws2, catLabel.replace('Income - ',''), 5);
    const catDocs = allDocs.filter(d => d.category === catId);
    if (catDocs.length === 0) {
      const r = ws2.addRow(['','','No documents uploaded','','']);
      r.getCell(3).font = { italic:true,color:{argb:'FF888888'},size:9 };
    } else {
      catDocs.forEach(d => {
        const r = ws2.addRow(['','',d.originalName||d.storedFilename||'—','',d.uploadedAt||d.createdAt||'']);
        r.getCell(3).fill = { type:'pattern',pattern:'solid',fgColor:{argb:GREEN_BG} };
        r.getCell(3).font = { color:{argb:'FF217346'},size:10 };
        r.height=17;
      });
    }
  });

  // Sheet 3: Deductions
  const ws3 = wb.addWorksheet('Deductions');
  ws3.columns = [{ header:'Deduction', width:38 },{ header:'ATO Code', width:12 },{ header:'Detail / File', width:38 },{ header:'Amount (AUD)', width:18 },{ header:'Notes', width:34 }];
  applyHeader(ws3);
  const deductions = [
    { label:'Work-related car expenses',    ato:'D1',  key:'deductionD1',  note:'Logbook or cents-per-km method' },
    { label:'Work-related travel expenses', ato:'D3',  key:'deductionD3',  note:'Airfare, accommodation if work-required' },
    { label:'Uniforms, clothing & laundry', ato:'D4',  key:'deductionD4',  note:'Compulsory uniform only' },
    { label:'Self-education expenses',      ato:'D5',  key:'deductionD5',  note:'Directly related to current employment' },
    { label:'Other work-related expenses',  ato:'D6',  key:'deductionD6',  note:'Tools, phone, internet (work portion)' },
    { label:'Gifts or donations',           ato:'D9',  key:'deductionD9',  note:'DGR-registered charities only' },
    { label:'Cost of managing tax affairs', ato:'D10', key:'deductionD10', note:'Tax agent fees' },
  ];
  addSectionTitle(ws3,'DEDUCTIONS',5);
  const deductRowNums = [];
  deductions.forEach(d => {
    const amount = u[d.key];
    const has = amount!==undefined&&amount!==null&&amount!==''&&Number(amount)>0;
    const r = ws3.addRow([d.label,d.ato,'',has?Number(amount):'',d.note]);
    r.getCell(1).font={bold:true,size:10}; r.getCell(2).font={color:{argb:'FF555555'},italic:true,size:10};
    r.getCell(4).fill={type:'pattern',pattern:'solid',fgColor:{argb:has?GREEN_BG:YELLOW}};
    r.getCell(4).numFmt='$#,##0.00'; r.getCell(5).font={color:{argb:'FF555555'},italic:true,size:9};
    r.height=18; deductRowNums.push(r.number);
  });
  const totalR = ws3.addRow(['TOTAL DEDUCTIONS','','',{formula:deductRowNums.map(n=>`D${n}`).join('+')},'' ]);
  totalR.font={bold:true,size:11}; totalR.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFC107'}};
  totalR.getCell(4).numFmt='$#,##0.00';
  ws3.addRow([]);
  addSectionTitle(ws3,'DEDUCTION DOCUMENTS — see Documents/ folder in ZIP',5);
  Object.entries(DEDUCTION_CATS).forEach(([catId, catLabel]) => {
    addCatHeader(ws3, catLabel.replace('Deductions - ',''), 5);
    const catDocs = allDocs.filter(d => d.category === catId);
    if (catDocs.length === 0) {
      const r = ws3.addRow(['','','No documents uploaded','','']);
      r.getCell(3).font={italic:true,color:{argb:'FF888888'},size:9};
    } else {
      catDocs.forEach(d => {
        const r = ws3.addRow(['','',d.originalName||d.storedFilename||'—','',d.uploadedAt||d.createdAt||'']);
        r.getCell(3).fill={type:'pattern',pattern:'solid',fgColor:{argb:GREEN_BG}};
        r.getCell(3).font={color:{argb:'FF217346'},size:10}; r.height=17;
      });
    }
  });

  // Generate Excel buffer
  const xlsxBuffer = await wb.xlsx.writeBuffer();

  // ── Build ZIP ─────────────────────────────────────────────────────────────
  const safeName = (u.fullName||u.email||u.id).replace(/[^a-zA-Z0-9\- ]/g,'_').trim();
  const dateStr = new Date().toISOString().slice(0,10);

  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="RETAUX-TaxAgent-${safeName}-${dateStr}.zip"`);

  const archive = archiver('zip',{ zlib:{ level:6 } });
  archive.on('error', err => { console.error('ZIP error:',err); res.end(); });
  archive.pipe(res);

  // Add the Excel report
  archive.append(Buffer.from(xlsxBuffer), { name: `RETAUX-TaxAgent-${safeName}-${dateStr}.xlsx` });

  // Add each document in its category subfolder
  allDocs.forEach(d => {
    const filePath = path.join(UPLOAD_ROOT, u.id, d.taxYear||'general', d.storedFilename);
    if (fs.existsSync(filePath)) {
      const folder = ALL_CAT_FOLDERS[d.category] || ('Other - ' + (d.category||'general'));
      const fileName = d.originalName || d.storedFilename;
      archive.file(filePath, { name: `Documents/${folder}/${fileName}` });
    }
  });

  archive.finalize();
});

// ── Export Excel RETAUX (para uso interno / tax agent interno) ────────────────

router.get('/export/user/:id-retaux.xlsx', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const allDocs = db.get('documents').filter({ userId: u.id }).value();

  // Document categories mapped to section
  const INCOME_CATS = ['payslips', 'abn_income', 'investment_statements'];
  const DEDUCTION_CATS = ['certifications', 'training', 'work_expenses', 'tech_purchases', 'home_office', 'donation_receipts'];
  const INCOME_CAT_LABELS = {
    payslips: 'Payslips',
    abn_income: 'ABN Income',
    investment_statements: 'Investment Statements',
  };
  const DEDUCTION_CAT_LABELS = {
    certifications: 'Certifications (RSA, White Card, etc.)',
    training: 'Training & Courses Paid',
    work_expenses: 'Uniforms, Workwear & Tools',
    tech_purchases: 'Technology for Work',
    home_office: 'Home Office / Working from Home',
    donation_receipts: 'Donations',
  };

  const NAVY   = 'FF0A0E5C';
  const WHITE  = 'FFFFFFFF';
  const YELLOW = 'FFFFF2CC';
  const MISSING_RED = 'FFFFC7CE';
  const GREEN_BG = 'FFE2EFDA';
  const BLUE_SECTION = 'FF1D4ED8';
  const LIGHT_BLUE = 'FFE8F0FE';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RETAUX';
  wb.created = new Date();

  const applyHeader = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: WHITE }, size: 11 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 22;
  };

  const val = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;

  const addField = (ws, label, value, note) => {
    const missing = !value;
    const row = ws.addRow([label, '', value || '⚠ MISSING — Required', note || '']);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: missing ? MISSING_RED : YELLOW } };
    row.getCell(3).font = { size: 10, bold: missing };
    row.getCell(4).font = { color: { argb: 'FF555555' }, italic: true, size: 9 };
    row.height = 18;
  };

  const addSectionTitle = (ws, title, cols) => {
    const row = ws.addRow([title]);
    row.font = { bold: true, color: { argb: WHITE }, size: 10 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE_SECTION } };
    row.height = 20;
    if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
  };

  // ── SHEET 1: Individual Info ──────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Individual Info');
  ws1.columns = [
    { header: 'Field',            key: 'field',    width: 32 },
    { header: 'ATO Code',         key: 'ato',      width: 12 },
    { header: 'Response',         key: 'response', width: 40 },
    { header: 'Notes',            key: 'notes',    width: 38 },
  ];
  applyHeader(ws1);

  addSectionTitle(ws1, 'PERSONAL INFORMATION', 4);
  addField(ws1, 'Full Name',              val(u.fullName),                       'As per passport');
  addField(ws1, 'Date of Birth',          val(u.birthDate),                      'DD/MM/YYYY');
  addField(ws1, 'Tax File Number (TFN)',  val(u.profile && u.profile.tfn ? u.profile.tfn : u.tfn), 'Confidential');
  addField(ws1, 'Nationality',            val(u.nationality),                    null);
  addField(ws1, 'Visa Subclass',          val(u.currentVisaSubclass),            'e.g. 417');
  addField(ws1, 'Visa Start Date',        val(u.visaStartDate),                  null);
  addField(ws1, 'Visa End Date',          val(u.visaEndDate),                    null);
  addField(ws1, 'Tax Residency Status',   val(u.taxResidencyStatus),             'Resident / Foreign Resident / WHM');

  ws1.addRow([]);

  addSectionTitle(ws1, 'ACTUAL ADDRESS (AUSTRALIA)', 4);
  addField(ws1, 'Current Address',        val(u.currentAddress),                 'Full street address');

  ws1.addRow([]);

  // ID photo / selfie_id
  addSectionTitle(ws1, 'IDENTITY DOCUMENT (PHOTO)', 4);
  const selfieDoc = allDocs.find(d => d.category === 'selfie_id');
  if (selfieDoc) {
    const selfieRow = ws1.addRow(['Document uploaded', '', selfieDoc.originalName || selfieDoc.storedFilename, selfieDoc.uploadedAt || selfieDoc.createdAt || '']);
    selfieRow.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
    selfieRow.getCell(3).font = { color: { argb: 'FF217346' }, bold: true, size: 10 };
    selfieRow.height = 18;
  } else {
    const missingRow = ws1.addRow(['Passport / ID Photo', '', '⚠ MISSING — Required', 'Client must upload via RETAUX portal']);
    missingRow.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MISSING_RED } };
    missingRow.getCell(3).font = { bold: true, size: 10 };
    missingRow.height = 18;
  }

  // ── SHEET 2: Income ───────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Income');
  ws2.columns = [
    { header: 'Field',         key: 'field',   width: 34 },
    { header: 'ATO Code',      key: 'ato',     width: 12 },
    { header: 'Detail / File', key: 'detail',  width: 38 },
    { header: 'Amount (AUD)',  key: 'amount',  width: 18 },
    { header: 'Notes',         key: 'notes',   width: 32 },
  ];
  applyHeader(ws2);

  const employers = u.employers || [];

  addSectionTitle(ws2, 'EMPLOYMENT INCOME', 5);
  if (employers.length > 0) {
    employers.forEach((emp, i) => {
      ws2.addRow([]);
      const empHeader = ws2.addRow([`Employer ${i + 1}: ${emp.name || '—'}`]);
      empHeader.font = { bold: true, size: 10 };
      empHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_BLUE } };
      ws2.mergeCells(empHeader.number, 1, empHeader.number, 5);

      const empRow = (label, ato, detail, amount, note) => {
        const missing = detail === null || detail === undefined || String(detail).trim() === '';
        const r = ws2.addRow([label, ato || '', missing ? '⚠ MISSING' : String(detail), amount != null ? Number(amount) : '', note || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: missing ? MISSING_RED : YELLOW } };
        r.getCell(4).numFmt = '$#,##0.00';
        r.height = 17;
      };

      empRow('ABN',            'ABN', val(emp.abn),         null,             null);
      empRow('Gross Income',   '1',   null,                 emp.grossIncome,  'Total gross earnings');
      empRow('Tax Withheld',   '2',   null,                 emp.taxWithheld,  'PAYG withheld');
      empRow('Period From',    null,  val(emp.periodFrom),  null,             null);
      empRow('Period To',      null,  val(emp.periodTo),    null,             null);
    });
  } else {
    ws2.addRow(['No employers recorded', '', '', '', '']);
  }

  ws2.addRow([]);

  addSectionTitle(ws2, 'OTHER INCOME', 5);
  const bankInterest = val(u.bankInterest);
  const biRow = ws2.addRow(['Bank Interest', '10', '', bankInterest ? Number(bankInterest) : '', 'From annual bank statement']);
  biRow.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  biRow.getCell(4).numFmt = '$#,##0.00';

  const otherIncome = val(u.otherIncome);
  const oiRow = ws2.addRow(['Other Income', null, '', otherIncome ? Number(otherIncome) : '', null]);
  oiRow.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  oiRow.getCell(4).numFmt = '$#,##0.00';

  // Income documents
  ws2.addRow([]);
  addSectionTitle(ws2, 'INCOME DOCUMENTS UPLOADED', 5);

  INCOME_CATS.forEach(catId => {
    const catDocs = allDocs.filter(d => d.category === catId);
    const catLabelRow = ws2.addRow([INCOME_CAT_LABELS[catId]]);
    catLabelRow.font = { bold: true, size: 10, color: { argb: 'FF0A0E5C' } };
    catLabelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
    ws2.mergeCells(catLabelRow.number, 1, catLabelRow.number, 5);

    if (catDocs.length === 0) {
      const emptyRow = ws2.addRow(['', '', 'No documents uploaded for this category', '', '']);
      emptyRow.getCell(3).font = { italic: true, color: { argb: 'FF888888' }, size: 9 };
    } else {
      catDocs.forEach(d => {
        const r = ws2.addRow(['', '', d.originalName || d.storedFilename || '—', '', d.uploadedAt || d.createdAt || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
        r.getCell(3).font = { color: { argb: 'FF217346' }, size: 10 };
        r.height = 17;
      });
    }
  });

  // ── SHEET 3: Deductions ───────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Deductions');
  ws3.columns = [
    { header: 'Deduction',     key: 'field',   width: 38 },
    { header: 'ATO Code',      key: 'ato',     width: 12 },
    { header: 'Detail / File', key: 'detail',  width: 38 },
    { header: 'Amount (AUD)',  key: 'amount',  width: 18 },
    { header: 'Notes',         key: 'notes',   width: 34 },
  ];
  applyHeader(ws3);

  const deductions = [
    { label: 'Work-related car expenses',          ato: 'D1',  key: 'deductionD1',  note: 'Logbook or cents-per-km method' },
    { label: 'Work-related travel expenses',       ato: 'D3',  key: 'deductionD3',  note: 'Airfare, accommodation if work-required' },
    { label: 'Uniforms, clothing & laundry',       ato: 'D4',  key: 'deductionD4',  note: 'Compulsory uniform only' },
    { label: 'Self-education expenses',            ato: 'D5',  key: 'deductionD5',  note: 'Directly related to current employment' },
    { label: 'Other work-related expenses',        ato: 'D6',  key: 'deductionD6',  note: 'Tools, phone, internet (work portion)' },
    { label: 'Gifts or donations',                 ato: 'D9',  key: 'deductionD9',  note: 'DGR-registered charities only' },
    { label: 'Cost of managing tax affairs',       ato: 'D10', key: 'deductionD10', note: 'Tax agent fees' },
  ];

  addSectionTitle(ws3, 'DEDUCTIONS', 5);

  let totalFormulaParts = [];
  deductions.forEach((d, i) => {
    const amount = u[d.key];
    const hasAmount = amount !== undefined && amount !== null && amount !== '' && Number(amount) > 0;
    const r = ws3.addRow([d.label, d.ato, '', hasAmount ? Number(amount) : '', d.note]);
    r.getCell(1).font = { bold: true, size: 10 };
    r.getCell(2).font = { color: { argb: 'FF555555' }, italic: true, size: 10 };
    r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hasAmount ? GREEN_BG : YELLOW } };
    r.getCell(4).numFmt = '$#,##0.00';
    r.getCell(5).font = { color: { argb: 'FF555555' }, italic: true, size: 9 };
    r.height = 18;
    totalFormulaParts.push(`D${r.number}`);
  });

  // Total row
  const totalDeductRow = ws3.addRow(['TOTAL DEDUCTIONS', '', '', { formula: totalFormulaParts.join('+') }, '']);
  totalDeductRow.font = { bold: true, size: 11 };
  totalDeductRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC107' } };
  totalDeductRow.getCell(4).numFmt = '$#,##0.00';

  // Deduction documents
  ws3.addRow([]);
  addSectionTitle(ws3, 'DEDUCTION DOCUMENTS UPLOADED', 5);

  DEDUCTION_CATS.forEach(catId => {
    const catDocs = allDocs.filter(d => d.category === catId);
    const catLabelRow = ws3.addRow([DEDUCTION_CAT_LABELS[catId]]);
    catLabelRow.font = { bold: true, size: 10, color: { argb: 'FF0A0E5C' } };
    catLabelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
    ws3.mergeCells(catLabelRow.number, 1, catLabelRow.number, 5);

    if (catDocs.length === 0) {
      const emptyRow = ws3.addRow(['', '', 'No documents uploaded for this category', '', '']);
      emptyRow.getCell(3).font = { italic: true, color: { argb: 'FF888888' }, size: 9 };
    } else {
      catDocs.forEach(d => {
        const r = ws3.addRow(['', '', d.originalName || d.storedFilename || '—', '', d.uploadedAt || d.createdAt || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
        r.getCell(3).font = { color: { argb: 'FF217346' }, size: 10 };
        r.height = 17;
      });
    }
  });

  // ── Send file ──────────────────────────────────────────────────────────────
  const safeName = (u.fullName || u.email || u.id).replace(/[^a-zA-Z0-9\- ]/g, '_').trim();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `RETAUX-Internal-${safeName}-${dateStr}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Export Excel individual por usuario ───────────────────────────────────────

router.get('/export/user/:id.xlsx', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const allDocs = db.get('documents').filter({ userId: u.id }).value();

  const INCOME_CATS = {
    payslips:             'Payslips',
    abn_income:           'ABN Income',
    investment_statements:'Investment Statements',
  };
  const DEDUCTION_CATS = {
    certifications: 'Certifications (RSA, White Card, etc.)',
    training:       'Training & Courses Paid',
    work_expenses:  'Uniforms, Workwear & Tools',
    tech_purchases: 'Technology for Work',
    home_office:    'Home Office / Working from Home',
    donation_receipts: 'Donations',
  };

  const NAVY       = 'FF0A0E5C';
  const WHITE      = 'FFFFFFFF';
  const YELLOW     = 'FFFFF2CC';
  const MISSING_RED= 'FFFFC7CE';
  const GREEN_BG   = 'FFE2EFDA';
  const BLUE_SEC   = 'FF1D4ED8';
  const LIGHT_BLUE = 'FFE8F0FE';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RETAUX';
  wb.created = new Date();

  const applyHeader = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: WHITE }, size: 11 };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 22;
  };

  const val = (v) => (v !== undefined && v !== null && String(v).trim() !== '') ? String(v).trim() : null;

  const addField = (ws, label, atoCode, value, note) => {
    const missing = !value;
    const row = ws.addRow([label, atoCode || '', value || '⚠ MISSING', note || '']);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(2).font = { color: { argb: 'FF555555' }, italic: true, size: 10 };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: missing ? MISSING_RED : YELLOW } };
    row.getCell(3).font = { size: 10, bold: missing };
    row.getCell(4).font = { color: { argb: 'FF555555' }, italic: true, size: 9 };
    row.height = 18;
    return row;
  };

  const addSectionTitle = (ws, title, cols) => {
    const row = ws.addRow([title]);
    row.font = { bold: true, color: { argb: WHITE }, size: 10 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE_SEC } };
    row.height = 20;
    if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
    return row;
  };

  const addCatHeader = (ws, label, cols) => {
    const row = ws.addRow([label]);
    row.font = { bold: true, size: 10, color: { argb: NAVY } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_BLUE } };
    row.height = 19;
    if (cols > 1) ws.mergeCells(row.number, 1, row.number, cols);
    return row;
  };

  // ── SHEET 1: Individual Info ──────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Individual Info');
  ws1.columns = [
    { header: 'Field',           width: 32 },
    { header: 'ATO Code',        width: 12 },
    { header: 'Response',        width: 40 },
    { header: 'Notes',           width: 40 },
  ];
  applyHeader(ws1);

  addSectionTitle(ws1, 'PERSONAL INFORMATION', 4);
  addField(ws1, 'Full Name',             null,  val(u.fullName),   'As per passport');
  addField(ws1, 'Date of Birth',         null,  val(u.birthDate),  'DD/MM/YYYY');
  addField(ws1, 'Tax File Number (TFN)', 'TFN', val(u.profile && u.profile.tfn ? u.profile.tfn : u.tfn), 'Confidential');
  addField(ws1, 'Nationality',           null,  val(u.nationality), null);
  addField(ws1, 'Visa Subclass',         null,  val(u.currentVisaSubclass), 'e.g. 417 Working Holiday');
  addField(ws1, 'Visa Start Date',       null,  val(u.visaStartDate), null);
  addField(ws1, 'Visa End Date',         null,  val(u.visaEndDate), null);
  addField(ws1, 'Tax Residency Status',  null,  val(u.taxResidencyStatus), 'Resident / Foreign Resident / WHM');
  addField(ws1, 'First Year as Resident',null,  val(u.firstYearResident), null);
  addField(ws1, 'Date Arrived in Australia', null, val(u.dateArrived), null);

  ws1.addRow([]);
  addSectionTitle(ws1, 'CURRENT ADDRESS', 4);
  addField(ws1, 'Address (Australia)', null, val(u.currentAddress), 'Full street address');

  ws1.addRow([]);
  addSectionTitle(ws1, 'IDENTITY DOCUMENT (PHOTO)', 4);
  const selfieDoc = allDocs.find(d => d.category === 'selfie_id');
  if (selfieDoc) {
    const r = ws1.addRow(['Passport / ID Photo', '', selfieDoc.originalName || selfieDoc.storedFilename || '—', selfieDoc.uploadedAt || selfieDoc.createdAt || '']);
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
    r.getCell(3).font = { color: { argb: 'FF217346' }, bold: true, size: 10 };
    r.height = 18;
  } else {
    const r = ws1.addRow(['Passport / ID Photo', '', '⚠ MISSING — Required', 'Client must upload via RETAUX portal']);
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MISSING_RED } };
    r.getCell(3).font = { bold: true, size: 10 };
    r.height = 18;
  }

  // ── SHEET 2: Income ───────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Income');
  ws2.columns = [
    { header: 'Field',          width: 34 },
    { header: 'ATO Code',       width: 12 },
    { header: 'Detail / File',  width: 38 },
    { header: 'Amount (AUD)',   width: 18 },
    { header: 'Notes',          width: 32 },
  ];
  applyHeader(ws2);

  const employers = u.employers || [];
  addSectionTitle(ws2, 'EMPLOYMENT INCOME', 5);

  if (employers.length > 0) {
    employers.forEach((emp, i) => {
      ws2.addRow([]);
      const hdr = ws2.addRow([`Employer ${i + 1}: ${emp.name || '—'}`]);
      hdr.font = { bold: true, size: 10 };
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_BLUE } };
      ws2.mergeCells(hdr.number, 1, hdr.number, 5);

      const empField = (label, ato, detail, amount, note) => {
        const missing = detail === null || detail === undefined || String(detail).trim() === '';
        const r = ws2.addRow([label, ato || '', missing ? '⚠ MISSING' : String(detail), amount != null ? Number(amount) : '', note || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: missing ? MISSING_RED : YELLOW } };
        r.getCell(4).numFmt = '$#,##0.00';
        r.height = 17;
      };

      empField('ABN',           'ABN', val(emp.abn),        null,            null);
      empField('Gross Income',  '1',   null,                emp.grossIncome, 'Total gross earnings');
      empField('Tax Withheld',  '2',   null,                emp.taxWithheld, 'PAYG withheld');
      empField('Period From',   null,  val(emp.periodFrom), null,            null);
      empField('Period To',     null,  val(emp.periodTo),   null,            null);
    });
  } else {
    ws2.addRow(['No employers recorded', '', '', '', '']);
  }

  ws2.addRow([]);
  addSectionTitle(ws2, 'OTHER INCOME', 5);
  const bankInterest = val(u.bankInterest);
  const biR = ws2.addRow(['Bank Interest', '10', '', bankInterest ? Number(bankInterest) : '', 'From annual bank statement']);
  biR.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  biR.getCell(4).numFmt = '$#,##0.00';

  const otherIncome = val(u.otherIncome);
  const oiR = ws2.addRow(['Other Income', null, '', otherIncome ? Number(otherIncome) : '', null]);
  oiR.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  oiR.getCell(4).numFmt = '$#,##0.00';

  ws2.addRow([]);
  addSectionTitle(ws2, 'INCOME DOCUMENTS UPLOADED', 5);

  Object.entries(INCOME_CATS).forEach(([catId, catLabel]) => {
    addCatHeader(ws2, catLabel, 5);
    const catDocs = allDocs.filter(d => d.category === catId);
    if (catDocs.length === 0) {
      const r = ws2.addRow(['', '', 'No documents uploaded', '', '']);
      r.getCell(3).font = { italic: true, color: { argb: 'FF888888' }, size: 9 };
    } else {
      catDocs.forEach(d => {
        const r = ws2.addRow(['', '', d.originalName || d.storedFilename || '—', '', d.uploadedAt || d.createdAt || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
        r.getCell(3).font = { color: { argb: 'FF217346' }, size: 10 };
        r.height = 17;
      });
    }
  });

  // ── SHEET 3: Deductions ───────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Deductions');
  ws3.columns = [
    { header: 'Deduction',      width: 38 },
    { header: 'ATO Code',       width: 12 },
    { header: 'Detail / File',  width: 38 },
    { header: 'Amount (AUD)',   width: 18 },
    { header: 'Notes',          width: 34 },
  ];
  applyHeader(ws3);

  const deductions = [
    { label: 'Work-related car expenses',      ato: 'D1',  key: 'deductionD1',  note: 'Logbook or cents-per-km method' },
    { label: 'Work-related travel expenses',   ato: 'D3',  key: 'deductionD3',  note: 'Airfare, accommodation if work-required' },
    { label: 'Uniforms, clothing & laundry',   ato: 'D4',  key: 'deductionD4',  note: 'Compulsory uniform only' },
    { label: 'Self-education expenses',        ato: 'D5',  key: 'deductionD5',  note: 'Directly related to current employment' },
    { label: 'Other work-related expenses',    ato: 'D6',  key: 'deductionD6',  note: 'Tools, phone, internet (work portion)' },
    { label: 'Gifts or donations',             ato: 'D9',  key: 'deductionD9',  note: 'DGR-registered charities only' },
    { label: 'Cost of managing tax affairs',   ato: 'D10', key: 'deductionD10', note: 'Tax agent fees' },
  ];

  addSectionTitle(ws3, 'DEDUCTIONS', 5);
  const deductRowNums = [];

  deductions.forEach(d => {
    const amount = u[d.key];
    const has = amount !== undefined && amount !== null && amount !== '' && Number(amount) > 0;
    const r = ws3.addRow([d.label, d.ato, '', has ? Number(amount) : '', d.note]);
    r.getCell(1).font = { bold: true, size: 10 };
    r.getCell(2).font = { color: { argb: 'FF555555' }, italic: true, size: 10 };
    r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: has ? GREEN_BG : YELLOW } };
    r.getCell(4).numFmt = '$#,##0.00';
    r.getCell(5).font = { color: { argb: 'FF555555' }, italic: true, size: 9 };
    r.height = 18;
    deductRowNums.push(r.number);
  });

  const totalR = ws3.addRow(['TOTAL DEDUCTIONS', '', '', { formula: deductRowNums.map(n => `D${n}`).join('+') }, '']);
  totalR.font = { bold: true, size: 11 };
  totalR.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC107' } };
  totalR.getCell(4).numFmt = '$#,##0.00';

  ws3.addRow([]);
  addSectionTitle(ws3, 'DEDUCTION DOCUMENTS UPLOADED', 5);

  Object.entries(DEDUCTION_CATS).forEach(([catId, catLabel]) => {
    addCatHeader(ws3, catLabel, 5);
    const catDocs = allDocs.filter(d => d.category === catId);
    if (catDocs.length === 0) {
      const r = ws3.addRow(['', '', 'No documents uploaded', '', '']);
      r.getCell(3).font = { italic: true, color: { argb: 'FF888888' }, size: 9 };
    } else {
      catDocs.forEach(d => {
        const r = ws3.addRow(['', '', d.originalName || d.storedFilename || '—', '', d.uploadedAt || d.createdAt || '']);
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_BG } };
        r.getCell(3).font = { color: { argb: 'FF217346' }, size: 10 };
        r.height = 17;
      });
    }
  });

  // ── Send ──────────────────────────────────────────────────────────────────
  const safeName = (u.fullName || u.email || u.id).replace(/[^a-zA-Z0-9\- ]/g, '_').trim();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `RETAUX-TaxAgent-${safeName}-${dateStr}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── WhatsApp chats ───────────────────────────────────────────────────────────

router.get('/admin/chats', requireAdmin, (req, res) => {
  const convs = db.get('waConversations').value() || [];
  // Ordenar por más reciente
  const sorted = [...convs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.render('admin/chats', { convs: sorted, selected: null, messages: [] });
});

router.get('/admin/chats/:phone', requireAdmin, (req, res) => {
  const phone = req.params.phone;
  const convs = db.get('waConversations').value() || [];
  const sorted = [...convs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const conv = db.get('waConversations').find({ phone }).value();
  res.render('admin/chats', {
    convs: sorted,
    selected: conv || null,
    messages: conv ? (conv.messages || []) : [],
  });
});

router.post('/admin/chats/:phone/send', requireAdmin, async (req, res) => {
  const phone = req.params.phone;
  const text = (req.body.message || '').trim();
  if (!text) return res.redirect(`/admin/chats/${phone}`);

  const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
  const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;

  const https = require('https');
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  });

  await new Promise((resolve) => {
    const reqWA = https.request({
      hostname: 'graph.facebook.com',
      path: `/v19.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res2 => {
      res2.on('data', () => {});
      res2.on('end', resolve);
    });
    reqWA.on('error', resolve);
    reqWA.write(body);
    reqWA.end();
  });

  // Guardar en conversación
  const conv = db.get('waConversations').find({ phone });
  if (conv.value()) {
    const msgs = conv.value().messages || [];
    msgs.push({ role: 'assistant', content: `[Admin] ${text}`, ts: new Date().toISOString() });
    conv.assign({ messages: msgs, updatedAt: new Date().toISOString(), lastAdminMessageAt: Date.now() }).write();
  }

  res.redirect(`/admin/chats/${phone}`);
});

// ── Recordatorio por email ────────────────────────────────────────────────────
router.post('/user/:id/remind', requireAdmin, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin?remindError=1');

  const lang = u.lang || 'en';
  const name = (u.fullName || u.email).split(' ')[0];

  // Detectar en qué paso está
  const hasDocs = db.get('documents').filter({ userId: u.id }).size().value() > 0;
  const step = hasDocs ? 'payment' : 'documents';

  const copy = {
    es: {
      subject: `${name}, tu tax return australiano te está esperando 🇦🇺`,
      docTitle: 'RECORDATORIO DE TRÁMITE',
      docSub: `Preparado para ${u.fullName || u.email}`,
      greeting: `Hola ${name},`,
      highlight: step === 'payment'
        ? 'Ya cargaste tus documentos — solo falta confirmar el pago para que empecemos a procesar tu declaración.'
        : 'Empezaste tu trámite pero todavía no subiste tus documentos. Cuanto antes los cargues, más rápido recuperás tu plata.',
      body: step === 'payment'
        ? 'El equipo de RETAUX está listo para presentar tu tax return ante el ATO. Solo necesitamos que confirmes el pago de <span class="money">AUD 150</span> para arrancar.'
        : 'Para poder preparar tu declaración impositiva necesitamos que subas tus documentos: payment summary, recibos de trabajo y cualquier comprobante de deducciones.',
      cta: 'Continuar mi trámite →',
      ctaUrl: 'https://retaux.com/login',
      retaTitle: '¿Tenés dudas? Hablá con Reta',
      retaBody: 'Reta, nuestra asistente virtual, está disponible las 24hs para responder cualquier pregunta sobre tu declaración, documentos o el proceso.',
      retaCta: '💬 Escribirle a Reta',
      retaUrl: 'https://wa.me/61481315878',
      closing: 'Saludos cordiales,',
    },
    en: {
      subject: `${name}, your Australian tax return is waiting 🇦🇺`,
      docTitle: 'REMINDER — YOUR TAX RETURN',
      docSub: `Prepared for ${u.fullName || u.email}`,
      greeting: `Hi ${name},`,
      highlight: step === 'payment'
        ? 'Your documents are uploaded — just confirm your payment and we\'ll start processing your tax return right away.'
        : 'You started your application but haven\'t uploaded your documents yet. The sooner you do, the sooner you get your money back.',
      body: step === 'payment'
        ? 'The RETAUX team is ready to lodge your tax return with the ATO. We just need you to confirm your payment of <span class="money">AUD 150</span> to get started.'
        : 'To prepare your tax return we need your documents: payment summary, payslips and any receipts for work-related expenses.',
      cta: 'Continue my application →',
      ctaUrl: 'https://retaux.com/login',
      retaTitle: 'Got questions? Talk to Reta',
      retaBody: 'Reta, our virtual assistant, is available 24/7 to answer any questions about your return, documents or the process.',
      retaCta: '💬 Message Reta',
      retaUrl: 'https://wa.me/61481315878',
      closing: 'Kind regards,',
    },
    fr: {
      subject: `${name}, votre déclaration fiscale australienne vous attend 🇦🇺`,
      docTitle: 'RAPPEL — VOTRE DOSSIER',
      docSub: `Préparé pour ${u.fullName || u.email}`,
      greeting: `Bonjour ${name},`,
      highlight: step === 'payment'
        ? 'Vos documents sont chargés — il vous suffit de confirmer le paiement pour que nous commencions à traiter votre déclaration.'
        : 'Vous avez commencé votre dossier mais n\'avez pas encore envoyé vos documents. Plus tôt vous les chargez, plus vite vous récupérez votre argent.',
      body: step === 'payment'
        ? 'L\'équipe RETAUX est prête à soumettre votre déclaration à l\'ATO. Il nous faut simplement votre confirmation de paiement de <span class="money">AUD 150</span>.'
        : 'Pour préparer votre déclaration, nous avons besoin de vos documents : résumé de paiement, fiches de paie et reçus de dépenses liées au travail.',
      cta: 'Continuer mon dossier →',
      ctaUrl: 'https://retaux.com/login',
      retaTitle: 'Des questions ? Parlez à Reta',
      retaBody: 'Reta, notre assistante virtuelle, est disponible 24h/24 pour répondre à vos questions sur votre déclaration, vos documents ou le processus.',
      retaCta: '💬 Écrire à Reta',
      retaUrl: 'https://wa.me/61481315878',
      closing: 'Cordialement,',
    },
    it: {
      subject: `${name}, la tua dichiarazione fiscale australiana ti aspetta 🇦🇺`,
      docTitle: 'PROMEMORIA — LA TUA PRATICA',
      docSub: `Preparato per ${u.fullName || u.email}`,
      greeting: `Ciao ${name},`,
      highlight: step === 'payment'
        ? 'I tuoi documenti sono stati caricati — conferma solo il pagamento e inizieremo subito a elaborare la tua dichiarazione.'
        : 'Hai iniziato la tua pratica ma non hai ancora caricato i documenti. Prima li carichi, prima recuperi i tuoi soldi.',
      body: step === 'payment'
        ? 'Il team RETAUX è pronto per presentare la tua dichiarazione all\'ATO. Abbiamo solo bisogno che tu confermi il pagamento di <span class="money">AUD 150</span>.'
        : 'Per preparare la tua dichiarazione abbiamo bisogno dei tuoi documenti: riepilogo pagamenti, buste paga e ricevute per spese lavorative.',
      cta: 'Continua la mia pratica →',
      ctaUrl: 'https://retaux.com/login',
      retaTitle: 'Hai domande? Parla con Reta',
      retaBody: 'Reta, la nostra assistente virtuale, è disponibile 24 ore su 24 per rispondere a qualsiasi domanda sulla tua dichiarazione, i tuoi documenti o il processo.',
      retaCta: '💬 Scrivi a Reta',
      retaUrl: 'https://wa.me/61481315878',
      closing: 'Cordiali saluti,',
    },
  };

  const t = copy[lang] || copy.en;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>RETAUX — ${t.docTitle}</title>
<style>
  body{margin:0;padding:0;background-color:#eef2f6;font-family:'Helvetica Neue',Arial,sans-serif;color:#2b3440;}
  .wrapper{max-width:660px;margin:0 auto;background:#ffffff;}
  .header{background-color:#060C14;padding:46px 32px 38px;text-align:center;border-bottom:4px solid #F0C040;}
  .logo{font-family:'Rubik Mono One','Helvetica Neue',Arial,sans-serif;font-size:30px;letter-spacing:1px;}
  .logo .re{color:#38BDF8;}.logo .taux{color:#F0C040;}
  .doc-title{color:#fff;font-size:13px;letter-spacing:3px;text-transform:uppercase;margin-top:14px;opacity:.85;}
  .doc-sub{color:#fff;opacity:.55;font-size:12px;margin-top:6px;}
  .content{padding:40px 36px;}
  .greeting{font-size:1.05rem;font-weight:700;margin-bottom:16px;color:#060C14;}
  .highlight-box{background:#e0f4ff;border-left:4px solid #38BDF8;padding:16px 20px;border-radius:6px;margin:20px 0;font-size:0.97rem;line-height:1.6;}
  .body-text{font-size:0.95rem;line-height:1.7;color:#2b3440;margin:16px 0;}
  .money{background:#F0C040;color:#060C14;font-weight:700;padding:3px 12px;border-radius:20px;display:inline-block;}
  .cta{text-align:center;margin:32px 0 24px;}
  .cta a{background-color:#38BDF8;color:#060C14;text-decoration:none;font-weight:700;padding:15px 34px;border-radius:30px;display:inline-block;font-size:0.97rem;}
  .reta-box{background:#f0fdf4;border-left:4px solid #25D366;padding:20px 24px;border-radius:6px;margin:28px 0;}
  .reta-box h3{margin:0 0 8px;font-size:1rem;color:#060C14;}
  .reta-box p{margin:0 0 16px;font-size:0.9rem;color:#2b3440;line-height:1.6;}
  .cta-wa{text-align:center;}
  .cta-wa a{background-color:#25D366;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:30px;display:inline-flex;align-items:center;gap:8px;font-size:0.93rem;}
  .signature{margin-top:36px;font-size:0.9rem;color:#2b3440;line-height:1.8;border-top:1px solid #e5e7eb;padding-top:24px;}
  .footer{background-color:#060C14;color:rgba(255,255,255,0.65);text-align:center;font-size:11.5px;padding:24px 32px;}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="logo"><span class="re">RE</span><span class="taux">TAUX</span></div>
    <div class="doc-title">${t.docTitle}</div>
    <div class="doc-sub">${t.docSub}</div>
  </div>
  <div class="content">
    <p class="greeting">${t.greeting}</p>
    <div class="highlight-box">${t.highlight}</div>
    <p class="body-text">${t.body}</p>
    <div class="cta">
      <a href="${t.ctaUrl}">${t.cta}</a>
    </div>
    <div class="reta-box">
      <h3>${t.retaTitle}</h3>
      <p>${t.retaBody}</p>
      <div class="cta-wa">
        <a href="${t.retaUrl}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          ${t.retaCta}
        </a>
      </div>
    </div>
    <div class="signature">
      ${t.closing}<br>
      <strong>Bruno Quagliarella &amp; Manuel Pons</strong><br>
      Co-Fundadores, RETAUX
    </div>
  </div>
  <div class="footer">RETAUX · www.retaux.com · hola@retaux.com</div>
</div>
</body>
</html>`;

  await sendMail({
    to: u.email,
    subject: t.subject,
    html,
    text: `${t.greeting}\n\n${t.highlight}\n\n${t.body}\n\n${t.ctaUrl}\n\n${t.closing}\nBruno Quagliarella & Manuel Pons\nCo-Fundadores, RETAUX`,
  });

  // Guardar fecha y contador de recordatorios en la DB
  const remindCount = (u.remindCount || 0) + 1;
  db.get('users').find({ id: u.id }).assign({
    lastRemindAt: new Date().toISOString(),
    remindCount,
  }).write();

  console.log(`[REMIND] Recordatorio #${remindCount} enviado a ${u.email} (lang: ${lang}, step: ${step})`);
  res.redirect(`/admin?reminded=${u.id}`);
});

// ── Tax Estimate — cargar desde admin ────────────────────────────────────────
router.post('/user/:id/tax-estimate', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const num = v => (v !== undefined && v !== '' && !isNaN(parseFloat(v))) ? parseFloat(v) : null;

  const estimate = {
    taxableIncome:             num(req.body.taxableIncome),
    taxPayableOnTaxableIncome: num(req.body.taxPayableOnTaxableIncome),
    lowIncomeOffset:           num(req.body.lowIncomeOffset),
    taxWithheldSalary:         num(req.body.taxWithheldSalary),
    estimatedRefund:           num(req.body.estimatedRefund),
    loadedAt:                  new Date().toISOString(),
    status:                    'pending',
    acceptedAt:                null,
    clientComment:             null,
  };

  db.get('users').find({ id: u.id }).assign({ taxEstimate: estimate }).write();

  res.redirect(`/admin/user/${u.id}?saved=1#estimate`);
});

// ── Notificar al cliente sobre su tax estimate (acción manual separada del guardado) ──
router.post('/user/:id/notify-estimate', requireAdmin, async (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');
  if (!u.taxEstimate) return res.redirect(`/admin/user/${u.id}?error=no_estimate#estimate`);

  const toRaw = (req.body.notifyTo || '').trim();
  if (!toRaw) return res.redirect(`/admin/user/${u.id}?error=no_recipient#estimate`);

  const { sendMail } = require('../lib/mailer');
  const { genMagicToken } = require('../routes/auth');
  const estimate = u.taxEstimate;
  const firstName = (u.fullName || u.email).split(' ')[0];
  const fmt = v => (v !== null && v !== undefined) ? `$${Number(v).toFixed(2)}` : '—';
  const BASE = process.env.BASE_URL || 'https://retaux.com';
  const magicToken = genMagicToken(u.id, '/dashboard');
  const dashboardUrl = `${BASE}/magic?t=${magicToken}`;

  const notifyHtml = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:30px 0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1a2430;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr>
      <td style="padding:24px 32px;">
        <span style="font-size:24px;font-weight:900;"><span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span></span>
      </td>
      <td align="right" style="padding:24px 32px;color:#8fa3b8;font-size:13px;">Tax Estimate Ready</td>
    </tr>
  </table>
  <div style="padding:32px;">
    <div style="background:#e0f4ff;border-left:4px solid #38BDF8;padding:16px 20px;border-radius:6px;margin-bottom:24px;font-size:14px;line-height:1.6;">
      Hola <strong>${firstName}</strong>, tu agente impositivo preparó la estimación de tu devolución de impuestos. Por favor revisala y confirmala desde tu dashboard.
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;margin-bottom:24px;font-size:14px;">
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;width:60%;border-bottom:1px solid #E5E7EB;">Taxable Income</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(estimate.taxableIncome)}</td></tr>
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Tax Payable on Taxable Income</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(estimate.taxPayableOnTaxableIncome)}</td></tr>
      ${estimate.lowIncomeOffset ? `<tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Low Income Offset</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(estimate.lowIncomeOffset)}</td></tr>` : ''}
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Tax Withheld (salary)</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(estimate.taxWithheldSalary)}</td></tr>
      <tr style="background:#ECFDF5;"><td style="padding:12px 14px;font-weight:800;color:#065F46;font-size:1rem;">Estimated Tax Refund</td><td style="padding:12px 14px;font-family:monospace;font-weight:800;font-size:1rem;color:#065F46;">${fmt(estimate.estimatedRefund)}</td></tr>
    </table>
    <div style="text-align:center;margin:28px 0;">
      <a href="${dashboardUrl}" style="background:#38BDF8;color:#060C14;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:30px;display:inline-block;font-size:15px;">Revisar y confirmar →</a>
    </div>
    <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:0 0 8px;">Este botón te lleva directo a tu cuenta — sin necesidad de contraseña. Válido 48 horas.</p>
    <p style="font-size:13px;color:#6B7280;text-align:center;margin:0;">Si tenés dudas podés escribirnos a <a href="mailto:hola@retaux.com" style="color:#38BDF8;">hola@retaux.com</a></p>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr><td style="padding:18px 32px;text-align:center;color:#8fa3b8;font-size:12px;">
      RETAUX · hola@retaux.com · www.retaux.com
    </td></tr>
  </table>
</div>
</body></html>`;

  try {
    await sendMail({
      to: toRaw,
      cc: 'hola@retaux.com',
      subject: `Tu estimación de tax return está lista — RETAUX`,
      html: notifyHtml,
      text: `Hola ${firstName},\n\nTu estimación está lista:\n\nTaxable Income: ${fmt(estimate.taxableIncome)}\nTax Payable: ${fmt(estimate.taxPayableOnTaxableIncome)}\nEstimated Tax Refund: ${fmt(estimate.estimatedRefund)}\n\nHacé click para confirmar (sin contraseña, válido 48h):\n${dashboardUrl}\n\nRETAUX · hola@retaux.com`,
    });
    db.get('users').find({ id: u.id }).assign({
      estimateNotifiedAt: new Date().toISOString(),
      estimateNotifiedTo: toRaw,
    }).write();
    res.redirect(`/admin/user/${u.id}?notified=1#estimate`);
  } catch(e) {
    console.error('[NOTIFY-ESTIMATE]', e.message);
    res.redirect(`/admin/user/${u.id}?error=send_failed#estimate`);
  }
});

// ── Editar múltiples vehículos desde user-detail ──────────────────────────────
router.post('/user/:id/update-vehicles', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const count = parseInt(req.body.vehicleCount) || 0;
  const vehicles = [];
  for (let i = 0; i < Math.max(count, 10); i++) {
    const brand = (req.body[`v_brand_${i}`] || '').trim();
    const model = (req.body[`v_model_${i}`] || '').trim();
    const year  = (req.body[`v_year_${i}`]  || '').trim();
    const plate = (req.body[`v_plate_${i}`] || '').trim().toUpperCase();
    const km    = parseFloat(req.body[`v_km_${i}`]) || 0;
    if (brand || model || plate || km) {
      vehicles.push({ brand, model, year, plate, km });
    }
  }

  // Usar el perfil específico que se está mostrando (enviado como fyProfileId)
  const fyProfileId = req.body.fyProfileId;
  const fyProfiles = db.get('taxYearProfiles').filter({ userId: u.id }).value()
    .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
  const target = (fyProfileId && db.get('taxYearProfiles').find({ id: fyProfileId, userId: u.id }).value())
    || fyProfiles[0];
  if (target) {
    const patch = {
      vehicles,
      hasCar: vehicles.length > 0,
      // Mantener campos planos con el primer vehículo para compatibilidad
      carBrand:   vehicles[0] ? vehicles[0].brand : '',
      carModel:   vehicles[0] ? vehicles[0].model : '',
      carYear:    vehicles[0] ? vehicles[0].year  : '',
      carPlate:   vehicles[0] ? vehicles[0].plate : '',
      carWorkKm:  vehicles[0] ? vehicles[0].km    : 0,
    };
    db.get('taxYearProfiles').find({ id: target.id }).assign(patch).write();
  }

  if (req.headers['x-requested-with'] === 'fetch') return res.json({ ok: true });
  res.redirect(`/admin/user/${u.id}?saved=1#fiscal`);
});

router.post('/user/:id/update-health', requireAdmin, (req, res) => {
  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.redirect('/admin');

  const hasHealth = req.body.hasHealthInsurance === '1';
  const patch = {
    hasHealthInsurance: hasHealth,
    healthProvider:     (req.body.healthProvider     || '').trim(),
    healthMemberNumber: (req.body.healthMemberNumber || '').trim(),
    healthPlanType:     (req.body.healthPlanType     || '').trim(),
    healthStartDate:    (req.body.healthStartDate     || '').trim(),
    healthEndDate:      (req.body.healthEndDate       || '').trim(),
  };

  const fyProfileIdH = req.body.fyProfileId;
  const fyProfilesH = db.get('taxYearProfiles').filter({ userId: u.id }).value()
    .slice().sort((a, b) => (b.taxYear || '').localeCompare(a.taxYear || ''));
  const target = (fyProfileIdH && db.get('taxYearProfiles').find({ id: fyProfileIdH, userId: u.id }).value())
    || fyProfilesH[0];
  if (target) {
    db.get('taxYearProfiles').find({ id: target.id }).assign(patch).write();
  }

  if (req.headers['x-requested-with'] === 'fetch') return res.json({ ok: true });
  res.redirect(`/admin/user/${u.id}?saved=1#fiscal`);
});

// ── Recordatorio masivo: estimaciones pendientes de aceptación ────────────────

router.post('/tax-estimate/remind-all', requireAdmin, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const BASE = process.env.BASE_URL || 'https://retaux.com';

  const pending = db.get('users')
    .filter(u => u.taxEstimate && u.taxEstimate.status === 'pending')
    .value();

  let sent = 0;
  for (const u of pending) {
    const firstName = (u.fullName || u.email).split(' ')[0];
    const est = u.taxEstimate;
    const fmt = v => (v !== null && v !== undefined) ? `$${Number(v).toFixed(2)}` : '—';
    const { genMagicToken } = require('../routes/auth');
    const magicTok = genMagicToken(u.id, '/dashboard');
    const dashUrl = `${BASE}/magic?t=${magicTok}`;

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:30px 0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1a2430;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr>
      <td style="padding:24px 32px;"><span style="font-size:24px;font-weight:900;"><span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span></span></td>
      <td align="right" style="padding:24px 32px;color:#8fa3b8;font-size:13px;">Recordatorio — Tax Estimate</td>
    </tr>
  </table>
  <div style="padding:32px;">
    <div style="background:#FFF8E1;border-left:4px solid #F0C040;padding:16px 20px;border-radius:6px;margin-bottom:24px;font-size:14px;line-height:1.6;color:#78350F;">
      Hola <strong>${firstName}</strong>, necesitamos tu confirmación para continuar con la presentación de tu tax return ante el ATO. Tu estimación está lista y esperando tu respuesta.
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;margin-bottom:24px;font-size:14px;">
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;width:60%;border-bottom:1px solid #E5E7EB;">Taxable Income</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxableIncome)}</td></tr>
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Tax Payable on Taxable Income</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxPayableOnTaxableIncome)}</td></tr>
      ${est.lowIncomeOffset ? `<tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Low Income Offset</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.lowIncomeOffset)}</td></tr>` : ''}
      <tr><td style="padding:10px 14px;background:#F9FAFB;font-weight:600;border-bottom:1px solid #E5E7EB;">Less — Tax Withheld (salary)</td><td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;font-family:monospace;">${fmt(est.taxWithheldSalary)}</td></tr>
      <tr style="background:#ECFDF5;"><td style="padding:12px 14px;font-weight:800;color:#065F46;font-size:1rem;">Estimated Tax Refund</td><td style="padding:12px 14px;font-family:monospace;font-weight:800;font-size:1rem;color:#065F46;">${fmt(est.estimatedRefund)}</td></tr>
    </table>
    <div style="text-align:center;margin:28px 0;">
      <a href="${dashUrl}" style="background:#38BDF8;color:#060C14;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:30px;display:inline-block;font-size:15px;">Revisar y confirmar →</a>
    </div>
    <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:0 0 8px;">Acceso directo sin contraseña — válido 48 horas.</p>
    <p style="font-size:13px;color:#6B7280;text-align:center;margin:0;">¿Tenés dudas? Respondé este email o escribinos a <a href="mailto:hola@retaux.com" style="color:#38BDF8;">hola@retaux.com</a></p>
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr><td style="padding:18px 32px;text-align:center;color:#8fa3b8;font-size:12px;">RETAUX · hola@retaux.com · www.retaux.com</td></tr>
  </table>
</div></body></html>`;

    try {
      await sendMail({
        to: u.email,
        subject: `⏳ Necesitamos tu confirmación para continuar — RETAUX`,
        html,
        text: `Hola ${firstName},\n\nNecesitamos tu confirmación para presentar tu tax return.\nEstimated Tax Refund: ${fmt(est.estimatedRefund)}\n\nHacé click para confirmar (sin contraseña, válido 48h):\n${dashUrl}\n\nRETAUX · hola@retaux.com`,
      });
      sent++;
    } catch (e) {
      console.error(`[REMIND ESTIMATE] Error enviando a ${u.email}:`, e.message);
    }
  }

  res.redirect(`/admin?reminded=${sent}`);
});

// ── Enviar informe DASP al agente ─────────────────────────────────────────────
router.post('/user/:id/send-dasp-agent', requireAdmin, async (req, res) => {
  const { sendMail } = require('../lib/mailer');
  const { UPLOAD_ROOT } = require('../middleware/upload');

  const u = db.get('users').find({ id: req.params.id }).value();
  if (!u) return res.status(404).send('User not found');

  const daspReq = db.get('daspRequests').find({ userId: u.id }).value();
  if (!daspReq) return res.redirect(`/admin/user/${u.id}/dasp-preview?error=no_dasp`);

  const sendToRaw = (req.body.sendTo || '').trim();
  if (!sendToRaw) return res.redirect(`/admin/user/${u.id}/dasp-preview?error=no_recipient`);

  const tfn = (u.profile && u.profile.tfn) ? u.profile.tfn : (u.tfn || null);
  const clientName = daspReq.fullName || u.fullName || u.email;
  const dateStr = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  const S = '#0A0E5C';
  const Y = '#FFC107';
  const R = '#DC2626';

  const dataRow = (label, value) => {
    const missing = !value;
    return `<tr>
      <td style="padding:7px 14px;font-weight:600;color:#374151;width:42%;border-bottom:1px solid #F0F4F8;font-size:0.88rem;">${label}</td>
      <td style="padding:7px 14px;border-bottom:1px solid #F0F4F8;font-size:0.88rem;${missing ? `color:${R};font-weight:600;` : 'color:#111827;'}">${missing ? '⚠ Missing' : value}</td>
    </tr>`;
  };

  const secHead = (title) =>
    `<tr><td colspan="2" style="padding:9px 14px;background:${S};color:#fff;font-weight:700;font-size:0.82rem;letter-spacing:0.06em;text-transform:uppercase;">${title}</td></tr>`;

  const fmtDate = (v) => {
    if (!v) return null;
    const p = v.split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : v;
  };

  // Fondos de super
  let fundsHTML = '';
  if (daspReq.funds && daspReq.funds.length) {
    daspReq.funds.forEach((f, i) => {
      fundsHTML += `<tr><td colspan="2" style="padding:7px 14px;background:#FFFBEB;border-bottom:1px solid #FDE68A;font-weight:700;font-size:0.82rem;color:#92400E;">Fund ${String(i+1).padStart(2,'0')}${f.fundName ? ' — ' + f.fundName : ''}</td></tr>`;
      fundsHTML += dataRow('Fund Name', f.fundName || null);
      fundsHTML += dataRow('ABN', f.fundABN || null);
      fundsHTML += dataRow('USI', f.fundUSI || '(not provided)');
      fundsHTML += dataRow('Member Number', f.memberNumber || null);
    });
  } else {
    fundsHTML = `<tr><td colspan="2" style="padding:8px 14px;color:${R};font-weight:600;">⚠ No super fund details provided</td></tr>`;
  }

  // Tickets de avión
  let ticketsHTML = '';
  if (daspReq.flightTickets && daspReq.flightTickets.length) {
    daspReq.flightTickets.forEach(t => {
      ticketsHTML += `<tr><td colspan="2" style="padding:6px 14px;border-bottom:1px solid #F0F4F8;font-size:0.85rem;">🎫 ${t.originalName}</td></tr>`;
    });
  } else {
    ticketsHTML = `<tr><td colspan="2" style="padding:8px 14px;color:${R};font-weight:600;">⚠ No flight tickets uploaded</td></tr>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #E5E7EB;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

  <div style="background:${S};padding:24px 28px;">
    <div style="font-size:1.25rem;font-weight:700;color:#fff;margin-bottom:6px;">DASP — Departing Australia Superannuation Payment</div>
    <div style="font-size:0.85rem;color:rgba(255,255,255,0.65);">Client file prepared for lodgement · ${dateStr}</div>
  </div>

  <div style="padding:16px 28px;background:#FFFBEB;border-bottom:1px solid #FDE68A;">
    <p style="margin:0;font-size:0.92rem;color:#78350F;">
      Please find below the DASP claim information for <strong>${clientName}</strong>.
      Lodge via the <strong>ATO DASP Online Intermediary System</strong> (ato.gov.au → Tax professionals → DASP Online System).
      ${daspReq.flightTickets && daspReq.flightTickets.length ? 'Flight tickets are attached.' : '<strong style="color:' + R + '">⚠ No flight tickets attached — request from client before lodging.</strong>'}
    </p>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">

    ${secHead('1. Personal Information')}
    ${dataRow('Full Name',             daspReq.fullName || u.fullName || null)}
    ${dataRow('Date of Birth',         fmtDate(daspReq.dateOfBirth))}
    ${dataRow('Phone',                 daspReq.phone || u.phone || null)}
    ${dataRow('Email',                 u.email || null)}
    ${dataRow('Tax File Number (TFN)', tfn)}
    ${dataRow('Passport Number',       daspReq.passportNumber || null)}
    ${dataRow('Passport Country',      daspReq.passportCountry || u.nationality || null)}
    ${dataRow('Last Australian Address', daspReq.lastAustralianAddress || u.currentAddress || null)}

    ${secHead('2. Visa & Departure')}
    ${dataRow('Visa Subclass',              daspReq.visaSubclass || u.currentVisaSubclass || null)}
    ${dataRow('Visa Expiry / Ceased Date',  fmtDate(daspReq.visaExpiryDate || u.visaEndDate) || null)}
    ${dataRow('Departure Date from Australia', daspReq.departureDate ? `<strong style="font-size:1rem;">${fmtDate(daspReq.departureDate)}</strong>` : null)}

    ${secHead('3. Flight Tickets / Boarding Passes')}
    ${ticketsHTML}

    ${secHead('4. Superannuation Funds')}
    ${fundsHTML}

    ${secHead('5. Overseas Bank Account — Payment Destination')}
    ${dataRow('Account Holder',        daspReq.bankRecipientName || u.fullName || null)}
    ${dataRow('Bank Name',             daspReq.bankName || null)}
    ${dataRow('Country',               daspReq.bankCountry || null)}
    ${dataRow('SWIFT / BIC Code',      daspReq.bankSwift || null)}
    ${dataRow('Account Number / CBU / IBAN', daspReq.bankAccount || null)}

    ${daspReq.notes ? `
    ${secHead('6. Client Notes')}
    <tr><td colspan="2" style="padding:10px 14px;font-size:0.88rem;color:#374151;white-space:pre-wrap;">${daspReq.notes}</td></tr>
    ` : ''}

  </table>

  <div style="padding:14px 28px;background:#F9FAFB;border-top:1px solid #E5E7EB;font-size:0.78rem;color:#9CA3AF;">
    This DASP claim file was prepared by RETAUX (www.retaux.com) on behalf of the client and is intended solely for the named tax agent.
    For queries contact hola@retaux.com
  </div>
</div>
</body></html>`;

  // Adjuntar tickets de avión
  const attachments = [];
  if (daspReq.flightTickets && daspReq.flightTickets.length) {
    for (const t of daspReq.flightTickets) {
      const ticketPath = path.join(UPLOAD_ROOT, u.id, 'dasp', t.storedFilename);
      if (fs.existsSync(ticketPath)) {
        attachments.push({
          name:    t.originalName,
          content: fs.readFileSync(ticketPath).toString('base64'),
        });
      }
    }
  }

  const ccFixed  = (req.body.sendCcFixed || '').trim();
  const ccExtra  = (req.body.sendCc || '').trim();
  const ccFinal  = [ccFixed, ccExtra].filter(Boolean).join(', ') || undefined;
  const subject  = (req.body.sendSubject || '').trim() || `DASP Claim — ${clientName}`;

  try {
    await sendMail({
      to:          sendToRaw,
      cc:          ccFinal,
      subject,
      html,
      attachments,
    });

    db.get('daspRequests').find({ id: daspReq.id }).assign({
      agentSentAt:    new Date().toISOString(),
      agentSentTo:    sendToRaw,
      agentReportHtml: html,
      status:         'processing',
    }).write();

    res.redirect(`/admin/user/${u.id}/dasp-preview?sent=1`);
  } catch (e) {
    console.error('[DASP AGENT EMAIL] Error:', e.message);
    res.redirect(`/admin/user/${u.id}/dasp-preview?error=mail_failed`);
  }
});

module.exports = router;
module.exports.buildEnpresaFormHtml = buildEnpresaFormHtml;
