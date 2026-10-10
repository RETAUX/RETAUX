"""
Superpone datos del cliente sobre el PDF original ENPRESA-TAA.
Uso: python3 enpresa_fill.py base.pdf data.json output.pdf
"""
import sys, json
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import white, black
import io

BASE_PDF = sys.argv[1]
DATA_JSON = sys.argv[2]
OUT_PDF   = sys.argv[3]

with open(DATA_JSON) as f:
    d = json.load(f)

W, H = A4  # 595.28 x 841.89

def rl_y(pdf_top):
    """Coordenada pdfplumber (top=0) → ReportLab (bottom=0)."""
    return H - pdf_top

def make_overlay(page_num):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)

    def white_rect(x0, top, x1, bot):
        c.setFillColor(white)
        c.setStrokeColor(white)
        c.rect(x0, rl_y(bot) - 0.5, x1 - x0, bot - top + 1, fill=1, stroke=0)

    def put(x, top, bot, text, size=9.0, bold=False):
        if not text:
            return
        c.setFillColor(black)
        c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
        c.drawString(x, rl_y(bot) + 2, str(text))

    def cross(cx, cy_top, cy_bot):
        """Dibuja X dentro del casillero. Checkbox real: 8.58 × 9.96 pt."""
        c.setFillColor(black)
        c.setStrokeColor(black)
        c.setLineWidth(0.8)
        pad = 2.0          # margen interior para que la X no toque el borde
        x0 = cx + pad
        x1 = cx + 8.58 - pad
        y0 = rl_y(cy_bot) + pad
        y1 = rl_y(cy_top) - pad
        c.line(x0, y0, x1, y1)
        c.line(x0, y1, x1, y0)

    # Helpers de datos
    ded         = d.get('ded', {})
    has_emp     = bool(d.get('empName1', ''))
    multi_emp   = d.get('multiEmp', False)
    has_abn     = d.get('hasAbn', False)
    has_phi     = d.get('hasPhi', False)
    has_visa    = d.get('hasVisa', False)
    has_spouse  = d.get('hasSpouse', False)
    has_foreign = d.get('hasForeign', False)
    is_au_res   = not has_foreign

    # ─── Posiciones exactas de checkbox (medidas con pdfplumber) ────────────
    # Col izquierda Section 3/4:  YES_x=235.97, NO_x=263.45
    # Col izquierda Section 5:    YES_x=235.97, NO_x=263.45
    # Col derecha Section 5/6:    YES_x=518.14, NO_x=545.62
    # Col izquierda p2:           YES_x=234.0,  NO_x=262.0
    # Altura real de cada ☐: 9.96 pt
    YES_L, NO_L = 235.97, 263.45   # col izquierda
    YES_R, NO_R = 518.14, 545.62   # col derecha

    if page_num == 0:
        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 1 – DATOS PERSONALES
        # ═══════════════════════════════════════════════════════════════════

        white_rect(142, 85.5, 300, 95)
        put(144, 85.5, 95, d.get('fullName', ''))

        white_rect(142, 95.5, 215, 105)
        put(144, 95.5, 105, d.get('preferredName', ''))

        white_rect(142, 105.5, 200, 115)
        put(144, 105.5, 115, d.get('dob', ''))

        white_rect(142, 115.5, 190, 125)
        put(144, 115.5, 125, d.get('gender', ''))

        white_rect(142, 125.5, 205, 135)
        put(144, 125.5, 135, d.get('countryBirth', ''))

        white_rect(142, 135.5, 205, 145)
        put(144, 135.5, 145, d.get('citizenship', ''))

        white_rect(142, 145.5, 220, 155)
        put(144, 145.5, 155, d.get('occupation', ''))

        white_rect(142, 155.5, 235, 165)
        put(144, 155.5, 165, d.get('empName1', ''))

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 2 – DIRECCIÓN
        # ═══════════════════════════════════════════════════════════════════

        white_rect(142, 193.5, 300, 203)
        put(144, 193.5, 203, d.get('address', ''))

        white_rect(142, 203.5, 215, 213)
        put(144, 203.5, 213, d.get('suburb', ''))

        white_rect(142, 214.5, 200, 222.5)
        put(144, 214.5, 222.5, d.get('state', ''))

        white_rect(142, 224.5, 185, 232.5)
        put(144, 224.5, 232.5, d.get('postcode', ''))

        # Postal address (if different) — en blanco (mismo que el residencial)
        white_rect(142, 232.5, 310, 242.5)

        # Email address — top label=242.6, valor en x=144, top≈243
        white_rect(142, 242.5, 310, 253)
        put(144, 242.5, 253, d.get('email', ''))

        # Mobile phone — top label=252.6, valor en x=144, top≈253
        white_rect(142, 253, 220, 263)
        put(144, 253, 263, d.get('mobile', ''))

        # Home phone y work phone — en blanco (sin datos)
        white_rect(142, 263, 190, 283)

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 3 – RESIDENCIA Y VISA
        # Coords exactas: YES_L=235.97, NO_L=263.45  bot = top + 9.96
        # ═══════════════════════════════════════════════════════════════════

        # "Australian resident for tax purposes?" top=291.36
        white_rect(233, 290, 275, 302)
        cross(YES_L if is_au_res else NO_L, 291.36, 301.32)

        # "Resided in Australia for the full income year?" top=301.34
        white_rect(233, 300, 275, 312)
        cross(YES_L if is_au_res else NO_L, 301.34, 311.30)

        # "Any periods of foreign residency during the year?" top=320.54
        white_rect(233, 319, 275, 331)
        cross(YES_L if has_foreign else NO_L, 320.54, 330.50)

        # "Hold a visa other than citizenship or permanent residency?" top=339.12
        white_rect(233, 338, 275, 350)
        cross(YES_L if has_visa else NO_L, 339.12, 349.08)

        # Visa subclass value — top≈360
        white_rect(98, 358, 290, 369)
        if d.get('visaSubclass'):
            put(100, 358, 369, d.get('visaSubclass', ''))

        # "Any foreign income or assets during the year?" top=367.80
        white_rect(233, 367, 275, 378)
        cross(YES_L if has_foreign else NO_L, 367.80, 377.76)

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 4 – CÓNYUGE
        # ═══════════════════════════════════════════════════════════════════

        # "Spouse at any time during the year?" top=387.38
        white_rect(233, 386, 275, 398)
        cross(YES_L if has_spouse else NO_L, 387.38, 397.34)

        # Spouse name (nombre de Estiguan en top≈416-434)
        white_rect(142, 414, 290, 435)
        if has_spouse and d.get('spouseName', ''):
            put(144, 414, 427, d.get('spouseName', ''))

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 5 – INGRESOS (col derecha): Business Income
        # YES_R=518.14, NO_R=545.62  bot = top + 9.96
        # ═══════════════════════════════════════════════════════════════════

        cross(YES_R if has_abn else NO_R, 233.0, 242.96)   # Business income sole trader
        cross(YES_R if has_abn else NO_R, 251.8, 261.76)   # BAS obligation

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 5 – INGRESOS (col izquierda, fondo)
        # YES_L=235.97, NO_L=263.45
        # ═══════════════════════════════════════════════════════════════════

        # "Salary or wages from employment?" top=474 / top=560
        cross(YES_L if has_emp else NO_L, 559.6, 569.56)

        # "More than one employer during the year?" top=633
        cross(YES_L if multi_emp else NO_L, 632.9, 642.86)

        # ═══════════════════════════════════════════════════════════════════
        # LISTA DE EMPLEADORES (col izquierda, tops ≈579-632)
        # ═══════════════════════════════════════════════════════════════════

        emp_data = [
            ('empName1', 35, 579, 589),
            ('empName2', 35, 590, 600),
            ('empName3', 35, 601, 611),
            ('empName4', 35, 612, 622),
            ('empName5', 35, 623, 632),
        ]
        for key, ex, et, eb in emp_data:
            val = d.get(key, '')
            if val:
                white_rect(ex, et, 290, eb)
                put(ex + 2, et, eb, val, 7)

        # ═══════════════════════════════════════════════════════════════════
        # SECCIÓN 6 – DEDUCCIONES (col derecha)
        # YES_R=518.14, NO_R=545.62  — marcamos YES o NO según datos
        # ═══════════════════════════════════════════════════════════════════

        has_clothing = bool(ded.get('d4') or ded.get('d1'))
        has_laundry  = bool(ded.get('d4'))
        has_selfedu  = bool(ded.get('d5'))
        has_memb     = bool(ded.get('d5') or ded.get('d6'))
        has_phone    = bool(ded.get('d1') or ded.get('d6'))
        has_internet = bool(ded.get('d1') or ded.get('d6'))
        has_wfh      = bool(ded.get('d1'))
        has_tools    = bool(ded.get('d1') or ded.get('d6'))
        has_vehicle  = bool(ded.get('d2'))
        has_travel   = bool(ded.get('d3'))
        has_other    = bool(ded.get('d6'))

        cross(YES_R if has_clothing else NO_R, 497.9,  507.86)  # Clothing/uniform
        cross(YES_R if has_laundry  else NO_R, 507.3,  517.26)  # Laundry
        cross(YES_R if has_selfedu  else NO_R, 516.7,  526.66)  # Self-education
        cross(YES_R if has_memb     else NO_R, 525.5,  535.46)  # Professional memberships
        cross(YES_R if has_phone    else NO_R, 535.6,  545.56)  # Phone
        cross(YES_R if has_internet else NO_R, 554.8,  564.76)  # Internet
        cross(YES_R if has_wfh      else NO_R, 583.6,  593.56)  # Work from home
        cross(YES_R if has_tools    else NO_R, 602.9,  612.86)  # Tools/equipment
        cross(YES_R if has_vehicle  else NO_R, 621.6,  631.56)  # Vehicle
        cross(YES_R if has_travel   else NO_R, 640.0,  649.96)  # Work-related travel
        cross(YES_R if has_phi      else NO_R, 649.4,  659.36)  # Income protection insurance
        cross(YES_R if has_other    else NO_R, 668.3,  678.26)  # Any other work-related

    elif page_num == 1:
        # ═══════════════════════════════════════════════════════════════════
        # PÁGINA 2 – SECCIÓN 7 – SEGUROS Y OFFSETS
        # "Private health insurance (hospital cover) at any time?" top=237
        # YES=234.0, NO=262.0  (medidos en sesión anterior)
        # ═══════════════════════════════════════════════════════════════════

        cross(234.0 if has_phi else 262.0, 237.0, 246.96)

        # ═══════════════════════════════════════════════════════════════════
        # PÁGINA 2 – SECCIÓN 12 – DATOS BANCARIOS (col derecha)
        # Account holder name: top=279.9, data en x≈428
        # BSB: top=289.8 | Account number: top=299.8 | Bank name: top=309.7
        # ═══════════════════════════════════════════════════════════════════

        if d.get('bankAccountName'):
            white_rect(425, 278, 590, 290)
            put(428, 278, 290, d.get('bankAccountName', ''), size=8)
        if d.get('bsb'):
            white_rect(425, 288, 590, 300)
            put(428, 288, 300, d.get('bsb', ''), size=8)
        if d.get('accountNumber'):
            white_rect(425, 298, 590, 310)
            put(428, 298, 310, d.get('accountNumber', ''), size=8)
        if d.get('bankName'):
            white_rect(425, 308, 590, 320)
            put(428, 308, 320, d.get('bankName', ''), size=8)

        # ═══════════════════════════════════════════════════════════════════
        # PÁGINA 2 – DECLARACIÓN DEL CLIENTE
        # "Client Full Name:" x1=123, top=724.4
        # "Date:" x1=372.9, top=724.4
        # "(e)Signature:" x1=107.3, top=757.9
        # ═══════════════════════════════════════════════════════════════════

        white_rect(126, 720, 348, 733)
        put(130, 720, 733, d.get('sigName', ''), size=8, bold=True)

        white_rect(376, 720, 578, 733)
        put(378, 720, 733, d.get('sigDate', ''), size=8)

        if d.get('sigAt'):
            white_rect(112, 754, 580, 778)
            put(115, 754, 767, d.get('sigName', ''), size=8, bold=True)
            put(115, 766, 778, 'Firmado digitalmente — ' + d.get('sigAt', ''), size=6.5)

    c.save()
    buf.seek(0)
    return buf

# ── Fusionar overlay con PDF base ─────────────────────────────────────────────
reader = PdfReader(BASE_PDF)
writer = PdfWriter()

for i, page in enumerate(reader.pages):
    overlay_buf = make_overlay(i)
    overlay_reader = PdfReader(overlay_buf)
    overlay_page = overlay_reader.pages[0]
    page.merge_page(overlay_page)
    writer.add_page(page)

with open(OUT_PDF, 'wb') as f:
    writer.write(f)
