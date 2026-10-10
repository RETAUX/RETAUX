/**
 * RETAUX — HTML email templates.
 * Palette from official REtaux.png logo:
 *   Navy #0A0E5C · Gold #FFC107 · White #FFFFFF · Page bg #F0F4F8
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { sendMail } = require('./mailer');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const LOGO_URL = `${BASE}/images/logo.png`;

const LAYOUT = (content) => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#F0F4F8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F8;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#0A0E5C;padding:22px 40px;border-radius:8px 8px 0 0;">
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td>
                  <span style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#FFFFFF;letter-spacing:0.04em;">RE<span style="color:#FFC107;">TAUX</span></span>
                  <span style="display:block;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.12em;text-transform:uppercase;margin-top:2px;">Tax returns · Australia</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#FFFFFF;padding:40px;border-left:1px solid #C9D8E8;border-right:1px solid #C9D8E8;">
            ${content}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0A0E5C;padding:20px 40px;border-radius:0 0 8px 8px;">
            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.6);line-height:1.6;">
              RETAUX · Tax return services for Australia<br>
              <a href="mailto:hola@retaux.com.au" style="color:#FFC107;text-decoration:none;">hola@retaux.com.au</a><br>
              <span style="color:rgba(255,255,255,0.4);">This is not financial advice. Verify all information with your registered tax agent.</span>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

const BTN = (url, label) =>
  `<table cellpadding="0" cellspacing="0" style="margin:28px 0;">
    <tr><td style="background:#FFC107;border-radius:6px;">
      <a href="${url}" style="display:inline-block;padding:14px 32px;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:700;color:#0D2B55;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;

const H1 = (text) => `<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:26px;color:#0D2B55;">${text}</h1>`;
const H2 = (text) => `<h2 style="margin:24px 0 8px;font-family:Georgia,serif;font-size:18px;color:#0D2B55;">${text}</h2>`;
const P  = (text) => `<p style="margin:0 0 14px;font-size:15px;color:#5A6A7A;line-height:1.6;">${text}</p>`;
const DIVIDER = `<hr style="border:none;border-top:1px solid #C9D8E8;margin:24px 0;">`;

const INFO_BOX = (content) =>
  `<div style="background:#EBF4FD;border:1px solid #BCD8F3;border-radius:6px;padding:18px 20px;margin:20px 0;">
    ${content}
  </div>`;

const CODE_BOX = (code) =>
  `<div style="background:#0A0E5C;border-radius:6px;padding:20px;margin:20px 0;text-align:center;">
    <p style="margin:0 0 8px;font-size:12px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.1em;">Código de verificación</p>
    <p style="margin:0;font-family:'Courier New',monospace;font-size:36px;font-weight:700;color:#FFC107;letter-spacing:0.3em;">${code}</p>
    <p style="margin:8px 0 0;font-size:12px;color:rgba(255,255,255,0.5);">Válido por 30 minutos</p>
  </div>`;

// ─── Templates ───────────────────────────────────────────────────────────────

// Traducciones del email de verificación
const EMAIL_TRANSLATIONS = {
  es: {
    subject: 'Verificá tu cuenta RETAUX',
    welcome: 'Te damos la bienvenida a RETAUX 🎉',
    greeting: (name) => `Hola <strong>${name}</strong>, tu cuenta fue creada exitosamente.`,
    body: 'Para activar tu cuenta, hacé clic en el botón o ingresá el código manualmente.',
    btn: 'VERIFICAR MI CUENTA',
    ignore: 'Si no creaste esta cuenta, podés ignorar este e-mail.',
    text: (name, code, link) => `Hola ${name},\n\nTu código de verificación es: ${code}\n\nO hacé clic aquí: ${link}\n\nVálido por 30 minutos.\n\nRETAUX`
  },
  en: {
    subject: 'Verify your RETAUX account',
    welcome: 'We welcome you to RETAUX 🎉',
    greeting: (name) => `Hi <strong>${name}</strong>, your account was created successfully.`,
    body: 'To activate your account, click the button below or enter the code manually on the site.',
    btn: 'VERIFY MY ACCOUNT',
    ignore: 'If you did not create this account, you can safely ignore this email.',
    text: (name, code, link) => `Hi ${name},\n\nYour verification code is: ${code}\n\nOr click here: ${link}\n\nValid for 30 minutes.\n\nRETAUX`
  },
  fr: {
    subject: 'Vérifiez votre compte RETAUX',
    welcome: 'Nous vous souhaitons la bienvenue sur RETAUX 🎉',
    greeting: (name) => `Bonjour <strong>${name}</strong>, votre compte a été créé avec succès.`,
    body: 'Pour activer votre compte, cliquez sur le bouton ci-dessous ou entrez le code manuellement.',
    btn: 'VÉRIFIER MON COMPTE',
    ignore: 'Si vous n\'avez pas créé ce compte, vous pouvez ignorer cet e-mail.',
    text: (name, code, link) => `Bonjour ${name},\n\nVotre code de vérification est : ${code}\n\nOu cliquez ici : ${link}\n\nValide 30 minutes.\n\nRETAUX`
  },
  it: {
    subject: 'Verifica il tuo account RETAUX',
    welcome: 'Ti diamo il benvenuto su RETAUX 🎉',
    greeting: (name) => `Ciao <strong>${name}</strong>, il tuo account è stato creato con successo.`,
    body: 'Per attivare il tuo account, clicca sul pulsante o inserisci il codice manualmente.',
    btn: 'VERIFICA IL MIO ACCOUNT',
    ignore: 'Se non hai creato questo account, puoi ignorare questa email.',
    text: (name, code, link) => `Ciao ${name},\n\nIl tuo codice di verifica è: ${code}\n\nOppure clicca qui: ${link}\n\nValido per 30 minuti.\n\nRETAUX`
  }
};

async function sendWelcomeVerification(user) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'es';
  const t = EMAIL_TRANSLATIONS[lang];
  const link = `${BASE}/verify-email?code=${user.verificationCode}`;
  const firstName = user.fullName.split(' ')[0];

  const html = LAYOUT(`
    ${H1(t.welcome)}
    ${P(t.greeting(firstName))}
    ${P(t.body)}
    ${BTN(link, t.btn)}
    ${CODE_BOX(user.verificationCode)}
    ${P(t.ignore)}
  `);

  await sendMail({
    to: user.email,
    subject: t.subject,
    text: t.text(firstName, user.verificationCode, link),
    html
  });
}

async function sendPaymentConfirmed(user) {
  const firstName = (user.fullName || user.email).split(' ')[0];
  const subject = '✅ Payment verified — RETAUX';

  const html = LAYOUT(`
    ${H1('Payment verified')}
    ${P(`Hi <strong>${firstName}</strong>, we have successfully verified your payment. Thank you!`)}
    ${INFO_BOX(`
      <p style="margin:0;font-size:14px;color:#1565C0;line-height:1.8;">
        We are already working on your case. We will get in touch with you if we need any additional information.<br><br>
        In the meantime, you can check the status of your case at any time from your dashboard.
      </p>
    `)}
    ${BTN(`${BASE}/dashboard`, 'VIEW MY CASE STATUS')}
    ${DIVIDER}
    ${P('If you have any questions, feel free to contact us at <a href="mailto:hola@retaux.com" style="color:#0A0E5C;font-weight:600;">hola@retaux.com</a>.')}
  `);

  await sendMail({
    to: user.email,
    subject,
    text: `Hi ${firstName},\n\nWe have successfully verified your payment. Thank you!\n\nWe are already working on your case and will be in touch if we need any additional information.\n\nTrack your case: ${BASE}/dashboard\n\nRETAUX · hola@retaux.com`,
    html
  });
}

async function sendPaymentReceipt(user, payment, appointment) {
  const firstName = (user.fullName || user.email).split(' ')[0];
  const invoiceNo = 'RTX-' + (payment.id || '').slice(0, 8).toUpperCase();
  const FULL_PRICE = 150;
  const DISC_AMOUNT = 30;
  const amountAUD = ((payment.amountCents || FULL_PRICE * 100) / 100).toFixed(2);
  const paidDate  = new Date(payment.paidAt || Date.now()).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const taxYear   = payment.taxYear || '2024-25';
  const subject = `✅ Payment confirmed · Receipt ${invoiceNo} — RETAUX`;

  const greeting = `Hi ${firstName}! Your payment has been confirmed. Please keep this email as your official receipt — we're already working on your tax return.`;

  const nextSteps = [
    'Our team reviews your documents and information.',
    'We contact you to complete the ATO linking process.',
    'We lodge your tax return with the ATO.',
    'The ATO deposits your refund directly into your Australian bank account.',
  ];

  const discountRow = payment.discountApplied ? `
    <tr>
      <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;color:#1a2430;">
        <span style="display:inline-block;background:#eaf7ff;color:#060C14;font-weight:700;padding:4px 10px;border-radius:6px;">Referral discount</span>
      </td>
      <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;text-align:right;color:#16a34a;font-weight:600;">- AUD ${DISC_AMOUNT}.00</td>
    </tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RETAUX — Receipt ${invoiceNo}</title>
</head>
<body style="margin:0;padding:30px 0;background:#f4f6f8;font-family:Arial,sans-serif;color:#1a2430;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">

  <!-- HEADER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr>
      <td style="padding:28px 32px;">
        <span style="font-family:Arial,sans-serif;font-size:26px;font-weight:900;letter-spacing:1px;">
          <span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span>
        </span>
      </td>
      <td align="right" style="padding:28px 32px;">
        <p style="margin:0;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:1px;">TAX RETURN RECEIPT</p>
        <p style="margin:4px 0 0;color:#8fa3b8;font-size:12px;">Invoice / Payment Confirmation</p>
      </td>
    </tr>
  </table>

  <!-- BODY -->
  <div style="padding:32px;">

    <!-- Greeting -->
    <div style="background:#e0f4ff;border-left:4px solid #38BDF8;padding:16px 20px;border-radius:6px;margin-bottom:28px;font-size:14px;line-height:1.6;color:#1a2430;">
      ${greeting}
    </div>

    <!-- Meta row -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="vertical-align:top;padding-right:16px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Billed To</p>
          <p style="margin:0;font-size:14px;line-height:1.5;">${user.fullName}<br><span style="color:#7a8a9a;">${user.email}</span></p>
        </td>
        <td style="vertical-align:top;text-align:center;padding-right:16px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Invoice No.</p>
          <p style="margin:0;font-size:14px;font-weight:700;font-family:'Courier New',monospace;">${invoiceNo}</p>
        </td>
        <td style="vertical-align:top;text-align:right;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Date</p>
          <p style="margin:0;font-size:14px;">${paidDate}</p>
        </td>
      </tr>
    </table>

    <!-- Issued by -->
    <div style="margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Issued By</p>
      <p style="margin:0;font-size:14px;line-height:1.7;">Ghada Charbine — Registered Tax Agent (TPB No. 65195004)<br>
      ABN 58 624 412 713<br>
      On behalf of RETAUX &nbsp;|&nbsp; hola@retaux.com &nbsp;|&nbsp; www.retaux.com</p>
    </div>

    <!-- Line items -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:11px;text-transform:uppercase;color:#7a8a9a;border-bottom:2px solid #eef1f4;padding:8px 4px;">Description</th>
          <th style="text-align:right;font-size:11px;text-transform:uppercase;color:#7a8a9a;border-bottom:2px solid #eef1f4;padding:8px 4px;">Amount (AUD)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding:14px 4px;border-bottom:1px solid #eef1f4;font-size:14px;">
            <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#38BDF8;color:#060C14;font-size:12px;font-weight:700;text-align:center;line-height:22px;margin-right:8px;">1</span>
            Australian Tax Return Preparation &amp; Lodgement — FY ${taxYear}
          </td>
          <td style="padding:14px 4px;border-bottom:1px solid #eef1f4;font-size:14px;text-align:right;">
            <span style="display:inline-block;background:#eaf7ff;color:#060C14;font-weight:700;padding:4px 10px;border-radius:6px;">AUD ${FULL_PRICE}.00</span>
          </td>
        </tr>
        ${discountRow}
      </tbody>
    </table>

    <!-- Total -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;border-radius:8px;margin-top:10px;">
      <tr>
        <td style="padding:18px 22px;color:#8fa3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Total Paid</td>
        <td style="padding:18px 22px;text-align:right;color:#F0C040;font-size:24px;font-weight:700;">AUD ${amountAUD}</td>
      </tr>
    </table>

    <!-- Tax agent box -->
    <div style="margin-top:24px;padding:16px 20px;border:1px solid #eef1f4;border-radius:8px;background:#fafbfc;">
      <p style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:#7a8a9a;letter-spacing:0.5px;">Registered Tax Agent</p>
      <p style="margin:0;font-size:14px;line-height:1.7;">
        Ghada Charbine<br>
        Tax Practitioners Board (TPB) Registration No. 65195004<br>
        Return prepared, reviewed, and lodged with the Australian Taxation Office (ATO) under the supervision of the Registered Tax Agent named above.
      </p>
    </div>

    <!-- Legal note -->
    <div style="background:#fff8e6;border-left:4px solid #F0C040;padding:14px 16px;border-radius:6px;font-size:13px;color:#5a4a10;margin-top:24px;line-height:1.6;">
      This document confirms receipt of payment for tax return services provided through RETAUX. Tax compliance review and lodgement are performed exclusively by the Registered Tax Agent named above, in accordance with the Tax Agent Services Act 2009 (TASA).
    </div>

    <!-- Next steps -->
    <p style="margin:28px 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">What happens next?</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${nextSteps.map((step, i) => `
      <tr>
        <td style="padding:8px 0;vertical-align:top;width:30px;">
          <span style="display:inline-block;background:#38BDF8;color:#060C14;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;">${i + 1}</span>
        </td>
        <td style="padding:8px 0 8px 10px;font-size:14px;color:#5a6a7a;">${step}</td>
      </tr>`).join('')}
    </table>

    <!-- CTA -->
    <div style="text-align:center;margin:32px 0;">
      <a href="${BASE}/dashboard" style="background:#38BDF8;color:#060C14;text-decoration:none;font-weight:700;padding:15px 34px;border-radius:30px;display:inline-block;font-size:15px;">View my case status →</a>
    </div>

  </div>

  <!-- FOOTER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;">
    <tr>
      <td style="padding:24px 32px;text-align:center;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;font-weight:900;">
          <span style="color:#38BDF8;">RE</span><span style="color:#F0C040;">TAUX</span>
        </p>
        <p style="margin:0;color:#8fa3b8;font-size:12px;line-height:1.8;">
          hola@retaux.com &nbsp;|&nbsp; www.retaux.com<br>Australia
        </p>
      </td>
    </tr>
  </table>

</div>
</body>
</html>`;

  await sendMail({
    to: user.email,
    subject,
    bcc: ['ghadacharbine50@gmail.com', 'hishamcharbine@gmail.com', 'hola@retaux.com'],
    text: `${greeting}\n\nInvoice No.: ${invoiceNo}\nDate: ${paidDate}\nService: Australian Tax Return FY ${taxYear}\nTotal: AUD ${amountAUD}\n\nIssued by: Ghada Charbine — TPB No. 65195004 | ABN 58 624 412 713\n\nTrack your case: ${BASE}/dashboard\n\nhola@retaux.com | www.retaux.com`,
    html
  });
}

async function sendPaymentPendingNotification(user, payment) {
  const firstName = user.fullName.split(' ')[0];
  const amountAUD = (payment.amountCents / 100).toFixed(2);
  const taxYear   = payment.taxYear || '2025-26';

  const html = LAYOUT(`
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td>
          <h1 style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;color:#0D2B55;">We've received your payment notification</h1>
          <p style="margin:0;font-size:14px;color:#5A6A7A;">Australian Tax Return FY ${taxYear}</p>
        </td>
        <td align="right" valign="top">
          <span style="display:inline-block;background:#FFF8E1;color:#92400E;font-size:13px;font-weight:700;padding:6px 14px;border-radius:20px;">⏳ PENDING</span>
        </td>
      </tr>
    </table>

    ${P(`Hi <strong>${firstName}</strong>, we've received your notification that you've completed the payment of <strong>AUD ${amountAUD}</strong>.`)}

    ${INFO_BOX(`
      <p style="margin:0 0 10px;font-size:13px;color:#1565C0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">What happens now?</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:6px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;background:#0A0E5C;color:#FFC107;width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:11px;font-weight:700;">1</span>
          </td>
          <td style="padding:6px 0 6px 10px;font-size:14px;color:#0D2B55;">Our team verifies the payment in Revolut — usually within a few hours.</td>
        </tr>
        <tr>
          <td style="padding:6px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;background:#0A0E5C;color:#FFC107;width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:11px;font-weight:700;">2</span>
          </td>
          <td style="padding:6px 0 6px 10px;font-size:14px;color:#0D2B55;">Once confirmed, your case is activated and you'll receive a receipt by email.</td>
        </tr>
        <tr>
          <td style="padding:6px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;background:#0A0E5C;color:#FFC107;width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:11px;font-weight:700;">3</span>
          </td>
          <td style="padding:6px 0 6px 10px;font-size:14px;color:#0D2B55;">We'll contact you to complete the ATO linking and lodge your tax return.</td>
        </tr>
      </table>
    `)}

    ${BTN(`${BASE}/dashboard`, 'VIEW MY CASE STATUS')}

    ${DIVIDER}
    ${P('If you have any questions, contact us at <a href="mailto:hola@retaux.com" style="color:#0A0E5C;font-weight:600;">hola@retaux.com</a>.')}
  `);

  await sendMail({
    to: user.email,
    subject: 'RETAUX – We received your payment notification',
    text: `Hi ${firstName},\n\nWe've received your notification that you've completed the payment of AUD ${amountAUD}.\n\nOur team will verify the payment and activate your case shortly. You'll receive a receipt once confirmed.\n\nTrack your case: ${BASE}/dashboard\n\nRETAUX · hola@retaux.com`,
    html
  });
}

async function sendPaymentRejectedNotification(user) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'en';
  const strings = JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${lang}.json`), 'utf8'));
  const t = strings.payment;
  const firstName = user.fullName.split(' ')[0];
  const paymentUrl = `${BASE}/payment`;

  const intro    = t.rejected_intro.replace('{{name}}', firstName);
  const subject  = t.rejected_subject;

  const html = LAYOUT(`
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td>
          <h1 style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;color:#0D2B55;">${t.rejected_title}</h1>
          <p style="margin:0;font-size:14px;color:#5A6A7A;">${t.rejected_subtitle}</p>
        </td>
        <td align="right" valign="top">
          <span style="display:inline-block;background:#FBEAE5;color:#C0392B;font-size:13px;font-weight:700;padding:6px 14px;border-radius:20px;">${t.rejected_badge}</span>
        </td>
      </tr>
    </table>

    ${P(intro)}

    <div style="background:#FBEAE5;border:1px solid #F5C6C0;border-radius:8px;padding:18px 20px;margin:20px 0;">
      <p style="margin:0 0 10px;font-size:13px;color:#C0392B;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">${t.rejected_box_title}</p>
      <p style="margin:0;font-size:14px;color:#7B241C;line-height:1.8;">${t.rejected_box_body}</p>
    </div>

    ${BTN(paymentUrl, t.rejected_btn)}

    ${DIVIDER}
    ${P(t.rejected_outro)}
  `);

  await sendMail({
    to: user.email,
    subject,
    text: `${firstName},\n\n${t.rejected_box_body.replace(/<[^>]+>/g, '')}\n\n${paymentUrl}\n\nRETAUX · hola@retaux.com`,
    html
  });
}

async function sendReferralCode(user) {
  const firstName = (user.fullName || user.email).split(' ')[0];
  const link = `${BASE}/register?ref=${user.referralCode}`;
  const html = LAYOUT(`
    ${H1('Refer a friend — earn AUD 20')}
    ${P(`Hi <strong>${firstName}</strong>, share RETAUX with your friends and earn <strong>AUD 20</strong> for each person who registers with your link and pays for the service.`)}
    ${INFO_BOX(`
      <p style="margin:0 0 8px;font-size:13px;color:#1565C0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Your referral code</p>
      <p style="margin:0;font-family:'Courier New',monospace;font-size:24px;font-weight:700;color:#0D2B55;letter-spacing:0.1em;">${user.referralCode}</p>
    `)}
    ${BTN(link, 'SHARE MY REFERRAL LINK')}
    ${P('Share the link above — when your friends sign up through it, they are automatically linked to your account. No need to enter codes manually.')}
    ${P('Your AUD 20 commission is credited once your referred friend completes payment for the service.')}
  `);

  await sendMail({
    to: user.email,
    subject: 'Your RETAUX referral code — earn AUD 20 per friend',
    text: `Hi ${firstName},\n\nYour referral link: ${link}\nYour code: ${user.referralCode}\n\nEarn AUD 20 for each friend who signs up and pays for the service.\n\nRETAUX · hola@retaux.com`,
    html
  });
}

async function sendPasswordReset(user, code) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'es';
  const firstName = user.fullName.split(' ')[0];
  const RESET_TRANSLATIONS = {
    es: { subject: 'Recuperá tu clave RETAUX', title: 'Recuperar clave', body: `Hola <strong>${firstName}</strong>, recibimos una solicitud para cambiar tu clave.`, label: 'Tu código de recuperación', hint: 'Válido por 30 minutos. Si no pediste esto, ignorá este mensaje.', text: `Hola ${firstName},\n\nTu código de recuperación: ${code}\n\nVálido 30 minutos.\n\nRETAUX` },
    en: { subject: 'Reset your RETAUX password', title: 'Password reset', body: `Hi <strong>${firstName}</strong>, we received a request to reset your password.`, label: 'Your reset code', hint: 'Valid for 30 minutes. If you didn\'t request this, ignore this email.', text: `Hi ${firstName},\n\nYour reset code: ${code}\n\nValid 30 minutes.\n\nRETAUX` },
    fr: { subject: 'Réinitialiser votre mot de passe RETAUX', title: 'Réinitialisation', body: `Bonjour <strong>${firstName}</strong>, nous avons reçu une demande de réinitialisation.`, label: 'Votre code de réinitialisation', hint: 'Valide 30 minutes.', text: `Bonjour ${firstName},\n\nVotre code: ${code}\n\nRETAUX` },
    it: { subject: 'Reimposta la tua password RETAUX', title: 'Reset password', body: `Ciao <strong>${firstName}</strong>, abbiamo ricevuto una richiesta di reset.`, label: 'Il tuo codice di reset', hint: 'Valido 30 minuti.', text: `Ciao ${firstName},\n\nIl tuo codice: ${code}\n\nRETAUX` }
  };
  const t = RESET_TRANSLATIONS[lang];
  const resetUrl = `${BASE}/reset-password?email=${encodeURIComponent(user.email)}`;
  const btnLabels = { es: 'INGRESAR MI CÓDIGO', en: 'ENTER MY CODE', fr: 'SAISIR MON CODE', it: 'INSERISCI IL CODICE' };
  const html = LAYOUT(`
    ${H1(t.title)}
    ${P(t.body)}
    ${CODE_BOX(code)}
    ${BTN(resetUrl, btnLabels[lang] || 'ENTER MY CODE')}
    ${P(t.hint)}
  `);
  await sendMail({ to: user.email, subject: t.subject, text: `${t.text}\n\nEnter your code here: ${resetUrl}`, html });
}

async function sendAppointmentConfirmation(user, appt) {
  const { formatSlot } = require('../db/appointments');
  const slotStr = formatSlot(appt.date, appt.hour);
  const firstName = user.fullName.split(' ')[0];

  const html = LAYOUT(`
    ${H1('Tu turno está confirmado ✅')}
    ${P(`Hola <strong>${firstName}</strong>, tu turno de gestión con RETAUX fue reservado exitosamente.`)}
    <div style="background:#F0F4F8;border-radius:8px;padding:20px 24px;margin:20px 0;text-align:center;">
      <p style="margin:0 0 6px;font-size:0.75rem;letter-spacing:0.1em;color:#5A6A7A;font-family:monospace;text-transform:uppercase;">TU TURNO DE GESTIÓN</p>
      <p style="margin:0;font-size:1.4rem;font-weight:700;color:#0A0E5C;font-family:Georgia,serif;">${slotStr}</p>
    </div>
    ${P('Ese día nos pondremos en contacto con vos para informarte el estimado de tu devolución y guiarte en los próximos pasos.')}
    ${P('Si necesitás cambiar el horario o tenés alguna consulta, escribinos a <a href="mailto:hola@retaux.com">hola@retaux.com</a>.')}
    ${P('<strong>¿Ya tenés el código de vinculación con el ATO?</strong> Podés enviarlo desde tu panel en cualquier momento.')}
  `);

  await sendMail({
    to: user.email,
    subject: `Turno confirmado — ${slotStr} — RETAUX`,
    text: `Hola ${firstName},\n\nTu turno de gestión fue confirmado: ${slotStr}\n\nEse día te contactaremos con el estimado de tu devolución.\n\nCualquier consulta: hola@retaux.com\n\nRETAUX`,
    html
  });
}

async function generateStyledQRCard(refLink, refCode) {
  const sharp = require('sharp');

  // Matriz de módulos del QR (sync)
  const qrData = QRCode.create(refLink, { errorCorrectionLevel: 'H' });
  const modules = qrData.modules;
  const size    = modules.size;
  const CELL    = 8;
  const qrPx    = size * CELL;
  const PAD     = 16;

  const W = 500;

  // Posiciones verticales del layout
  const qrBoxY  = 290;
  const qrBoxH  = qrPx + PAD * 2;
  const qrActY  = qrBoxY + PAD;
  const qrLeft  = (W - qrPx) / 2;
  const codeY   = qrBoxY + qrBoxH + 38;
  const urlY    = codeY + 28;
  const H       = urlY + 36;

  // Construir rectángulos SVG del QR
  let rects = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(col, row)) {
        rects += `<rect x="${qrLeft + col * CELL}" y="${qrActY + row * CELL}" width="${CELL}" height="${CELL}" fill="#F0C040"/>`;
      }
    }
  }

  // Líneas de red diagonal (decoración)
  let netLines = '';
  for (let i = -3; i < 14; i++) {
    const x1 = i * 65 - 80, y1 = 0, x2 = x1 + H * 0.6, y2 = H;
    const op = (0.04 + (i % 3 === 0 ? 0.03 : 0)).toFixed(2);
    netLines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#38BDF8" stroke-width="1" opacity="${op}"/>`;
  }
  for (let j = -2; j < 10; j++) {
    const x1 = 0, y1 = j * 80 - 40, x2 = W, y2 = y1 + W * 0.5;
    netLines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#38BDF8" stroke-width="1" opacity="0.04"/>`;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#060C14"/>
      <stop offset="100%" stop-color="#0A1A2F"/>
    </linearGradient>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="14"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)" rx="14"/>
  <g clip-path="url(#card)">${netLines}</g>
  <rect width="${W}" height="${H}" fill="none" stroke="#16283F" stroke-width="2" rx="14"/>

  <!-- RETAUX -->
  <text x="${W / 2}" y="72" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="48" font-weight="bold" letter-spacing="2">
    <tspan fill="#38BDF8">RE</tspan><tspan fill="#F0C040">TAUX</tspan>
  </text>

  <!-- Subtitle -->
  <text x="${W / 2}" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#8A97A8" letter-spacing="3">TAX RETURNS · AUSTRALIA</text>

  <!-- Gold divider -->
  <line x1="${W / 2 - 48}" y1="116" x2="${W / 2 + 48}" y2="116" stroke="#F0C040" stroke-width="1.5"/>

  <!-- "YOUR FRIENDS GET" label -->
  <text x="${W / 2}" y="156" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#8A97A8" letter-spacing="2">YOUR FRIENDS GET</text>

  <!-- AUD 30 OFF -->
  <text x="${W / 2}" y="218" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="52" font-weight="bold" fill="#F0C040">AUD 30 OFF</text>

  <!-- sub-label -->
  <text x="${W / 2}" y="242" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#5C6B7D" letter-spacing="1">WHEN THEY SCAN YOUR CODE</text>

  <!-- QR box -->
  <rect x="${qrLeft - PAD}" y="${qrBoxY}" width="${qrPx + PAD * 2}" height="${qrBoxH}" fill="#0E1A2B" rx="10" stroke="#16283F" stroke-width="1"/>
  ${rects}

  <!-- Referral code -->
  <text x="${W / 2}" y="${codeY}" text-anchor="middle" font-family="'Courier New',Courier,monospace" font-size="20" font-weight="bold" fill="#38BDF8" letter-spacing="4">${refCode}</text>

  <!-- URL -->
  <text x="${W / 2}" y="${urlY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#3E4A59" letter-spacing="1">www.retaux.com</text>
</svg>`;

  const pngBuf = await sharp(Buffer.from(svg)).png().toBuffer();
  return pngBuf.toString('base64');
}

async function sendReferrerWelcomeEmail(referrer) {
  const templatePath = path.join(__dirname, '..', 'templates', 'referrer-welcome.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  const firstName = referrer.fullName.split(' ')[0];
  const refLink   = `${BASE}/register?ref=${referrer.referralCode}`;

  const qrBase64 = await generateStyledQRCard(refLink, referrer.referralCode);

  html = html.replace(/\{\{referrerName\}\}/g, firstName);
  html = html.replace(/\{\{dashboardUrl\}\}/g, `${BASE}/referrer`);

  await sendMail({
    to: referrer.email,
    subject: 'Welcome to RETAUX Referrals — your account is live',
    html,
    text: `Hi ${firstName},\n\nYour RETAUX referrer account is live.\nReferral link: ${refLink}\nDashboard: ${BASE}/referrer\n\nRETAUX · hola@retaux.com`,
    attachments: [{
      name: `RETAUX-QR-${referrer.referralCode}.png`,
      content: qrBase64
    }]
  });
}

async function sendSuperPaymentPendingNotification(user) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'en';
  const strings = JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${lang}.json`), 'utf8'));
  const t = strings.super;
  const firstName = user.fullName.split(' ')[0];
  const subjects = { es: '✅ Declaraste tu pago de Superannuation (DASP)', en: '✅ Superannuation (DASP) payment declared', fr: '✅ Paiement superannuation déclaré', it: '✅ Pagamento superannuation dichiarato' };
  await sendMail({
    to: [{ email: user.email, name: user.fullName }],
    subject: subjects[lang] || subjects.en,
    html: LAYOUT(`
      ${H1(t.pending_h1)}
      ${P(`Hola <strong>${firstName}</strong>,`)}
      ${P(t.pending_sub.replace ? t.pending_sub : t.pending_sub)}
      ${INFO_BOX(`<p style="margin:0;font-size:14px;color:#1a4a7a;font-weight:600;">${t.pending_next}</p>
        <ol style="margin:10px 0 0;padding-left:20px;font-size:14px;color:#1a4a7a;line-height:2;">
          <li>${t.pending_step1}</li>
          <li>${t.pending_step2}</li>
          <li>${t.pending_step3}</li>
        </ol>`)}
      ${BTN(BASE + '/super/pending', lang === 'es' ? 'Ver estado' : lang === 'fr' ? 'Voir le statut' : lang === 'it' ? 'Vedi stato' : 'View status')}
    `)
  });
}

async function sendSuperPaymentReceipt(user) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'en';
  const strings = JSON.parse(fs.readFileSync(path.join(__dirname, `../locales/${lang}.json`), 'utf8'));
  const t = strings.super;
  const firstName = user.fullName.split(' ')[0];
  const subjects = { es: '🎉 Pago de Superannuation confirmado — RETAUX', en: '🎉 Superannuation payment confirmed — RETAUX', fr: '🎉 Paiement superannuation confirmé — RETAUX', it: '🎉 Pagamento superannuation confermato — RETAUX' };
  await sendMail({
    to: [{ email: user.email, name: user.fullName }],
    subject: subjects[lang] || subjects.en,
    html: LAYOUT(`
      ${H1(t.done_h1)}
      ${P(`Hola <strong>${firstName}</strong>, ${t.done_sub}`)}
      ${INFO_BOX(`<p style="margin:0;font-size:14px;color:#1a4a7a;font-weight:600;">${t.done_next}</p>
        <ol style="margin:10px 0 0;padding-left:20px;font-size:14px;color:#1a4a7a;line-height:2;">
          <li>${t.done_step1}</li>
          <li>${t.done_step2}</li>
          <li>${t.done_step3}</li>
        </ol>`)}
      ${BTN(BASE + '/super/done', lang === 'es' ? 'Ver mi trámite' : lang === 'fr' ? 'Voir ma demande' : lang === 'it' ? 'Vedi la mia richiesta' : 'View my claim')}
    `)
  });
}

async function sendConsentRequest(user) {
  const lang = ['es','en','fr','it'].includes(user.lang) ? user.lang : 'es';
  const firstName = (user.fullName || user.email).split(' ')[0];
  const consentUrl = `${BASE}/consent`;

  const subjects = {
    es: '✍️ Tu firma es requerida — RETAUX',
    en: '✍️ Your signature is required — RETAUX',
    fr: '✍️ Votre signature est requise — RETAUX',
    it: '✍️ La tua firma è richiesta — RETAUX',
  };

  const greetings = {
    es: `Hola ${firstName}, para continuar con la gestión de tu tax return necesitamos que firmes una autorización de acceso ante la ATO.`,
    en: `Hi ${firstName}, to proceed with your tax return we need you to sign an ATO access authorisation.`,
    fr: `Bonjour ${firstName}, pour continuer avec votre déclaration fiscale, nous avons besoin que vous signiez une autorisation d'accès à l'ATO.`,
    it: `Ciao ${firstName}, per procedere con la tua dichiarazione dei redditi abbiamo bisogno che tu firmi un'autorizzazione di accesso all'ATO.`,
  };

  const bodies = {
    es: 'Esta firma nos autoriza a agregar un agente impositivo registrado a tu cuenta de la ATO en tu nombre, sin necesidad de que compartas tu usuario, contraseña ni código de verificación.',
    en: 'This signature authorises us to add a registered tax agent to your ATO account on your behalf, without requiring you to share your username, password or verification code.',
    fr: "Cette signature nous autorise à ajouter un agent fiscal enregistré à votre compte ATO en votre nom, sans que vous ayez à partager votre identifiant, mot de passe ou code de vérification.",
    it: 'Questa firma ci autorizza ad aggiungere un agente fiscale registrato al tuo account ATO per tuo conto, senza che tu debba condividere il tuo nome utente, la password o il codice di verifica.',
  };

  const btnLabels = {
    es: 'Firmar autorización →',
    en: 'Sign authorisation →',
    fr: 'Signer l\'autorisation →',
    it: 'Firma l\'autorizzazione →',
  };

  const footers = {
    es: 'Si ya firmaste o tenés alguna duda, respondé a este correo y te ayudamos.',
    en: 'If you have already signed or have any questions, reply to this email and we\'ll help you.',
    fr: 'Si vous avez déjà signé ou si vous avez des questions, répondez à cet e-mail et nous vous aiderons.',
    it: 'Se hai già firmato o hai domande, rispondi a questa email e ti aiuteremo.',
  };

  return sendMail({
    to: user.email,
    subject: subjects[lang],
    html: LAYOUT(`
      <p style="font-size:16px;color:#1a2430;margin:0 0 16px;">${greetings[lang]}</p>
      <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 24px;">${bodies[lang]}</p>
      ${BTN(consentUrl, btnLabels[lang])}
      <p style="font-size:13px;color:#718096;margin-top:24px;">${footers[lang]}</p>
    `)
  });
}

module.exports = { sendWelcomeVerification, sendPaymentReceipt, sendPaymentPendingNotification, sendPaymentRejectedNotification, sendReferralCode, sendPasswordReset, sendAppointmentConfirmation, sendReferrerWelcomeEmail, sendSuperPaymentPendingNotification, sendSuperPaymentReceipt, sendConsentRequest };
