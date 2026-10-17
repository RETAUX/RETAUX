"""
Genera un PDF MS015 pre-rellenado por cada cliente del CSV.
Uso: python scripts/fill-ms015.py
Salida: exports/MS015_PDFs/aplication to MES_{nombre}.pdf
"""

import csv
import os
import re
from pypdf import PdfReader, PdfWriter

SOURCE_PDF = '/Users/bquagliarella/Downloads/ms015-2609-f.pdf'
CSV_FILE   = os.path.join(os.path.dirname(__file__), '..', 'exports', 'MS015_2026-10-16.csv')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'exports', 'MS015_PDFs')

os.makedirs(OUTPUT_DIR, exist_ok=True)

TA_COMPANY = 'RETAUX'
TA_PERSON  = 'Bruno Quagliarella'
TA_PHONE   = '0418531969'

# Cuando la DB no tiene fullName guardamos el email como nombre → corregir acá
DISPLAY_NAME_OVERRIDES = {
    'carlosor95@hotmail.com':          'Carlos Augusto Ortega Rodriguez',
    'betsabe.chica.20@gmail.com':      'Betsabe Chica Peralta',
}

# Nombres con formato incorrecto en DB ("Apellido, Nombre") → reordenar
def fix_name(name, email=''):
    # Override por email (campo fullName es el email en la DB)
    if name in DISPLAY_NAME_OVERRIDES:
        return DISPLAY_NAME_OVERRIDES[name]
    # Override por email cuando el campo fullName no está bien
    email_key = email.lower().strip()
    if email_key in DISPLAY_NAME_OVERRIDES:
        return DISPLAY_NAME_OVERRIDES[email_key]
    # Formato "Apellido, Nombre" → "Nombre Apellido"
    if ',' in name:
        parts = [p.strip() for p in name.split(',', 1)]
        return f'{parts[1]} {parts[0]}'
    return name

def parse_dob(dob_str):
    parts = dob_str.strip().split()
    if len(parts) == 3:
        return parts[0], parts[1], parts[2]
    return '', '', ''

def parse_fy(fy_range):
    years = re.findall(r'\b(20\d{2})\b', fy_range)
    if len(years) >= 2:
        return years[0][-2:], years[1][-2:]
    return '', ''

def split_name(full_name):
    """Devuelve (family, first, second) para el formulario MS015."""
    parts = full_name.strip().split()
    if not parts:
        return '', '', ''
    if len(parts) == 1:
        return parts[0].upper(), '', ''
    if len(parts) == 2:
        return parts[1].upper(), parts[0].upper(), ''
    # 3+ palabras: primera = first given, última = family, resto = second given
    return parts[-1].upper(), parts[0].upper(), ' '.join(parts[1:-1]).upper()

def parse_address(address):
    """Intenta separar calle, ciudad/estado, postcode."""
    if not address:
        return '', '', '', ''
    postcode_match = re.search(r'\b(\d{4})\b', address)
    postcode = postcode_match.group(1) if postcode_match else ''
    # Separar por coma
    parts = [p.strip() for p in address.split(',')]
    a1 = parts[0] if len(parts) > 0 else address
    a2 = parts[1] if len(parts) > 1 else ''
    a3 = parts[2] if len(parts) > 2 else ''
    return a1, a2, a3, postcode

def sanitize_filename(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)

def fill_pdf(data: dict, output_path: str):
    reader = PdfReader(SOURCE_PDF)
    writer = PdfWriter()
    writer.append(reader)

    # Rellenar cada página con los campos disponibles
    for page in writer.pages:
        writer.update_page_form_field_values(page, data, auto_regenerate=False)

    with open(output_path, 'wb') as f:
        writer.write(f)

# ── Leer CSV ──────────────────────────────────────────────────────────────────
with open(CSV_FILE, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))

processed = set()
ok_count  = 0
errors    = []

for row in rows:
    raw_name  = (row.get('Nombre completo') or '').strip()
    email     = (row.get('Email') or '').strip()
    full_name = fix_name(raw_name, email)
    if not full_name or full_name in processed:
        continue
    processed.add(full_name)
    dob_str = (row.get('Fecha de nacimiento (DD MM YYYY)') or '').strip()
    address = (row.get('Dirección residencial') or '').strip()
    country = (row.get('Nacionalidad') or '').strip()
    fy_rng  = (row.get('Año fiscal') or '').strip()

    dd, mm, yyyy    = parse_dob(dob_str)
    family, first, second = split_name(full_name)
    fy1, fy2        = parse_fy(fy_rng)
    a1, a2, a3, pc  = parse_address(address)

    fields = {
        # Pregunta 1: ¿Es un agente impositivo? → Sí
        '1.Yes_No_TaxAgent':   '/Yes',
        # Pregunta 2: ¿El cliente da permiso al agente? → Sí
        '1.Yes_No_Permission': '/Yes',
        # Datos del agente
        '1.TA_NameCompany':    TA_COMPANY,
        '1.TA_NamePerson':     TA_PERSON,
        '1.TA_Phone':          TA_PHONE,
        '1.TA_Privacy':        '/Yes',       # Q4 — ha leído el aviso de privacidad
        # Q5 — ¿tiene Medicare? → No
        '1.App_MCcard':        '/No',
        # Q6 — nombre del solicitante
        '1.App_FamName':       family,
        '1.App_FirstGivName':  first,
        '1.App_SecondGivName': second,
        # Q8 — fecha de nacimiento (DD / MM / YYYY separados)
        '1.App_DOB1':          dd,
        '1.App_DOB2':          mm,
        '1.App_DOB3':          yyyy,
        # Q9 — contacto
        '1.App_Email1':        email,
        # Q10 — dirección residencial en Australia
        '1.App_Add2':          a1,
        '1.App_Add3':          a2,
        '1.App_Add4':          a3,
        '1.App_PC':            pc,
        # Q11 — dirección postal = igual a la residencial
        '1.App_TaxAddress':    '/Yes',
        # Q12 — ¿la dirección postal es la del agente? → No
        # (dejamos vacío — no hay campo explícito para Q12 No)
        # Q13 — país donde vivía antes de llegar a Australia
        '1.Eligibility_Country': country,
        # Q15 — ¿tiene seguro de salud extranjero? → No (default)
        '1.Eligibility_Yes_No_2': '/No',
        # Q16 — ¿es de Finlandia, Malta o Noruega? → No
        '1.Eligibility_Yes_No_3': '/No',
        # Q18 — ¿aplicó a residencia permanente? → No
        '1.Eligibility_Yes_No_4': '/No',
        # Q19 — ¿aplicó a parent visa? → No
        '1.Eligibility_YesNo2':   '/No',
        # Q20 — año fiscal de reclamo
        '1.FY1': fy1,
        '1.FY2': fy2,
        # Q21 — ¿sale de Australia permanentemente? → No
        '1.Claim_YesNo': '/No',
        # Q22 — documentos adjuntos: passport
        '1.Check_4': '/Yes',
        # Q24 — declaración
        '1.Dec_FullName':    full_name,
        '1.Dec_Declaration': '/Yes',
    }

    safe_name   = sanitize_filename(full_name)
    output_path = os.path.join(OUTPUT_DIR, f'aplication to MES_{safe_name}.pdf')

    try:
        fill_pdf(fields, output_path)
        ok_count += 1
        print(f'  ✓  {full_name}')
    except Exception as e:
        errors.append((full_name, str(e)))
        print(f'  ✗  {full_name}: {e}')

print(f'\n=== RESUMEN ===')
print(f'PDFs generados:  {ok_count}')
print(f'Errores:         {len(errors)}')
if errors:
    for name, err in errors:
        print(f'  ! {name}: {err}')
print(f'\nCarpeta: {os.path.abspath(OUTPUT_DIR)}')
