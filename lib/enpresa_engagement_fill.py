"""
Superpone datos del cliente sobre el nuevo Engagement Letter template.
El PDF ya está limpio — solo escribimos encima de los campos vacíos.
Uso: python3 enpresa_engagement_fill.py base.pdf data.json output.pdf
"""
import sys, json
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import white, black
import io

BASE_PDF  = sys.argv[1]
DATA_JSON = sys.argv[2]
OUT_PDF   = sys.argv[3]

with open(DATA_JSON) as f:
    d = json.load(f)

W, H = A4  # 595.28 x 841.89

def rl_y(pdf_top):
    return H - pdf_top

def make_overlay(page_num):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFillColor(white)
    c.rect(0, 0, 0.1, 0.1, fill=1, stroke=0)  # garantiza content stream

    def put(x, top, text, size=11, bold=False):
        if not text:
            return
        c.setFillColor(black)
        c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        c.drawString(x, rl_y(top), str(text))

    if page_num == 0:
        # ── Página 1 ─────────────────────────────────────────────────────
        # Cuadrante celeste Client Name: x0=118.1, x1=511.1, top=127.8, bot=141.6
        # Centro horizontal: 314.6  |  baseline vertical: bot - 3.5 = 138.1
        c.setFillColor(black)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(314.6, rl_y(138.1), d.get('fullName', ''))

        # Cuadrante celeste ABN: x0=118.1, x1=511.1, top=149.7, bot=163.5
        # Solo si el cliente tiene ABN
        if d.get('abn'):
            c.setFont("Helvetica", 11)
            c.drawCentredString(314.6, rl_y(159.8), d.get('abn', ''))

    elif page_num == 1:
        # ── Página 2 — ACKNOWLEDGMENT ────────────────────────────────────
        # "Name:" top=322.2, x0=40  → dato desde x=88
        # "Date:" top=322.2, x0=330 → dato desde x=368
        # "Signature:" top=363.4, x0=40 → firma desde x=110

        put(88,  325, d.get('sigName', ''), size=10, bold=True)
        put(368, 325, d.get('sigDate', ''), size=10)

        # Firma: nombre en bold + línea "Firmado digitalmente"
        put(110, 366, d.get('sigName', ''), size=10, bold=True)
        if d.get('sigAt'):
            put(110, 378, 'Firmado digitalmente — ' + d.get('sigAt', ''), size=7.5)

    # Páginas 3-5: sin cambios
    c.save()
    buf.seek(0)
    return buf

reader = PdfReader(BASE_PDF)
writer = PdfWriter()

for i, page in enumerate(reader.pages):
    ov_buf  = make_overlay(i)
    ov_page = PdfReader(ov_buf).pages[0]
    page.merge_page(ov_page)
    writer.add_page(page)

with open(OUT_PDF, 'wb') as f:
    writer.write(f)
