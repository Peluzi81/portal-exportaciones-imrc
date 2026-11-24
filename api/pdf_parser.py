#!/usr/bin/env python3
"""
Extractor inteligente de PDFs de Geclisa (Reporte de Presentaciones de Facturación).
Lee PDFs de una o múltiples páginas (Crystal Reports / Geclisa) y extrae:
  - Período (AAAAMM -> AAAA-MM)
  - Obra Social y Código Geclisa (os_cod), con matching automático contra la empresa activa
  - Empresa detectada en el reporte (IMRC / PPSL)
  - Área (Ambulatorio / Internado)
  - Listado completo de comprobantes (N° Pr., Fecha, Tipo, N° Comp., CUIT, Neto, IVA, Total)
  - Condición IVA automática (Exento / Gravado / Gravado y Exento) y totales verificados
"""

import io
import re
from typing import List, Dict, Any

import excel_importer


MONEY_RE = re.compile(r"-?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|-?\d+[.,]\d{2}")
DATE_RE = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b")
COMP_RE = re.compile(
    r"(?<![A-Za-z])(FAC|FCE|NC|NCE|ND|NDE|FC|REC)\s+([ABCMEX])\s+(\d{4,5}-\d{6,8})\b",
    re.I,
)
CUIT_RE = re.compile(r"\b(\d{2}-\d{7,8}-\d)\b")
PRES_LINE_RE = re.compile(r"^\s*(\d{5,8})\b")


def parse_money_str(s: str) -> float:
    val = str(s or "").strip().replace("$", "").replace(" ", "")
    if not val:
        return 0.0
    if "," in val and "." in val:
        if val.rfind(",") > val.rfind("."):
            # Formato AR: 4.812.249,69
            val = val.replace(".", "").replace(",", ".")
        else:
            # Formato US (Geclisa/Crystal): 4,812,249.69
            val = val.replace(",", "")
    elif "," in val:
        parts = val.split(",")
        if len(parts[-1]) == 2:
            val = val.replace(",", ".")
        else:
            val = val.replace(",", "")
    try:
        return round(float(val), 2)
    except ValueError:
        return 0.0


def extract_pdf_text_pages(raw_bytes: bytes) -> List[Dict[str, str]]:
    """Extrae texto por página en modo layout y modo estándar usando pypdf."""
    try:
        from pypdf import PdfReader
    except ImportError:
        raise RuntimeError(
            "Falta la librería 'pypdf' en Python para leer archivos PDF. Ejecutá: pip install pypdf"
        )

    reader = PdfReader(io.BytesIO(raw_bytes))
    pages = []
    for page in reader.pages:
        layout_txt = ""
        plain_txt = ""
        try:
            layout_txt = page.extract_text(extraction_mode="layout") or ""
        except Exception:
            layout_txt = ""
        try:
            plain_txt = page.extract_text() or ""
        except Exception:
            plain_txt = ""
        pages.append({"layout": layout_txt, "plain": plain_txt})
    return pages


def detect_company_from_header(empresa_str: str) -> str:
    n = excel_importer.norm_text(empresa_str)
    if not n:
        return ""
    if "san lucas" in n or "ppsl" in n or "policlinico" in n:
        return "ppsl"
    if "instituto medico" in n or "imrc" in n or "rio iv" in n or "rio cuarto" in n:
        return "imrc"
    if "urolog" in n:
        return "uro"
    return ""


def parse_invoices_from_text(full_text: str) -> List[Dict[str, Any]]:
    """
    Extrae comprobantes línea por línea soportando tanto el modo layout de Crystal Reports
    como el orden plano del stream PDF.
    """
    lines = [ln.rstrip() for ln in full_text.splitlines()]
    facturas: List[Dict[str, Any]] = []
    seen_keys = set()
    last_pres = ""

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # Detectar líneas que solo traen N° de presentación (en modo stream plano)
        if re.fullmatch(r"\d{5,8}", stripped):
            last_pres = stripped
            continue

        m_comp = COMP_RE.search(line)
        m_date = DATE_RE.search(line)
        if not (m_comp and m_date):
            continue

        tipo_comp = f"{m_comp.group(1).upper()} {m_comp.group(2).upper()}"
        num_comp = m_comp.group(3)
        fecha_iso = f"{m_date.group(3)}-{m_date.group(2)}-{m_date.group(1)}"

        m_cuit = CUIT_RE.search(line)
        cuit = m_cuit.group(1) if m_cuit else ""

        # N° de presentación al comienzo de la línea o en líneas inmediatamente anteriores
        m_pres = PRES_LINE_RE.match(line)
        pres = m_pres.group(1) if m_pres else last_pres
        if not pres and idx > 0:
            for back in range(1, min(4, idx + 1)):
                prev = lines[idx - back].strip()
                if re.fullmatch(r"\d{5,8}", prev):
                    pres = prev
                    break

        # Extraer importes (quitar primero fecha, cuit, n° comp y n° pres para no confundir)
        cleaned = line
        cleaned = DATE_RE.sub(" ", cleaned)
        cleaned = COMP_RE.sub(" ", cleaned)
        cleaned = CUIT_RE.sub(" ", cleaned)
        money_tokens = MONEY_RE.findall(cleaned)
        nums = [parse_money_str(tok) for tok in money_tokens]

        neto = 0.0
        iva = 0.0
        total = 0.0
        if len(nums) >= 3:
            neto, iva, total = nums[-3], nums[-2], nums[-1]
        elif len(nums) == 2:
            neto, total = nums[0], nums[1]
            iva = round(total - neto, 2)
        elif len(nums) == 1:
            neto = total = nums[0]
            iva = 0.0

        # Si es Nota de Crédito y vino positiva en reporte, conservar signo solo si ya era negativo
        dedup_key = (pres, tipo_comp, num_comp, total)
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)

        facturas.append({
            "presentacion": pres,
            "fecha": fecha_iso,
            "tipo_comp": tipo_comp,
            "numero": num_comp,
            "cuit": cuit,
            "neto": neto,
            "iva": iva,
            "total": total,
            "condicion": "Gravado" if abs(iva) > 0.005 else "Exento",
        })
        last_pres = ""

    return facturas


def build_facturas_resumen(facturas: List[Dict[str, Any]], filename: str = "") -> str:
    n = len(facturas)
    if n == 0:
        return f"PDF: {filename}" if filename else ""
    if n == 1:
        f = facturas[0]
        pres_txt = f" (Pr. {f['presentacion']})" if f.get("presentacion") else ""
        return f"{f['tipo_comp']} {f['numero']}{pres_txt}"
    # Agrupar prefijos o mostrar rango
    first = facturas[0]
    last = facturas[-1]
    return f"{n} comp. ({first['tipo_comp']} {first['numero']} … {last['numero']})"


def parse_geclisa_pdf(raw_bytes: bytes, filename: str, financiadoras_list: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Parsea un PDF de Geclisa y retorna toda la información estructurada."""
    pages = extract_pdf_text_pages(raw_bytes)
    layout_full = "\n".join(p["layout"] for p in pages if p["layout"])
    plain_full = "\n".join(p["plain"] for p in pages if p["plain"])
    combined = layout_full if layout_full.strip() else plain_full

    if not combined.strip():
        raise ValueError(
            "El PDF no contiene texto legible (parece ser una imagen escaneada sin OCR). "
            "Exportá el reporte directamente a PDF desde Geclisa."
        )

    # 1. Período (AAAAMM -> AAAA-MM)
    period = ""
    m_per = re.search(r"Per[ií]odos?\s*:\s*(20\d{2})(0[1-9]|1[0-2])", combined, re.I)
    if not m_per:
        m_per = re.search(r"Per[ií]odos?\s*:\s*(20\d{2})(0[1-9]|1[0-2])", plain_full, re.I)
    if m_per:
        period = f"{m_per.group(1)}-{m_per.group(2)}"
    else:
        period = excel_importer.detect_period_from_text(combined[:600]) or excel_importer.detect_period_from_text(filename)

    # 2. Área (Ambulatorio / Internado)
    area = ""
    m_area = re.search(r"[ÁA]rea\s*:\s*(Ambulatorio|Internado|Internaci[oó]n)", combined, re.I)
    if not m_area:
        m_area = re.search(r"[ÁA]rea\s*:\s*(Ambulatorio|Internado|Internaci[oó]n)", plain_full, re.I)
    if m_area:
        area = "internado" if m_area.group(1).lower().startswith("intern") else "ambulatorio"
    else:
        low_head = excel_importer.norm_text(combined[:800] + " " + filename)
        if "internad" in low_head:
            area = "internado"
        elif "ambulator" in low_head:
            area = "ambulatorio"

    # 3. Empresa en el encabezado
    empresa_raw = ""
    m_emp = re.search(r"Empresa\s*:\s*(.+?)(?:\s*-\s*[ÁA]rea|\s*$)", combined, re.I | re.M)
    if not m_emp:
        m_emp = re.search(r"Empresa\s*:\s*(.+?)(?:\s*-\s*[ÁA]rea|\s*$)", plain_full, re.I | re.M)
    if m_emp:
        empresa_raw = re.sub(r"\s+", " ", m_emp.group(1)).strip(" -")
    empresa_detectada = detect_company_from_header(empresa_raw)

    # 4. Obra Social y Código Geclisa
    os_cod = ""
    os_nombre_raw = ""
    agente_raw = ""

    m_ag = re.search(r"Agente\s+de\s+Facturaci[oó]n\s*:\s*(\d+)\s*-\s*(.+)", combined, re.I)
    if not m_ag:
        m_ag = re.search(r"Agente\s+de\s+Facturaci[oó]n\s*:\s*(\d+)\s*-\s*(.+)", plain_full, re.I)
    if m_ag:
        os_cod = m_ag.group(1).strip()
        agente_raw = re.sub(r"\s+", " ", m_ag.group(2)).strip()

    m_os = re.search(r"Obra\s+Social\s*:\s*(.+?)(?:\s*-\s*Empresa|\s*$)", combined, re.I | re.M)
    if not m_os:
        m_os = re.search(r"Obra\s+Social\s*:\s*(.+?)(?:\s*-\s*Empresa|\s*$)", plain_full, re.I | re.M)
    if m_os:
        raw_os_span = re.sub(r"\s+", " ", m_os.group(1)).strip(" -")
        # Geclisa suele mostrar "OMINT - OMINT" (desde - hasta)
        parts = [p.strip() for p in raw_os_span.split(" - ") if p.strip()]
        os_nombre_raw = parts[0] if parts else raw_os_span

    # También buscar "517 - OMINT" en las líneas de detalle si faltaba código o nombre
    if not os_cod or not os_nombre_raw:
        m_det_os = re.search(r"^\s*(\d{2,5})\s*-\s*([A-ZÁÉÍÓÚÑ0-9 ./]{2,40})\s*$", plain_full, re.M)
        if m_det_os:
            if not os_cod:
                os_cod = m_det_os.group(1).strip()
            if not os_nombre_raw:
                os_nombre_raw = m_det_os.group(2).strip()

    if not os_nombre_raw and agente_raw:
        os_nombre_raw = agente_raw

    # Matching contra financiadoras de la empresa activa
    by_norm, by_code, aliases = excel_importer.build_financiadora_lookup(financiadoras_list)
    fin_by_id = {f["id"]: f for f in financiadoras_list}
    matched_fin = None
    for cand in [os_nombre_raw, agente_raw]:
        if cand:
            matched_fin = excel_importer.match_financiadora(cand, os_cod, by_norm, by_code, aliases, fin_by_id)
            if matched_fin:
                break
    if not matched_fin and os_cod:
        matched_fin = excel_importer.match_financiadora("", os_cod, by_norm, by_code, aliases, fin_by_id)

    # 5. Extraer facturas (probar ambos modos y quedarse con el que capture más comprobantes)
    facturas_layout = parse_invoices_from_text(layout_full) if layout_full.strip() else []
    facturas_plain = parse_invoices_from_text(plain_full) if plain_full.strip() else []
    facturas = facturas_layout if len(facturas_layout) >= len(facturas_plain) else facturas_plain

    # 6. Extraer Totales Generales del pie del PDF para validar
    tot_neto_pdf = None
    tot_iva_pdf = None
    tot_gen_pdf = None
    for txt in (layout_full, plain_full):
        m_tot = re.search(r"Totales\s+Generales\s*:\s*(.+)", txt, re.I)
        if m_tot:
            tnums = [parse_money_str(tok) for tok in MONEY_RE.findall(m_tot.group(1))]
            if len(tnums) >= 3:
                tot_neto_pdf, tot_iva_pdf, tot_gen_pdf = tnums[-3], tnums[-2], tnums[-1]
                break
            elif len(tnums) == 1:
                tot_gen_pdf = tnums[0]
                break

    sum_neto = round(sum(f["neto"] for f in facturas), 2)
    sum_iva = round(sum(f["iva"] for f in facturas), 2)
    sum_total = round(sum(f["total"] for f in facturas), 2)

    total_neto = tot_neto_pdf if (tot_neto_pdf is not None and (not facturas or abs(tot_neto_pdf - sum_neto) < 1.0)) else (sum_neto if facturas else (tot_neto_pdf or 0.0))
    total_iva = tot_iva_pdf if (tot_iva_pdf is not None and (not facturas or abs(tot_iva_pdf - sum_iva) < 1.0)) else (sum_iva if facturas else (tot_iva_pdf or 0.0))
    total_general = tot_gen_pdf if (tot_gen_pdf is not None and (not facturas or abs(tot_gen_pdf - sum_total) < 1.0)) else (sum_total if facturas else (tot_gen_pdf or 0.0))

    # 7. Condición IVA automática (Exento / Gravado / Gravado y Exento)
    cant_exento = sum(1 for f in facturas if abs(f["iva"]) <= 0.005)
    cant_gravado = sum(1 for f in facturas if abs(f["iva"]) > 0.005)
    total_exento = round(sum(f["total"] for f in facturas if abs(f["iva"]) <= 0.005), 2)
    total_gravado = round(sum(f["total"] for f in facturas if abs(f["iva"]) > 0.005), 2)

    if facturas:
        if cant_gravado == 0:
            condicion_iva = "Exento"
        elif cant_exento == 0:
            condicion_iva = "Gravado"
        else:
            condicion_iva = "Gravado y Exento"
    else:
        if total_general > 0 and abs(total_iva) <= 0.005:
            condicion_iva = "Exento"
        elif abs(total_iva) > 0.005:
            condicion_iva = "Gravado"
        else:
            condicion_iva = ""

    return {
        "filename": filename,
        "pages": len(pages),
        "period": period,
        "area": area,
        "empresa_raw": empresa_raw,
        "empresa_detectada": empresa_detectada,
        "os_cod": matched_fin.get("codigo", os_cod) if matched_fin and matched_fin.get("codigo") else os_cod,
        "os_nombre": matched_fin["nombre"] if matched_fin else (os_nombre_raw.upper() if os_nombre_raw else ""),
        "os_nombre_raw": os_nombre_raw,
        "agente_raw": agente_raw,
        "financiadora_id": matched_fin["id"] if matched_fin else "",
        "grupo": ("art" if matched_fin.get("categoria") == "art" else "directas") if matched_fin else "directas",
        "matched": bool(matched_fin),
        "condicion_iva": condicion_iva,
        "cant_facturas": len(facturas),
        "cant_exento": cant_exento,
        "cant_gravado": cant_gravado,
        "total_exento": total_exento,
        "total_gravado": total_gravado,
        "total_neto": total_neto,
        "total_iva": total_iva,
        "total_general": total_general,
        "resumen_facturas": build_facturas_resumen(facturas, filename),
        "facturas": facturas,
    }
