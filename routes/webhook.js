const express  = require('express');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const db       = require('../db/database');
const router   = express.Router();

const VERIFY_TOKEN  = process.env.WA_VERIFY_TOKEN   || 'retaux_wh_2026';
const WA_TOKEN      = process.env.WA_ACCESS_TOKEN;
const PHONE_ID      = process.env.WA_PHONE_NUMBER_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const ESCALATION_NUMBERS = ['+5492616303803', '+5492613443289'];

// Máximo de turnos de conversación que se pasan a Claude como contexto
const MAX_CONTEXT_TURNS = 12;

// ─── Cargar knowledge base ────────────────────────────────────────────────────

const KB_PATH = path.join(__dirname, '..', 'docs', 'reta-knowledge-base.md');
let KNOWLEDGE_BASE = '';
try {
  KNOWLEDGE_BASE = fs.readFileSync(KB_PATH, 'utf8');
} catch (e) {
  console.warn('[Reta] No se pudo cargar reta-knowledge-base.md:', e.message);
}

// ─── Helpers de normalización de teléfono ────────────────────────────────────

// WA envía "61437632666" (sin +). DB guarda "0437632666" o "+61437632666" o "437632666".
function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function phonesMatch(waPhone, dbPhone) {
  const wa = normalizePhone(waPhone);
  const db_ = normalizePhone(dbPhone);
  // Comparar últimos 9 dígitos (número local sin código de país)
  return wa.slice(-9) === db_.slice(-9) && wa.slice(-9).length === 9;
}

function findUserByPhone(waPhone) {
  const users = db.get('users').value();
  return users.find(u => u.phone && phonesMatch(waPhone, u.phone)) || null;
}

// ─── Memoria de conversación (lowdb) ─────────────────────────────────────────

function getConv(phone) {
  return db.get('waConversations').find({ phone }).value() || null;
}

function upsertConv(phone, patch) {
  const existing = db.get('waConversations').find({ phone });
  if (existing.value()) {
    existing.assign({ ...patch, updatedAt: new Date().toISOString() }).write();
  } else {
    db.get('waConversations').push({
      phone,
      name: null,
      userId: null,
      summary: '',
      messages: [],
      askedName: false,
      ...patch,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).write();
  }
  return db.get('waConversations').find({ phone }).value();
}

function appendMessage(phone, role, content) {
  const conv = db.get('waConversations').find({ phone });
  if (!conv.value()) return;
  const msgs = conv.value().messages || [];
  msgs.push({ role, content, ts: new Date().toISOString() });
  // Mantener solo los últimos MAX_CONTEXT_TURNS * 2 mensajes
  const trimmed = msgs.slice(-(MAX_CONTEXT_TURNS * 2));
  conv.assign({ messages: trimmed, updatedAt: new Date().toISOString() }).write();
}

// ─── Envío de WhatsApp ────────────────────────────────────────────────────────

function sendWhatsApp(to, text) {
  if (!WA_TOKEN || !PHONE_ID) {
    console.warn('[WA] Faltan WA_ACCESS_TOKEN o WA_PHONE_NUMBER_ID');
    return;
  }
  const toDigits = normalizePhone(to);
  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: toDigits,
    type: 'text',
    text: { body: text },
  });
  const req = https.request({
    hostname: 'graph.facebook.com',
    path: `/v19.0/${PHONE_ID}/messages`,
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${WA_TOKEN}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode !== 200) console.error(`[WA] Error ${res.statusCode} enviando a ${to}:`, data);
    });
  });
  req.on('error', e => console.error('[WA] Error de red:', e.message));
  req.write(body);
  req.end();
}

// ─── Llamada a Claude API ─────────────────────────────────────────────────────

function callClaude(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_KEY) {
      return resolve('Lo siento, el servicio no está disponible en este momento. Por favor escribinos a hola@retaux.com 🙏 — Reta 💙');
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content && json.content[0]) {
            resolve(json.content[0].text);
          } else {
            console.error('[Claude] Respuesta inesperada:', data);
            resolve('Hubo un problema procesando tu mensaje. Por favor intentá de nuevo 🙏 — Reta 💙');
          }
        } catch (e) {
          console.error('[Claude] Error parseando respuesta:', e.message);
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Detectar escalación ─────────────────────────────────────────────────────

const ESCALATION_PHRASES = [
  'no entiendo','no entendi','no comprendo','confused','i don\'t understand',
  'je ne comprends pas','non capisco','não entendo',
  'auditoria','auditoría','carta del ato','multa','penalidad','deuda',
  'reclamo','disputa','reembolso del servicio','queja','me quiero quejar',
  'inversiones','acciones','cripto','dividendos','propiedad','alquiler',
  'contractor','abn propio','negocio propio',
  // Propuestas comerciales
  'propuesta comercial','propuesta de negocio','quiero proponer','tengo una propuesta',
  'colaboracion','colaboración','partnership','asociacion','asociación',
  'sponsor','patrocinio','publicidad','afiliado','afiliados','referral program',
  'white label','alianza','acuerdo comercial','business proposal','joint venture',
];

function detectEscalation(phone, text) {
  if (!text) return null;
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Frases de escalación directa
  const match = ESCALATION_PHRASES.find(p => lower.includes(p));
  if (match) return { reason: `Tema que requiere revisión profesional: "${match}"`, snippet: text };

  // Mensaje repetido del usuario (mismo texto exacto 2 veces seguidas)
  const conv = getConv(phone);
  if (conv) {
    const userMsgs = (conv.messages || []).filter(m => m.role === 'user');
    if (userMsgs.length >= 2) {
      const lastTwo = userMsgs.slice(-2).map(m => m.content.trim().toLowerCase());
      if (lastTwo[0] === lastTwo[1]) {
        return { reason: 'El cliente repitió la misma consulta dos veces seguidas', snippet: text };
      }
    }

    // Respuesta repetida de Reta (últimas 2 respuestas similares en más del 70%)
    const retaMsgs = (conv.messages || []).filter(m => m.role === 'assistant');
    if (retaMsgs.length >= 2) {
      const [prev, last] = retaMsgs.slice(-2).map(m => m.content.trim().toLowerCase());
      const shorter = Math.min(prev.length, last.length);
      if (shorter > 30) {
        // Comparar primeros 80 caracteres como heurística rápida
        const sim = prev.slice(0, 80) === last.slice(0, 80);
        if (sim) {
          return { reason: 'Reta repitió la misma respuesta — el cliente necesita asistencia humana', snippet: text };
        }
      }
    }
  }
  return null;
}

function sendEscalationAlert(from, clientName, escalation) {
  const user = findUserByPhone(from);
  const adminLink = user
    ? `https://retaux.com/admin/user/${user.id}`
    : `https://retaux.com/admin?q=${encodeURIComponent(from)}`;
  const waLink = `https://wa.me/${from}`;

  const msg =
    `⚠️ *ASISTENCIA REQUERIDA — RETAUX*\n\n` +
    `👤 *${clientName || 'Cliente desconocido'}*\n` +
    `📱 WhatsApp: +${from}\n` +
    `💬 Último mensaje: "${escalation.snippet}"\n` +
    `📋 Motivo: ${escalation.reason}\n\n` +
    `🔗 Panel admin: ${adminLink}\n` +
    `💬 Abrir chat: ${waLink}`;
  ESCALATION_NUMBERS.forEach(n => sendWhatsApp(n, msg));
}

// ─── Webhook GET — verificación Meta ─────────────────────────────────────────

router.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('[WA Webhook] Verificación exitosa');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ─── Webhook POST — recibir mensajes ─────────────────────────────────────────

router.post('/webhook/whatsapp', (req, res) => {
  res.sendStatus(200); // responder rápido a Meta

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from; // e.g. "5491112345678"
    const text = (message.text?.body || '').trim();
    if (!text) return;

    console.log(`[Reta] Mensaje de ${from}: ${text}`);

    // Procesar en background para no bloquear
    handleIncomingMessage(from, text).catch(e => console.error('[Reta] Error:', e.message));

  } catch (e) {
    console.error('[WA Webhook] Error:', e.message);
  }
});

// ─── Lógica principal de Reta ─────────────────────────────────────────────────

async function handleIncomingMessage(from, text) {
  // 0. Comandos de admin — si el mensaje viene de un número admin y empieza con #
  const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
  if (ADMIN_PHONES.includes(from) && text.startsWith('#')) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const targetPhone = parts[1]; // número del cliente a pausar/reanudar

    if (cmd === '#pausa' && targetPhone) {
      const horas = parseInt(parts[2]) || 2;
      const ms = horas * 60 * 60 * 1000;
      const target = db.get('waConversations').find({ phone: targetPhone });
      if (target.value()) {
        target.assign({ lastAdminMessageAt: Date.now() + ms - 2 * 60 * 60 * 1000 }).write();
        // Ajuste: forzamos lastAdminMessageAt a "ahora - (ADMIN_SILENCE_MS - horas*ms)" para que dure `horas`
        target.assign({ lastAdminMessageAt: Date.now() - (2 * 60 * 60 * 1000) + ms }).write();
      }
      sendWhatsApp(from, `✅ Reta pausada en +${targetPhone} por ${horas}h`);
    } else if (cmd === '#reanudar' && targetPhone) {
      const target = db.get('waConversations').find({ phone: targetPhone });
      if (target.value()) {
        target.assign({ lastAdminMessageAt: 0 }).write();
      }
      sendWhatsApp(from, `✅ Reta reactivada en +${targetPhone}`);
    } else if (cmd === '#pausa' || cmd === '#reanudar') {
      sendWhatsApp(from, `Uso: #pausa NUMERO [horas] o #reanudar NUMERO\nEj: #pausa 5491112345678 4`);
    }
    return;
  }

  // 1. Cargar o crear conversación
  let conv = getConv(from);
  if (!conv) {
    conv = upsertConv(from, {});
  }

  // 1b. Modo humano — si un admin escribió hace menos de 2 horas, Reta no responde
  const ADMIN_SILENCE_MS = 2 * 60 * 60 * 1000; // 2 horas
  if (conv.lastAdminMessageAt && (Date.now() - conv.lastAdminMessageAt) < ADMIN_SILENCE_MS) {
    appendMessage(from, 'user', text);
    console.log(`[Reta] Silenciada en ${from} — admin activo hasta ${new Date(conv.lastAdminMessageAt + ADMIN_SILENCE_MS).toISOString()}`);
    return;
  }

  // 2. Identificar cliente por número de teléfono
  let clientName = conv.name;
  let userId     = conv.userId;

  if (!clientName) {
    const user = findUserByPhone(from);
    if (user) {
      clientName = user.fullName;
      userId     = user.id;
      upsertConv(from, { name: clientName, userId, askedName: true });
    }
  }

  // 3. Si no tenemos nombre y todavía no preguntamos → preguntar
  if (!clientName && !conv.askedName) {
    upsertConv(from, { askedName: true });
    appendMessage(from, 'user', text);

    const greeting = await callClaude(
      buildSystemPrompt(null),
      [
        { role: 'user', content: text },
        { role: 'assistant', content: '¡Hola! Soy Reta, la asistente de RETAUX. Para poder ayudarte mejor, ¿me decís tu nombre? 😊 — Reta 💙' },
      ]
    );
    // Usar el saludo generado por Claude pero asegurarse que pide el nombre
    const welcomeMsg = `¡Hola! Soy Reta, la asistente de RETAUX 🇦🇺\n\nPara poder ayudarte mejor, ¿me decís cómo te llamás? 😊\n\n— Reta 💙`;
    appendMessage(from, 'assistant', welcomeMsg);
    sendWhatsApp(from, welcomeMsg);
    return;
  }

  // 4. Si acabamos de recibir el nombre (askedName true, sin nombre guardado)
  if (!clientName && conv.askedName) {
    // El texto actual es probablemente el nombre
    const detectedName = text.split(' ').slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    clientName = detectedName;
    upsertConv(from, { name: clientName });
    appendMessage(from, 'user', text);

    const welcomeReply = await callClaude(
      buildSystemPrompt(clientName),
      buildMessages(from, text)
    );
    appendMessage(from, 'assistant', welcomeReply);
    sendWhatsApp(from, welcomeReply);
    return;
  }

  // 5. Detectar escalación antes de responder
  const escalation = detectEscalation(from, text);
  appendMessage(from, 'user', text);

  if (escalation) {
    console.log(`[Reta] Escalación para ${from}: ${escalation.reason}`);
    sendEscalationAlert(from, clientName || from, escalation);
    const escMsg = `Entiendo tu consulta, ${clientName ? clientName.split(' ')[0] : ''}. Esto lo tiene que revisar el equipo de RETAUX directamente — te van a contactar a la brevedad 🙏\n\n— Reta 💙`;
    appendMessage(from, 'assistant', escMsg);
    sendWhatsApp(from, escMsg);
    return;
  }

  // 6. Generar respuesta con Claude
  const reply = await callClaude(
    buildSystemPrompt(clientName),
    buildMessages(from, null) // mensajes ya incluyen el del usuario recién appendeado
  );

  appendMessage(from, 'assistant', reply);
  sendWhatsApp(from, reply);
}

// ─── Armar system prompt ──────────────────────────────────────────────────────

function buildSystemPrompt(clientName) {
  const conv = clientName ? getConv(null) : null; // no usado directamente
  return `${KNOWLEDGE_BASE}

---
${clientName ? `El nombre del cliente en esta conversación es: ${clientName}.` : 'Todavía no sabés el nombre del cliente.'}
Hoy es ${new Date().toLocaleDateString('es-AR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}.

REGLA CRÍTICA DE IDIOMA: Detectá el idioma del último mensaje del usuario y respondé SIEMPRE en ese mismo idioma. Si escribe en inglés → respondé en inglés. Si escribe en portugués → respondé en portugués. Si escribe en italiano → respondé en italiano. Si escribe en español → respondé en español. NUNCA respondas en un idioma distinto al que usó el cliente. Esta regla tiene prioridad sobre todo lo demás.

Tus respuestas deben ser cortas y directas al punto — esto es WhatsApp, no un email.
Firmá siempre con "— Reta 💙" al final.`;
}

// ─── Armar array de messages para Claude ─────────────────────────────────────

function buildMessages(phone, latestUserText) {
  const conv = getConv(phone);
  const history = conv ? (conv.messages || []) : [];

  // Convertir a formato Claude (solo role + content, sin ts)
  const claudeMsgs = history.map(m => ({ role: m.role, content: m.content }));

  // Si el historial está vacío o el último no es del usuario, agregar el texto actual
  if (latestUserText && (claudeMsgs.length === 0 || claudeMsgs[claudeMsgs.length - 1].role !== 'user')) {
    claudeMsgs.push({ role: 'user', content: latestUserText });
  }

  // Claude requiere que el primer mensaje sea del usuario
  if (claudeMsgs.length > 0 && claudeMsgs[0].role === 'assistant') {
    claudeMsgs.shift();
  }

  return claudeMsgs.length > 0 ? claudeMsgs : [{ role: 'user', content: latestUserText || 'Hola' }];
}

module.exports = router;
