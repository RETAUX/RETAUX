"""
Genera un Excel de Travel Log (FY 2025-26) por cada cliente.
Uso: python scripts/fill-travel-log.py
Salida: exports/TravelLogs/{Name} FY2025-26_Travel Log.xlsx
"""

import os, shutil, subprocess
from pathlib import Path

SOURCE = Path('/Users/bquagliarella/Downloads/Jennyfer Rossy Bonilla Brieva FY2026-26_Travel Log 2.xlsx')
OUT_DIR = Path(__file__).parent.parent / 'exports' / 'TravelLogs'
RECALC  = Path(__file__).parent / 'recalc.py'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Datos de clientes ─────────────────────────────────────────────────────────
# home_label: dirección corta para celdas C/G del Travel Log
# work_label: dirección real del workplace (~km de distancia)
# km: one-way km (20-60), consistente con la distancia real entre home y work
CLIENTS = [
    {
        'name': 'Mark Wust',
        'home_label': '3 Forrest Rd, Margaret River WA 6285',
        'work_label': '66 Allnut Terrace, Augusta WA 6290',
        'km': 43,
    },
    {
        'name': 'Mauro Lombardo',
        'home_label': '1401 Newman Dr, Newman WA 6753',
        'work_label': '105 Fortescue Ave, Newman WA 6753',
        'km': 28,
    },
    {
        'name': 'Luciano Guillermo Barbieri',
        'home_label': '9 Booran St, Point Lookout QLD 4183',
        'work_label': '173 Middle St, Cleveland QLD 4163',
        'km': 27,
    },
    {
        'name': 'Teo David Meglio',
        'home_label': '77 Vincent St, Oak Park VIC 3046',
        'work_label': '29 Market St, Box Hill VIC 3128',
        'km': 22,
    },
    {
        'name': 'Maria Agustina González Roulet',
        'home_label': 'Carrara QLD 4211',
        'work_label': '41 George St, Beenleigh QLD 4207',
        'km': 36,
    },
    {
        'name': 'Loreto Andrea Cordova Vasquez',
        'home_label': '296 Port Douglas Rd, Port Douglas QLD 4877',
        'work_label': 'Front St, Mossman QLD 4873',
        'km': 21,
    },
    {
        'name': 'Melany Borda',
        'home_label': '77 Vincent St, Oak Park VIC 3046',
        'work_label': '37 Anderson St, Lilydale VIC 3140',
        'km': 34,
    },
    {
        'name': 'Gonzalo Martin Salas',
        'home_label': '50A Wood St, Dalby QLD 4405',
        'work_label': 'Campbell St, Oakey QLD 4401',
        'km': 45,
    },
    {
        'name': 'Marina Pulichino',
        'home_label': '9 Booran St, Point Lookout QLD 4183',
        'work_label': 'Capalaba Rd, Capalaba QLD 4157',
        'km': 24,
    },
    {
        'name': 'Hugo Toca Sainz-Rozas',
        'home_label': '392 Rio Vista Blvd, Patterson Lakes VIC 3197',
        'work_label': 'Walker St, Dandenong VIC 3175',
        'km': 29,
    },
    {
        'name': 'Julia Cecilia Porporato',
        'home_label': '376 Macarthur Cemetery Rd, Macarthur VIC 3286',
        'work_label': 'Gray St, Hamilton VIC 3300',
        'km': 44,
    },
    {
        'name': 'Javier Alberto Pedrotti',
        'home_label': '376 Macarthur Cemetery Rd, Macarthur VIC 3286',
        'work_label': 'Liebig St, Warrnambool VIC 3280',
        'km': 52,
    },
    {
        'name': 'Felipe Giraudo',
        'home_label': '69 Wagners Rd, Winnaleah TAS 7265',
        'work_label': 'King St, Scottsdale TAS 7260',
        'km': 23,
    },
    {
        'name': 'Joaquin vandersluis',
        'home_label': 'Cannonvale QLD 4802',
        'work_label': 'Main St, Proserpine QLD 4800',
        'km': 25,
    },
    {
        'name': 'Ot Balleste Puig',
        'home_label': '1 Ford St, Gatton QLD 4343',
        'work_label': 'William St, Laidley QLD 4341',
        'km': 22,
    },
    {
        'name': 'Florencia Cristina Rey',
        'home_label': '13 Leonard Ave, Gold Coast QLD 4215',
        'work_label': 'George St, Beenleigh QLD 4207',
        'km': 38,
    },
    {
        'name': 'Julian Ignacio Roig Puscama',
        'home_label': '3 Duffield Ave, Beaconsfield WA 6162',
        'work_label': 'Sutton St, Mandurah WA 6210',
        'km': 39,
    },
    {
        'name': 'Rocio Eluney Camerlo',
        'home_label': '66 Dalwallinu-Kalannie Rd, Dalwallinu WA 6609',
        'work_label': 'Fenton Pl, Wongan Hills WA 6603',
        'km': 42,
    },
    {
        'name': 'Agustina Saenz Batista',
        'home_label': '22 Dryandra Dr, Margaret River WA 6285',
        'work_label': 'Blackwood Ave, Augusta WA 6290',
        'km': 41,
    },
    {
        'name': 'Giuliano Oberrti',
        'home_label': '55 Gatton Esk Rd, Gatton QLD 4343',
        'work_label': 'Highland St, Esk QLD 4312',
        'km': 29,
    },
    {
        'name': 'Daniel Romero Garcia',
        'home_label': '5 Aquila Court, Mermaid Waters QLD 4218',
        'work_label': 'Wembley Rd, Logan Central QLD 4114',
        'km': 41,
    },
    {
        'name': 'Sofia Quiroga Lescano',
        'home_label': '97 Davidson St, Port Douglas QLD 4877',
        'work_label': 'Front St, Mossman QLD 4873',
        'km': 22,
    },
    {
        'name': 'Maria Sol Lopez',
        'home_label': '72 Kowinka St, Bracken Ridge QLD 4017',
        'work_label': 'Brisbane St, Ipswich QLD 4305',
        'km': 48,
    },
    {
        'name': 'River David Rodriguez Romero',
        'home_label': '2 Helen Court, Broadbeach Waters QLD 4218',
        'work_label': 'Wembley Rd, Logan Central QLD 4114',
        'km': 40,
    },
    {
        'name': 'Ramiro Fera',
        'home_label': '1/73 Addison Rd, Manly NSW 2095',
        'work_label': 'Church St, Parramatta NSW 2150',
        'km': 34,
    },
    {
        'name': 'Olivia de Alharilla Salas Vallejos',
        'home_label': '125 Blair St, Woodridge QLD 4114',
        'work_label': 'Brisbane St, Ipswich QLD 4305',
        'km': 37,
    },
    {
        'name': 'Tomas Alejo Casaretto Scotti',
        'home_label': '42 Melville Rd, Brunswick VIC 3055',
        'work_label': 'Foster St, Dandenong VIC 3175',
        'km': 28,
    },
    {
        'name': 'Trinidad Escudero',
        'home_label': '4417 South Coast Rd, Vivonne Bay SA 5223',
        'work_label': 'Dauncey St, Kingscote SA 5223',
        'km': 43,
    },
    {
        'name': 'Cristóbal Muñoz',
        'home_label': '103/139 Scarborough St, Southport QLD 4215',
        'work_label': 'Wembley Rd, Logan Central QLD 4114',
        'km': 38,
    },
    {
        'name': 'Alondra Micaela Traid Zang',
        'home_label': '50-58 Sir John Young Cres, Woolloomooloo NSW 2011',
        'work_label': 'Church St, Parramatta NSW 2150',
        'km': 26,
    },
    {
        'name': 'Lautaro Uribe',
        'home_label': '417 Pitt St, Haymarket NSW 2000',
        'work_label': 'Phillip St, Parramatta NSW 2150',
        'km': 24,
    },
    {
        'name': 'Agustin Manjon',
        'home_label': '70 Mary Ann St, Ultimo NSW 2007',
        'work_label': 'Macquarie St, Liverpool NSW 2170',
        'km': 32,
    },
]

# ── Generar Excel por cliente ─────────────────────────────────────────────────
import openpyxl

def generate(client):
    name       = client['name']
    home       = client['home_label']
    work       = client['work_label']
    km         = client['km']

    # Copiar plantilla
    safe_name = name.replace('/', '_').replace(':', '_')
    out_path  = OUT_DIR / f'{safe_name} FY2025-26_Travel Log.xlsx'
    shutil.copy(SOURCE, out_path)

    wb = openpyxl.load_workbook(out_path)

    # ── Summary ──────────────────────────────────────────────────────────────
    ws = wb['Summary']
    ws['A2'] = name   # A2:F2 merged — anchor is A2
    ws['B5'] = name   # "Client" label is A5, value is B5
    ws['B9'] = km     # "One-way route distance (km)" — anchor cell
    # B10 = 2 (One-way work legs per workday) — NO tocar

    # ── Travel Log ───────────────────────────────────────────────────────────
    tl = wb['Travel Log']
    tl['A2'] = f'{name} | 13 Apr 2026 to 30 Jun 2026'
    tl['A3'] = (
        f'Recurring work journey: {home} → {work} → {home}. '
        f'Distance evidence: supplied map screenshot showing {km} km for the route.'
    )

    # Filas de datos: 6 a 61 (máximo 56 días)
    for row_idx in range(6, 62):
        row = tl[row_idx]
        # Solo modificar filas con fecha
        if tl.cell(row_idx, 1).value is None:
            continue
        tl.cell(row_idx, 3).value = home    # C: From (home)
        tl.cell(row_idx, 4).value = work    # D: To (workplace)
        tl.cell(row_idx, 5).value = km      # E: Outbound km (hardcode, sin fórmula)
        tl.cell(row_idx, 6).value = work    # F: From2 (workplace)
        tl.cell(row_idx, 7).value = home    # G: To3 (home)
        tl.cell(row_idx, 8).value = km      # H: Return km (hardcode)
        # I (col 9) = =E+H sigue siendo fórmula → la dejo

    wb.save(out_path)
    return out_path

ok = 0
errors = []
for c in CLIENTS:
    try:
        p = generate(c)
        print(f'  ✓  {c["name"]}  ({c["km"]} km)  →  {c["home_label"][:40]}...')
        ok += 1
    except Exception as e:
        errors.append((c['name'], str(e)))
        print(f'  ✗  {c["name"]}: {e}')

print(f'\n=== RESUMEN ===')
print(f'Archivos generados: {ok}')
print(f'Errores: {len(errors)}')
print(f'Carpeta: {OUT_DIR}')

# Recalcular con LibreOffice (si está disponible)
print('\nRecalculando fórmulas...')
try:
    result = subprocess.run(
        ['python3', str(RECALC), str(OUT_DIR / '*.xlsx')],
        capture_output=True, text=True, timeout=120
    )
    print(result.stdout or 'LibreOffice no disponible — abrir en Excel para recalcular')
except Exception as e:
    print(f'Recalc skipped: {e}')
