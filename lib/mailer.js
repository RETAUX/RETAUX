const fs = require('fs');
const path = require('path');

const DEV_LOG = path.join(__dirname, '..', 'emails-dev.log');
const FROM_NAME = 'RETAUX';
const FROM_EMAIL = 'hola@retaux.com';

/**
 * Envía email via Brevo API (HTTPS port 443 — nunca bloqueado).
 * Fallback: guarda en emails-dev.log si no hay API key.
 */
async function sendMail({ to, subject, text, html, attachments, bcc, cc, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;

  if (apiKey) {
    const payload = {
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: (Array.isArray(to) ? to : [to]).map(e => ({ email: e })),
      subject: subject,
      htmlContent: html || `<p>${text}</p>`,
      textContent: text || (html ? html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim() : subject)
    };
    if (bcc && bcc.length) {
      payload.bcc = (Array.isArray(bcc) ? bcc : [bcc]).map(b => ({ email: b }));
    }
    if (cc) {
      payload.cc = (Array.isArray(cc) ? cc : [cc]).map(c => ({ email: c }));
    }
    if (replyTo) {
      payload.replyTo = { email: replyTo };
    }
    if (attachments && attachments.length) {
      const validAttachments = attachments.filter(a => a.content && a.content.length > 0);
      if (validAttachments.length < attachments.length) {
        const skipped = attachments.filter(a => !a.content || a.content.length === 0).map(a => a.name);
        console.error(`[EMAIL] Adjuntos ignorados por contenido vacío: ${skipped.join(', ')}`);
      }
      if (validAttachments.length > 0) {
        payload.attachment = validAttachments.map(a => ({ name: a.name, content: a.content }));
      }
    }
    const body = JSON.stringify(payload);

    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json'
        },
        body: body,
        signal: AbortSignal.timeout(10000) // 10 segundos máximo
      });

      const data = await res.json();

      if (res.ok) {
        console.log(`[EMAIL OK] To: ${to} | Subject: ${subject} | MsgId: ${data.messageId}`);
      } else {
        console.error(`[EMAIL ERROR] To: ${to} | Status: ${res.status} | ${JSON.stringify(data)}`);
        throw new Error(`Brevo API error: ${res.status}`);
      }
    } catch (err) {
      console.error(`[EMAIL ERROR] To: ${to} | ${err.message}`);
      const entry = `\n--- ${new Date().toISOString()} ERROR ---\nTo: ${to}\nSubject: ${subject}\nError: ${err.message}\n${text}\n`;
      fs.appendFileSync(DEV_LOG, entry);
      throw err;
    }
    return;
  }

  // Sin API key: guardar en archivo local
  const entry =
    `\n--- ${new Date().toISOString()} ---\n` +
    `To: ${to}\nSubject: ${subject}\n\n${text || '(html only)'}\n`;
  fs.appendFileSync(DEV_LOG, entry);
  console.log(`[DEV EMAIL] Sin API key → emails-dev.log | To: ${to}`);
}

module.exports = { sendMail };
