"""
Genera PDFs del "MES Application" (carta de Medicare Entitlement Statement)
por cada cliente del CSV, reemplazando nombre, fecha y número de aplicación.

Uso: python scripts/fill-mes-letter.py
Salida: exports/MES_Letters/aplication {numero} {nombre}.pdf
"""

import csv
import os
import re
import io
import random
from datetime import date, timedelta
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter as LETTER

SOURCE_PDF = '/Users/bquagliarella/Downloads/MES Application - 4149728.pdf'
CSV_FILE   = os.path.join(os.path.dirname(__file__), '..', 'exports', 'MS015_2026-10-16.csv')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'exports', 'MES_Letters')

os.makedirs(OUTPUT_DIR, exist_ok=True)

PAGE_W, PAGE_H = 612, 792   # letter size en puntos

# Corrección de nombres (igual que fill-ms015.py)
DISPLAY_NAME_OVERRIDES = {
    'carlosor95@hotmail.com':     'Carlos Augusto Ortega Rodriguez',
    'betsabe.chica.20@gmail.com': 'Betsabe Chica Peralta',
}

def fix_name(name, email=''):
    if name in DISPLAY_NAME_OVERRIDES:
        return DISPLAY_NAME_OVERRIDES[name]
    if email.lower().strip() in DISPLAY_NAME_OVERRIDES:
        return DISPLAY_NAME_OVERRIDES[email.lower().strip()]
    if ',' in name:
        parts = [p.strip() for p in name.split(',', 1)]
        return f'{parts[1]} {parts[0]}'
    return name

def random_date_aug_oct():
    """Fecha aleatoria entre 10 Ago y 10 Oct 2026."""
    start = date(2026, 8, 10)
    end   = date(2026, 10, 10)
    delta = (end - start).days
    return start + timedelta(days=random.randint(0, delta))

MONTHS_EN = ['January','February','March','April','May','June',
             'July','August','September','October','November','December']

def fmt_date(d):
    return f'{d.day} {MONTHS_EN[d.month - 1]} {d.year}'

def parse_address(addr):
    """Devuelve (linea1, linea2) para el bloque de dirección."""
    if not addr:
        return '', ''
    parts = [p.strip() for p in addr.split(',')]
    if len(parts) >= 2:
        return parts[0], ', '.join(parts[1:])
    return addr, ''

def sanitize_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name).strip()

def rl_y(pdfplumber_top):
    """Convierte coordenada top de pdfplumber a y de reportlab (de abajo)."""
    return PAGE_H - pdfplumber_top

def make_overlay(name_upper, addr1, addr2, date_str, app_num_str):
    """Crea un PDF de una página con las superposiciones de texto."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    c.setFont('Helvetica', 10)

    # Posiciones base (top del texto en pdfplumber → baseline en reportlab ≈ bottom)
    DATE_Y      = rl_y(110.7)    # "12 September 2026"
    NAME_Y      = rl_y(164.0)    # "Mr ESTIGUAN..."
    ADDR2_Y     = rl_y(176.0)    # "U 1 2 BALLARAT RD"
    ADDR3_Y     = rl_y(187.9)    # "FOOTSCRAY VIC 3011"
    APPNUM_Y    = rl_y(187.9)    # "4149728" (misma línea)
    DEAR_Y      = rl_y(267.5)    # "Dear Mr ESTIGUAN..."

    LINE_H = 12   # altura de línea para las cajas blancas

    # Función helper: cuadro blanco + texto
    def replace_text(x, y, width, text, bold=False, size=10.3):
        c.setFillColorRGB(1, 1, 1)
        c.rect(x, y - 1, width, LINE_H, fill=1, stroke=0)
        c.setFillColorRGB(0, 0, 0)
        font = 'Helvetica-Bold' if bold else 'Helvetica'
        c.setFont(font, size)
        c.drawString(x, y, text)

    # 1. Fecha
    replace_text(92.7, DATE_Y, 160, date_str)

    # 2. Nombre (línea 1 del bloque de dirección)
    # Ancho máximo 295 para no solapar con "Application number:" que arranca en x≈400
    replace_text(92.7, NAME_Y, 295, name_upper)

    # 3. Dirección línea 1
    # Máximo x=387 para no solapar con "Application number:" que arranca en x≈400
    replace_text(92.7, ADDR2_Y, 295, addr1.upper() if addr1 else '')

    # 4. Dirección línea 2 + número de aplicación
    replace_text(92.7, ADDR3_Y, 295, addr2.upper() if addr2 else '')
    # Cubrir TODO "Application number: XXXXXXX" y redibujarlo de una sola vez
    # para que quede en la misma tipografía y alineación que el resto de la línea
    replace_text(400.9, APPNUM_Y, 145, f'Application number: {app_num_str}')

    # 5. Línea "Dear ..."
    replace_text(92.7, DEAR_Y, 480, f'Dear {name_upper}')

    c.save()
    buf.seek(0)
    return buf

def generate_pdf(name_upper, addr1, addr2, date_str, app_num_str, output_path):
    overlay_buf = make_overlay(name_upper, addr1, addr2, date_str, app_num_str)
    overlay_reader = PdfReader(overlay_buf)
    source_reader  = PdfReader(SOURCE_PDF)

    writer = PdfWriter()
    base_page    = source_reader.pages[0]
    overlay_page = overlay_reader.pages[0]

    base_page.merge_page(overlay_page)
    writer.add_page(base_page)

    with open(output_path, 'wb') as f:
        writer.write(f)

# ── Leer CSV ──────────────────────────────────────────────────────────────────
with open(CSV_FILE, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))

# Generar números de aplicación únicos con diferencia mínima de 354
# Arrancamos desde un número base similar al original
random.seed(42)  # reproducible
app_base = 4150000
app_numbers = []
current = app_base
for _ in range(100):  # más que suficiente
    current += random.randint(354, 800)
    app_numbers.append(current)

processed = set()
ok_count  = 0
errors    = []
app_idx   = 0

for row in rows:
    raw_name  = (row.get('Nombre completo') or '').strip()
    email     = (row.get('Email') or '').strip()
    full_name = fix_name(raw_name, email)

    if not full_name or full_name in processed:
        continue
    processed.add(full_name)

    address = (row.get('Dirección residencial') or '').strip()
    addr1, addr2 = parse_address(address)

    d        = random_date_aug_oct()
    date_str = fmt_date(d)
    app_num  = app_numbers[app_idx]
    app_idx += 1

    name_upper = full_name.upper()
    safe_name  = sanitize_filename(full_name)
    out_file   = os.path.join(OUTPUT_DIR, f'aplication {app_num} {safe_name}.pdf')

    try:
        generate_pdf(name_upper, addr1, addr2, date_str, str(app_num), out_file)
        ok_count += 1
        print(f'  ✓  [{app_num}]  {full_name}  ({date_str})')
    except Exception as e:
        errors.append((full_name, str(e)))
        print(f'  ✗  {full_name}: {e}')

print(f'\n=== RESUMEN ===')
print(f'PDFs generados: {ok_count}')
print(f'Errores:        {len(errors)}')
print(f'Carpeta: {os.path.abspath(OUTPUT_DIR)}')
