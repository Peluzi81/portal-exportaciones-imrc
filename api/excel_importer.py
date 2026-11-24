#!/usr/bin/env python3
"""
Importador inteligente de planillas Excel (.xls y .xlsx) para:
  1. Control Mensual de Envíos y Montos (DIRECTAS / ART, Amb / Int, Refact / Dif. Arancel)
  2. Seguimiento de Correo Postal (Andreani, múltiples hojas por mes)
"""

import io
import re
import unicodedata
from datetime import datetime, date

MONTH_MAP = {
    "enero": 1, "ene": 1,
    "febrero": 2, "feb": 2,
    "marzo": 3, "mar": 3,
    "abril": 4, "abr": 4,
    "mayo": 5, "may": 5,
    "junio": 6, "jun": 6,
    "julio": 7, "jul": 7,
    "agosto": 8, "ago": 8,
    "septiembre": 9, "setiembre": 9, "sep": 9, "set": 9,
    "octubre": 10, "oct": 10,
    "noviembre": 11, "nov": 11,
    "diciembre": 12, "dic": 12,
}


def norm_text(s) -> str:
    txt = str(s or "").strip().lower()
    txt = unicodedata.normalize("NFD", txt)
    txt = "".join(ch for ch in txt if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", txt)


def format_date_cell(val, datemode=0) -> str:
    if val is None or val == "":
        return ""
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d")
    if isinstance(val, date):
        return val.strftime("%Y-%m-%d")
    # Serial de fecha Excel cuando viene de xlrd como float > 30000
    if isinstance(val, (int, float)) and 35000 < val < 60000:
        try:
            import xlrd
            dt = xlrd.xldate_as_datetime(val, datemode)
            return dt.strftime("%Y-%m-%d")
        except Exception:
            pass
    s = str(val).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", s)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{y:04d}-{mo:02d}-{d:02d}"
    return ""


def parse_number_cell(val):
    """Devuelve float si es numérico, o None si es texto/vacío."""
    if val is None or val == "" or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return round(float(val), 2)
    s = str(val).strip()
    if not s or s.startswith("#"):
        return None
    # Si contiene letras (ej. "mail", "refact"), no es importe
    if re.search(r"[a-zA-Z]", s):
        return None
    s = s.replace("$", "").replace(" ", "")
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def classify_tipo(text_str: str) -> str:
    t = norm_text(text_str)
    if "refact" in t:
        return "refacturacion"
    if "dif" in t or "arancel" in t or "ajuste" in t:
        return "diferencia_arancel"
    if "preliq" in t:
        return "preliquidacion"
    return "normal"


def detect_period_from_text(text: str) -> str:
    if not text:
        return ""
    s = norm_text(text)
    # 202610 o 2026-10 o 2026/10
    m = re.search(r"(20[123]\d)[-/_ ]?(0[1-9]|1[0-2])\b", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    # 10/2026 o 10-2026
    m = re.search(r"\b(0?[1-9]|1[0-2])[-/_ ](20[123]\d)\b", s)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    # Nombre del mes + año (ej: octubre 2026, sep 2025)
    for m_name, m_num in MONTH_MAP.items():
        m = re.search(rf"\b{m_name}\b[^0-9]*(20[123]\d)", s)
        if m:
            return f"{m.group(1)}-{m_num:02d}"
        m2 = re.search(rf"(20[123]\d)[^a-z]*\b{m_name}\b", s)
        if m2:
            return f"{m2.group(1)}-{m_num:02d}"
    return ""


def read_excel_sheets(raw_bytes: bytes, filename: str):
    """Lee un archivo .xlsx o .xls y retorna [(sheet_name, rows_list, datemode), ...]."""
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    sheets = []

    if ext == "xlsx" or (raw_bytes[:2] == b"PK"):
        try:
            import openpyxl
        except ImportError:
            raise RuntimeError("Falta la librería 'openpyxl' en Python para leer archivos .xlsx.")
        wb = openpyxl.load_workbook(io.BytesIO(raw_bytes), data_only=True)
        for name in wb.sheetnames:
            ws = wb[name]
            rows = []
            for r in range(1, ws.max_row + 1):
                rows.append([ws.cell(r, c).value for c in range(1, ws.max_column + 1)])
            sheets.append((name, rows, 0))
        return sheets

    # Legacy .xls
    try:
        import xlrd
    except ImportError:
        raise RuntimeError("Falta la librería 'xlrd' en Python para leer archivos .xls antiguos.")
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    for sh in wb.sheets():
        rows = []
        for r in range(sh.nrows):
            row_vals = []
            for c in range(sh.ncols):
                cell = sh.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        row_vals.append(xlrd.xldate_as_datetime(cell.value, wb.datemode))
                    except Exception:
                        row_vals.append(cell.value)
                elif cell.ctype == xlrd.XL_CELL_EMPTY:
                    row_vals.append(None)
                elif cell.ctype == xlrd.XL_CELL_ERROR:
                    row_vals.append(None)
                else:
                    row_vals.append(cell.value)
            rows.append(row_vals)
        sheets.append((sh.name, rows, wb.datemode))
    return sheets


def build_financiadora_lookup(financiadoras_list):
    by_norm = {}
    by_code = {}
    # Alias: nombre normalizado en Excel -> posibles IDs o nombres normalizados
    aliases = {
        # IMRC
        "federada": ["federada"],
        "sancor": ["sancor-salud"],
        "sat television": ["sat-tv"],
        "swiss medical s.a.": ["swiss-medical", "ppsl-swiss-medical-art"],
        "swiss medical": ["swiss-medical", "ppsl-swiss-medical-art"],
        "swiss medical art": ["ppsl-swiss-medical-art", "swiss-medical"],
        "experta art s.a": ["experta-art", "ppsl-experta-art"],
        "experta art s.a.": ["experta-art", "ppsl-experta-art"],
        "la segunda cia de personas": ["la-segunda-personas"],
        "la segunda compania de personas": ["la-segunda-personas"],
        "seguros sancor integro": ["sancor-integro", "ppsl-sancor-integro"],
        "sancor integro": ["sancor-integro", "ppsl-sancor-integro"],
        "prevencion art lby": ["prevencion-art", "ppsl-prevencion-art"],
        "avalian": ["avalian", "ppsl-avalian-pmo"],
        "municipales": ["municipales"],
        # PPSL
        "a.a motociclistas": ["ppsl-aa-motociclistas"],
        "a.a m motociclistas": ["ppsl-aa-motociclistas"],
        "a.a volantes": ["ppsl-aa-volantes"],
        "aa volantes": ["ppsl-aa-volantes"],
        "asociart": ["ppsl-asociart-art", "asociart-art"],
        "choferes/osccptac": ["ppsl-choferes-osccptac"],
        "coop m.patronal": ["ppsl-coop-m-patronal"],
        "fed. patronal art": ["ppsl-federacion-patronal-art", "federacion-patronal-art"],
        "fed. patronal seg": ["ppsl-federacion-patronal-seguros", "federacion-patronal-seguros"],
        "la segunda": ["ppsl-la-segunda-art", "la-segunda-art"],
        "omint / serena": ["ppsl-omint-serena-art"],
        "omint art / serena art": ["ppsl-omint-serena-art"],
        "ospersams": ["ppsl-ospersams"],
        "ospersaams": ["ppsl-ospersams"],
        "prev examenes preocupacionales": ["ppsl-prevencion-examenes"],
        "prevencion examenes preocupacionales": ["ppsl-prevencion-examenes"],
    }
    for f in financiadoras_list:
        by_norm[norm_text(f["nombre"])] = f
        cod = str(f.get("codigo", "")).strip()
        if cod:
            for part in re.split(r"[/,\s]+", cod):
                if part.isdigit():
                    by_code[part] = f
    return by_norm, by_code, aliases


def match_financiadora(os_nombre, os_cod, by_norm, by_code, aliases, fin_by_id):
    n = norm_text(os_nombre)
    if n in by_norm:
        return by_norm[n]
    if n in aliases:
        for cand_id in aliases[n]:
            if cand_id in fin_by_id:
                return fin_by_id[cand_id]
    cod_clean = str(os_cod or "").strip().split(".")[0]
    if cod_clean and cod_clean in by_code:
        return by_code[cod_clean]
    # Coincidencia parcial segura (si empieza igual)
    for k, f in by_norm.items():
        if len(n) >= 4 and (k.startswith(n) or n.startswith(k)):
            return f
    return None


def parse_billing_excel(raw_bytes: bytes, filename: str, financiadoras_list: list, period_override: str = ""):
    """Parsea una planilla mensual de envíos de facturación (.xls / .xlsx)."""
    sheets = read_excel_sheets(raw_bytes, filename)
    by_norm, by_code, aliases = build_financiadora_lookup(financiadoras_list)
    fin_by_id = {f["id"]: f for f in financiadoras_list}

    # Intentar detectar período global desde el nombre del archivo
    file_period = detect_period_from_text(filename)
    all_envios = []
    detected_periods = []

    for sh_name, rows, datemode in sheets:
        if not rows:
            continue

        # Buscar período en primeras 5 filas o nombre de la hoja
        sh_period = period_override.strip() if re.match(r"^\d{4}-\d{2}$", str(period_override or "").strip()) else ""
        if not sh_period:
            for r in rows[:6]:
                joined = " ".join(str(v) for v in r if v is not None)
                p = detect_period_from_text(joined)
                if p:
                    sh_period = p
                    break
        if not sh_period:
            sh_period = detect_period_from_text(sh_name) or file_period

        # Localizar columnas de cabecera dinámicamente
        col_cod, col_nom = 0, 1
        col_amb_f, col_amb_i, col_amb_t = 2, 3, 4
        col_int_f, col_int_i, col_int_t = 5, 6, 7
        header_found = False

        for r in rows[:15]:
            norm_row = [norm_text(v) for v in r]
            if any("os_nombre" in x or x == "obra social" or x == "financiadora" for x in norm_row):
                header_found = True
                for idx, h in enumerate(norm_row):
                    if "cod" in h:
                        col_cod = idx
                    elif "nombre" in h or "obra social" in h or "financiadora" in h:
                        col_nom = idx
                    elif h == "amb" or "ambulatorio" in h:
                        col_amb_f, col_amb_i, col_amb_t = idx, idx + 1, idx + 2
                    elif h == "int" or "internado" in h:
                        col_int_f, col_int_i, col_int_t = idx, idx + 1, idx + 2
                break

        if not header_found:
            # Si esta hoja no parece tener el formato de planilla, verificar si al menos tiene filas con montos
            if len(rows) < 3:
                continue

        grupo = "directas"
        has_section_headers = False
        curr_cod = ""
        curr_name = ""
        curr_fid = ""
        curr_grupo = "directas"
        sheet_envios = []
        sample_dates = []

        def cell(row, idx):
            return row[idx] if idx < len(row) else None

        for r in rows:
            c0 = str(cell(r, col_cod) or "").strip()
            c1 = str(cell(r, col_nom) or "").strip()
            c0_up = c0.upper()
            c1_up = c1.upper()

            if c0_up == "DIRECTAS" or c1_up == "DIRECTAS":
                grupo = "directas"
                has_section_headers = True
                curr_name = ""
                continue
            if c0_up == "ART" or c1_up == "ART":
                grupo = "art"
                has_section_headers = True
                curr_name = ""
                continue
            if "SIN EXPORTACION" in c0_up or "SIN EXPORTACION" in c1_up:
                break
            if "os_cod" in c0.lower() or "os_nombre" in c1.lower() or c0_up.startswith("PERIODO"):
                continue
            if c0_up.startswith("TOTAL") or c1_up.startswith("TOTAL") or c0_up.startswith("SUBTOTAL") or c1_up.startswith("SUBTOTAL"):
                continue
            if not any(v is not None and str(v).strip() != "" for v in r):
                continue

            # Limpiar códigos float de xlrd (ej: 1524.0 -> "1524")
            if re.match(r"^\d+\.0$", c0):
                c0 = c0[:-2]

            if c1:
                curr_cod = c0
                curr_name = c1_up
                matched = match_financiadora(curr_name, curr_cod, by_norm, by_code, aliases, fin_by_id)
                curr_fid = matched["id"] if matched else ""
                if not has_section_headers and matched and matched.get("categoria") == "art":
                    curr_grupo = "art"
                else:
                    curr_grupo = grupo
            elif c0 and not c1:
                # Fila con segundo código como "3814" debajo de unimed
                continue

            if not curr_name:
                continue

            # Ambulatorio
            amb_f = format_date_cell(cell(r, col_amb_f), datemode)
            amb_raw_i = cell(r, col_amb_i)
            amb_t = str(cell(r, col_amb_t) or "").strip()
            if amb_f or (amb_raw_i is not None and str(amb_raw_i).strip() != "") or amb_t:
                num = parse_number_cell(amb_raw_i)
                if num is not None:
                    imp = num
                    tag = amb_t
                else:
                    imp = 0.0
                    raw_txt = str(amb_raw_i or "").strip()
                    if raw_txt.startswith("#"):
                        raw_txt = ""
                    tag = " ".join(x for x in [raw_txt, amb_t] if x)
                if curr_name == "PREVENCION ART LBY":
                    tag = "LBY" if not tag else f"LBY - {tag}"
                if amb_f or imp > 0 or tag:
                    if amb_f:
                        sample_dates.append(amb_f)
                    sheet_envios.append({
                        "financiadora_id": curr_fid,
                        "os_cod": curr_cod,
                        "os_nombre": "PREVENCION ART" if curr_name == "PREVENCION ART LBY" else curr_name,
                        "grupo": curr_grupo,
                        "area": "ambulatorio",
                        "tipo": classify_tipo(tag),
                        "fecha_envio": amb_f,
                        "importe": imp,
                        "etiqueta": tag[:60],
                        "observacion": "",
                    })

            # Internado
            int_f = format_date_cell(cell(r, col_int_f), datemode)
            int_raw_i = cell(r, col_int_i)
            int_t = str(cell(r, col_int_t) or "").strip()
            if int_f or (int_raw_i is not None and str(int_raw_i).strip() != "") or int_t:
                num = parse_number_cell(int_raw_i)
                if num is not None:
                    imp = num
                    tag = int_t
                else:
                    imp = 0.0
                    raw_txt = str(int_raw_i or "").strip()
                    if raw_txt.startswith("#"):
                        raw_txt = ""
                    tag = " ".join(x for x in [raw_txt, int_t] if x)
                if int_f or imp > 0 or tag:
                    if int_f:
                        sample_dates.append(int_f)
                    sheet_envios.append({
                        "financiadora_id": curr_fid,
                        "os_cod": curr_cod,
                        "os_nombre": curr_name,
                        "grupo": curr_grupo,
                        "area": "internado",
                        "tipo": classify_tipo(tag),
                        "fecha_envio": int_f,
                        "importe": imp,
                        "etiqueta": tag[:60],
                        "observacion": "",
                    })

        if not sheet_envios:
            continue

        # Si aún no detectamos el período, inferirlo (un mes antes de la fecha de envío si se envía primeros días del mes siguiente)
        if not sh_period and sample_dates:
            sample_dates.sort()
            mid_d = sample_dates[len(sample_dates) // 2]
            y, m, d = int(mid_d[:4]), int(mid_d[5:7]), int(mid_d[8:10])
            if d <= 20:
                m -= 1
                if m == 0:
                    m = 12
                    y -= 1
            sh_period = f"{y:04d}-{m:02d}"
        if not sh_period:
            sh_period = datetime.now().strftime("%Y-%m")

        for e in sheet_envios:
            e["period"] = sh_period
        all_envios.extend(sheet_envios)
        detected_periods.append(sh_period)

    return {
        "filename": filename,
        "period": detected_periods[0] if detected_periods else (period_override or file_period or datetime.now().strftime("%Y-%m")),
        "count": len(all_envios),
        "total_directas": round(sum(e["importe"] for e in all_envios if e["grupo"] != "art"), 2),
        "total_art": round(sum(e["importe"] for e in all_envios if e["grupo"] == "art"), 2),
        "total_general": round(sum(e["importe"] for e in all_envios), 2),
        "envios": all_envios,
    }


def parse_postal_excel(raw_bytes: bytes, filename: str, default_year: int = None):
    """Parsea una planilla de seguimiento postal (Andreani) con una o múltiples hojas por mes."""
    sheets = read_excel_sheets(raw_bytes, filename)
    year_fallback = default_year or datetime.now().year
    records = []
    sheet_summaries = []

    for sh_name, rows, datemode in sheets:
        if not rows:
            continue
        # Buscar fila de encabezados
        start_idx = 0
        col_fecha, col_obra, col_medio, col_seg, col_ent, col_obs = 0, 1, 2, 3, 4, 5
        for idx, r in enumerate(rows[:10]):
            nr = [norm_text(v) for v in r]
            if any("seguimiento" in x or "obra social" in x for x in nr):
                start_idx = idx + 1
                for c_i, h in enumerate(nr):
                    if h == "fecha" or "despacho" in h:
                        col_fecha = c_i
                    elif "obra" in h or "financiadora" in h:
                        col_obra = c_i
                    elif "medio" in h or "correo" in h:
                        col_medio = c_i
                    elif "seguimiento" in h or "guia" in h or "tracking" in h:
                        col_seg = c_i
                    elif "entrega" in h:
                        col_ent = c_i
                    elif "obs" in h or "nota" in h:
                        col_obs = c_i
                break

        sh_month = None
        sn = norm_text(sh_name)
        for mn, mnum in MONTH_MAP.items():
            if re.search(rf"\b{mn}\b", sn):
                sh_month = mnum
                break

        sh_records = []
        detected_year = None

        def cell(row, idx):
            return row[idx] if idx < len(row) else None

        for r in rows[start_idx:]:
            if not any(v is not None and str(v).strip() != "" for v in r):
                continue
            fecha = format_date_cell(cell(r, col_fecha), datemode)
            obra = str(cell(r, col_obra) or "").strip().upper()
            medio = str(cell(r, col_medio) or "ANDREANI").strip() or "ANDREANI"
            seg = str(cell(r, col_seg) or "").strip().upper()
            entrega = format_date_cell(cell(r, col_ent), datemode)
            obs = str(cell(r, col_obs) or "").strip()

            if not obra and not seg:
                continue
            if obra in ("OBRA SOCIAL", "FINANCIADORA"):
                continue

            if fecha and not detected_year:
                detected_year = int(fecha[:4])
            elif entrega and not detected_year:
                detected_year = int(entrega[:4])

            sh_records.append({
                "fecha_envio": fecha,
                "obra_social": obra,
                "medio": medio,
                "seguimiento": seg,
                "fecha_entrega": entrega,
                "observacion": obs[:300],
            })

        if not sh_records:
            continue

        yr = detected_year or year_fallback
        sh_period = f"{yr:04d}-{sh_month:02d}" if sh_month else (
            sh_records[0]["fecha_envio"][:7] if sh_records[0]["fecha_envio"] else f"{yr:04d}-{datetime.now().month:02d}"
        )
        for rec in sh_records:
            rec["period"] = sh_period
        records.extend(sh_records)
        sheet_summaries.append({"sheet": sh_name, "period": sh_period, "count": len(sh_records)})

    return {
        "filename": filename,
        "count": len(records),
        "sheets": sheet_summaries,
        "postal": records,
    }
