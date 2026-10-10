const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const RECEIPTS_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

function buildReceiptHtml(user, payment) {
  const invoiceNo   = 'RTX-' + (payment.id || '').slice(0, 8).toUpperCase();
  const amountAUD   = ((payment.amountCents || 12000) / 100).toFixed(2);
  const paidDate    = new Date(payment.paidAt || Date.now()).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const taxYear     = payment.taxYear || '2024-25';
  const firstName   = (user.fullName || user.email).split(' ')[0];

  const discountRow = payment.discountApplied ? `
    <tr>
      <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;color:#1a2430;">
        <span style="display:inline-block;background:#eaf7ff;color:#060C14;font-weight:700;padding:4px 10px;border-radius:6px;">Referral discount</span>
      </td>
      <td style="padding:12px 4px;border-bottom:1px solid #eef1f4;font-size:14px;text-align:right;color:#16a34a;font-weight:600;">- AUD 20.00</td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RETAUX — Receipt ${invoiceNo}</title>
</head>
<body style="margin:0;padding:30px;background:#f4f6f8;font-family:Arial,sans-serif;color:#1a2430;">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">

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

  <div style="padding:32px;">

    <div style="background:#e0f4ff;border-left:4px solid #38BDF8;padding:16px 20px;border-radius:6px;margin-bottom:28px;font-size:14px;line-height:1.6;color:#1a2430;">
      Hi ${firstName}! Your payment has been confirmed. Please keep this email as your official receipt — we're already working on your tax return.
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td style="vertical-align:top;padding-right:16px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Billed To</p>
          <p style="margin:0;font-size:14px;line-height:1.5;">${user.fullName || ''}<br><span style="color:#7a8a9a;">${user.email}</span></p>
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

    <div style="margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#7a8a9a;">Issued By</p>
      <p style="margin:0;font-size:14px;line-height:1.7;">Ghada Charbine — Registered Tax Agent (TPB No. 65195004)<br>
      ABN 58 624 412 713<br>
      On behalf of RETAUX &nbsp;|&nbsp; hola@retaux.com &nbsp;|&nbsp; www.retaux.com</p>
    </div>

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
            <span style="display:inline-block;background:#eaf7ff;color:#060C14;font-weight:700;padding:4px 10px;border-radius:6px;">AUD 120.00</span>
          </td>
        </tr>
        ${discountRow}
      </tbody>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#060C14;border-radius:8px;margin-top:10px;">
      <tr>
        <td style="padding:18px 22px;color:#8fa3b8;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Total Paid</td>
        <td style="padding:18px 22px;text-align:right;color:#F0C040;font-size:24px;font-weight:700;">AUD ${amountAUD}</td>
      </tr>
    </table>

    <div style="margin-top:24px;padding:16px 20px;border:1px solid #eef1f4;border-radius:8px;background:#fafbfc;">
      <p style="margin:0 0 10px;font-size:12px;text-transform:uppercase;color:#7a8a9a;letter-spacing:0.5px;">Registered Tax Agent</p>
      <p style="margin:0;font-size:14px;line-height:1.7;">
        Ghada Charbine<br>
        Tax Practitioners Board (TPB) Registration No. 65195004<br>
        Return prepared, reviewed, and lodged with the Australian Taxation Office (ATO).
      </p>
    </div>

    <div style="background:#fff8e6;border-left:4px solid #F0C040;padding:14px 16px;border-radius:6px;font-size:13px;color:#5a4a10;margin-top:24px;line-height:1.6;">
      This document confirms receipt of payment for tax return services provided through RETAUX. Tax compliance review and lodgement are performed exclusively by the Registered Tax Agent named above, in accordance with the Tax Agent Services Act 2009 (TASA).
    </div>

  </div>

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
}

async function generateReceiptPdf(user, payment) {
  const invoiceNo = 'RTX-' + (payment.id || '').slice(0, 8).toUpperCase();
  const paidDate  = new Date(payment.paidAt || Date.now()).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
  const filename  = `${invoiceNo}_${paidDate}.pdf`;
  const filepath  = path.join(RECEIPTS_DIR, filename);

  if (fs.existsSync(filepath)) return filepath; // ya existe, no regenerar

  const html = buildReceiptHtml(user, payment);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: filepath,
      format: 'A4',
      printBackground: true,
      margin: { top: '6mm', bottom: '6mm', left: '6mm', right: '6mm' },
      scale: 0.72
    });
  } finally {
    await browser.close();
  }

  console.log(`[PDF] Receipt saved: ${filename}`);
  return filepath;
}

module.exports = { generateReceiptPdf };
