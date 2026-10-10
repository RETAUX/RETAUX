const nodemailer = require('nodemailer')
const fs = require('fs')
const path = require('path')

function getTransporter() {
  if (!process.env.SMTP_HOST) {
    return {
      sendMail(options) {
        const log = `\n--- EMAIL ${new Date().toISOString()} ---\nTo: ${options.to}\nSubject: ${options.subject}\n${options.text || ''}\n`
        fs.appendFileSync(path.join(__dirname, '..', 'emails-dev.log'), log)
        return Promise.resolve({ messageId: 'dev-log' })
      }
    }
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  })
}

function wrap(html) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600&family=Source+Sans+3:wght@400;600&family=IBM+Plex+Mono&display=swap');
  body{margin:0;background:#F7F2E7;font-family:'Source Sans 3',sans-serif;color:#1C2B45}
  .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:#1C2B45;padding:28px 32px;text-align:center}
  .logo{font-family:'Fraunces',serif;font-size:28px;color:#F7F2E7;letter-spacing:2px}
  .logo span{color:#D98A3D}
  .body{padding:32px}
  h1{font-family:'Fraunces',serif;font-size:22px;margin:0 0 16px}
  p{line-height:1.6;margin:0 0 14px;font-size:15px}
  .code{font-family:'IBM Plex Mono',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#D98A3D;display:block;text-align:center;margin:24px 0}
  .btn{display:inline-block;background:#D98A3D;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px}
  .footer{background:#F7F2E7;padding:20px 32px;font-size:12px;color:#1C2B45;opacity:.7;text-align:center}
  .highlight{background:#F7F2E7;border-left:4px solid #D98A3D;padding:12px 16px;border-radius:4px;margin:16px 0}
  .mono{font-family:'IBM Plex Mono',monospace;font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><div class="logo">RETAU<span>X</span></div></div>
  <div class="body">${html}</div>
  <div class="footer">RETAUX · hola@retaux.com · retaux.com<br>Australian Tax Return Services</div>
</div>
</body>
</html>`
}

async function sendWelcome(user, verificationCode) {
  const transporter = getTransporter()
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Verificá tu cuenta — RETAUX',
    text: `Hola ${user.firstName}, tu código de verificación es: ${verificationCode}`,
    html: wrap(`
      <h1>¡Bienvenido/a a RETAUX, ${user.firstName}!</h1>
      <p>Para activar tu cuenta ingresá el siguiente código de verificación:</p>
      <span class="code">${verificationCode}</span>
      <p>Este código expira en 24 horas. Si no creaste esta cuenta, ignorá este mensaje.</p>
    `)
  })
}

async function sendPaymentConfirmation(user, appointment) {
  const transporter = getTransporter()
  const dateStr = new Date(appointment.date).toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Pago confirmado — Tu turno está reservado',
    text: `Pago recibido. Tu turno es el ${dateStr} a las ${appointment.hour}:00.`,
    html: wrap(`
      <h1>Pago confirmado ✓</h1>
      <p>Hola <strong>${user.firstName}</strong>, recibimos tu pago de <strong>AUD 120</strong>.</p>
      <div class="highlight">
        <p style="margin:0"><strong>Tu turno asignado:</strong><br>
        ${dateStr}<br>
        <span class="mono">${appointment.hour}:00 hs (AEST)</span></p>
      </div>
      <p>Nuestro equipo revisará tu documentación y se pondrá en contacto contigo.</p>
      <p>Podés seguir el estado de tu trámite en tu panel:</p>
      <p><a class="btn" href="${process.env.BASE_URL}/dashboard">Ver mi panel</a></p>
    `)
  })
}

async function sendReferralCode(user) {
  const transporter = getTransporter()
  const refLink = `${process.env.BASE_URL}/register?ref=${user.referralCode}`
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Tu código de referido — Ganás AUD 20 por cada amigo',
    text: `Tu código de referido es ${user.referralCode}. Compartí este link: ${refLink}`,
    html: wrap(`
      <h1>¡Compartí RETAUX y ganás AUD 20!</h1>
      <p>Hola <strong>${user.firstName}</strong>, gracias por confiar en nosotros.</p>
      <p>Por cada amigo que uses tu código y pague el servicio, recibís <strong>AUD 20</strong>.</p>
      <div class="highlight">
        <p style="margin:0 0 8px"><strong>Tu código:</strong></p>
        <span class="code" style="font-size:22px;letter-spacing:4px">${user.referralCode}</span>
        <p style="margin:8px 0 0;font-size:13px">O compartí directamente este link:</p>
        <p style="margin:4px 0 0" class="mono">${refLink}</p>
      </div>
      <p>Podés ver el estado de tus referidos en tu panel.</p>
      <p><a class="btn" href="${process.env.BASE_URL}/dashboard">Ver mi panel</a></p>
    `)
  })
}

async function sendVerificationReminder(user, verificationCode) {
  const transporter = getTransporter()
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Nuevo código de verificación — RETAUX',
    text: `Tu nuevo código de verificación es: ${verificationCode}`,
    html: wrap(`
      <h1>Nuevo código de verificación</h1>
      <p>Hola ${user.firstName}, solicitaste un nuevo código. Aquí está:</p>
      <span class="code">${verificationCode}</span>
      <p>Expira en 24 horas.</p>
    `)
  })
}

module.exports = { sendWelcome, sendPaymentConfirmation, sendReferralCode, sendVerificationReminder }
