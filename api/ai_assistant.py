#!/usr/bin/env python3
"""
Asistente IA acotado exclusivamente al Centro de Exportación y Facturación (IMRC / PPSL).
- Opera 100% sobre los datos de la empresa activa (aislamiento estricto IMRC vs PPSL).
- Funciona de inmediato en modo local inteligente (sin API key, sin costo y sin sacar datos de la red LAN).
- Opcionalmente soporta Gemini API (si el Administrador configura una API key), con RAG estricto
  del portal, sin enviar contraseñas fuera de la red y bloqueando cualquier consulta fuera de tema.
"""

import json
import os
import re
from typing import Dict, Any, List, Optional

import excel_importer


PORTAL_KEYWORDS = {
    "obra social", "obras sociales", "financiadora", "financiadoras", "prepaga", "art", "seguro",
    "clave", "claves", "contrasena", "password", "usuario", "usuarios", "acceso", "portal", "web",
    "link", "url", "mail", "mails", "email", "emails", "correo", "correos", "webmail", "gmail",
    "casilla", "asunto", "nomenclatura", "archivo", "archivos", "txt", "drive", "fisico", "sobre",
    "vencimiento", "vencimientos", "fecha tope", "plazo", "ambulatorio", "internado", "internacion",
    "factura", "facturas", "facturacion", "exportacion", "exportar", "geclisa", "pdf", "pdf24",
    "excel", "planilla", "control mensual", "envio", "envios", "enviado", "enviados", "monto",
    "montos", "importe", "importes", "total", "totales", "facturado", "refacturacion", "arancel",
    "diferencia", "preliquidacion", "pendiente", "pendientes", "falta", "faltan", "periodo",
    "andreani", "postal", "seguimiento", "transito", "entrega", "entregas", "entregado", "bandeja",
    "tarea", "tareas", "facturista", "facturistas", "cuit", "carpeta", "ruta", "rutas", "imrc",
    "ppsl", "san lucas", "instituto medico", "colegio medico", "exento", "gravado", "historia clinica",
    "hc", "scanner", "escaner", "siniestro", "siniestros", "prestador", "prevenet", "cidi", "extranet",
    "comprobante", "comprobantes", "liquidacion", "presentacion", "presentaciones", "debito", "auditoria",
    "ayuda", "como funciona", "que podes hacer", "que sabes",
}

OFFTOPIC_HINTS = {
    "receta", "cocinar", "clima", "tiempo hoy", "pronostico", "futbol", "mundial", "partido",
    "chiste", "poema", "cancion", "pelicula", "serie", "horoscopo", "politica", "presidente",
    "dolar blue", "cripto", "bitcoin", "traducime", "ingles", "historia universal", "capital de",
}


def fmt_money(val: float) -> str:
    n = float(val or 0.0)
    s = f"{n:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"$ {s}"


def find_mentioned_financiadoras(q_norm: str, financiadoras: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    scored = []
    q_tokens = [t for t in re.findall(r"[a-z0-9]+", q_norm) if len(t) >= 3]
    stop = {
        "como", "cual", "cuales", "donde", "cuando", "cuanto", "para", "como", "tiene", "tienen",
        "clave", "claves", "usuario", "mail", "mails", "email", "correo", "portal", "envio",
        "envios", "enviar", "envia", "factura", "facturar", "ambulatorio", "internado", "periodo",
        "vencimiento", "archivo", "archivos", "monto", "total", "obra", "social", "salud",
        "seguro", "seguros", "datos", "ficha", "instrucciones", "normativa", "pasos", "entrego",
    }
    meaningful = [t for t in q_tokens if t not in stop]

    for f in financiadoras:
        fname = excel_importer.norm_text(f.get("nombre", ""))
        fcod = str(f.get("codigo", "")).strip()
        score = 0
        if fname and fname in q_norm:
            score += 100 + len(fname)
        elif fcod and re.search(rf"\b{re.escape(fcod)}\b", q_norm):
            score += 90
        else:
            f_tokens = [t for t in re.findall(r"[a-z0-9]+", fname) if len(t) >= 3 and t not in ("art", "pmo", "obra", "social", "salud", "seguro", "seguros", "seg")]
            hits = sum(1 for ft in f_tokens if ft in meaningful or (len(ft) >= 4 and ft in q_norm))
            if hits > 0:
                score += hits * 35
                if f_tokens and hits == len(f_tokens):
                    score += 30
        if score > 0:
            scored.append((score, f))

    scored.sort(key=lambda x: x[0], reverse=True)
    if not scored:
        return []
    top_score = scored[0][0]
    return [f for sc, f in scored if sc >= max(35, top_score - 25)][:4]


def is_portal_related(q_norm: str, matched_fins: List[Dict[str, Any]]) -> bool:
    if matched_fins:
        return True
    if any(off in q_norm for off in OFFTOPIC_HINTS):
        # Permitir solo si además menciona un término inequívoco del portal
        if not any(kw in q_norm for kw in ("geclisa", "imrc", "ppsl", "andreani", "obra social", "financiadora", "facturacion", "control mensual")):
            return False
    if re.search(r"\b20\d{2}[-/]?(0[1-9]|1[0-2])\b", q_norm):
        return True
    for kw in PORTAL_KEYWORDS:
        if kw in q_norm:
            return True
    return False


def extract_query_period(q_norm: str, available_periods: List[str]) -> str:
    p = excel_importer.detect_period_from_text(q_norm)
    if p:
        return p
    if any(w in q_norm for w in ("ultimo mes", "este mes", "mes actual", "reciente")) and available_periods:
        return available_periods[0]
    return ""


def call_gemini_optional(
    api_key: str,
    question: str,
    company: Dict[str, Any],
    context_summary: str,
) -> Optional[str]:
    """Llamada opcional a Gemini API usando únicamente contexto del portal (sin contraseñas)."""
    if not api_key:
        return None
    try:
        import requests
    except ImportError:
        return None

    system_prompt = (
        f"Sos el asistente interno exclusivo del Centro de Exportación y Facturación de "
        f"{company.get('nombre', '')} ({company.get('sigla', '')}).\n"
        "REGLAS ESTRICTAS:\n"
        "1. SOLO respondés preguntas sobre este portal (financiadoras, normativas de exportación, "
        "emails, portales web, Geclisa, Control Mensual de envíos/montos, envíos Andreani y Bandeja de Tareas).\n"
        "2. Si el usuario pregunta cualquier cosa ajena al portal (recetas, clima, deportes, noticias, "
        "programación general, etc.), respondé únicamente que solo asistís sobre temas de este portal.\n"
        "3. Basate EXCLUSIVAMENTE en los DATOS DEL PORTAL provistos abajo. No inventes emails, montos ni fechas.\n"
        "4. Respondé en español rioplatense, de forma clara, breve y accionable (con viñetas si ayuda)."
    )

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": f"DATOS DEL PORTAL ({company.get('sigla', '')}):\n{context_summary}\n\nPREGUNTA DEL USUARIO:\n{question}"}
                ],
            }
        ],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 600},
    }
    try:
        resp = requests.post(url, json=payload, timeout=12)
        if resp.status_code != 200:
            return None
        data = resp.json()
        cands = data.get("candidates") or []
        if not cands:
            return None
        parts = (cands[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        return text or None
    except Exception:
        return None


def build_safe_rag_context(
    company: Dict[str, Any],
    institution: Dict[str, Any],
    matched_fins: List[Dict[str, Any]],
    financiadoras: List[Dict[str, Any]],
    general_guide: List[Dict[str, Any]],
    envios: List[Dict[str, Any]],
    postal: List[Dict[str, Any]],
    entregas: List[Dict[str, Any]],
) -> str:
    """Construye un resumen RAG acotado (SIN contraseñas) para consultas con Gemini opcional."""
    lines = [
        f"Empresa activa: {company.get('nombre')} ({company.get('sigla')})",
        f"CUIT: {institution.get('cuitGuiones') or institution.get('cuit', '')} | Email principal: {institution.get('emailPrincipal', '')}",
        f"Total financiadoras registradas: {len(financiadoras)}",
    ]
    if matched_fins:
        lines.append("\nFinanciadoras relevantes:")
        for f in matched_fins[:3]:
            emails = ", ".join(e.get("address", "") for e in f.get("emails", []))
            portales = ", ".join(p.get("url", "") for p in f.get("portales", []))
            lines.append(
                f"- {f['nombre']} (Cód: {f.get('codigo') or '—'}, Cat: {f.get('categoria')}, "
                f"Canales: {', '.join(f.get('canales', []))}, Venc: {f.get('vencimiento') or 'Sin tope'})\n"
                f"  Amb: {f.get('ambulatorio') or '—'} | Int: {f.get('internado') or '—'}\n"
                f"  Archivos: {', '.join(f.get('archivos', []))}\n"
                f"  Asunto/Regla: {f.get('asuntoRegla') or '—'}\n"
                f"  Portales: {portales or '—'} | Emails: {emails or '—'}\n"
                f"  Instrucciones: {(f.get('instrucciones') or '')[:450]}"
            )
    periods = sorted({e.get("period", "") for e in envios if e.get("period")}, reverse=True)[:3]
    if periods:
        lines.append("\nResumen Control Mensual (últimos períodos):")
        for per in periods:
            pe = [e for e in envios if e.get("period") == per]
            tot = sum(float(e.get("importe", 0) or 0) for e in pe)
            lines.append(f"- Período {per}: {len(pe)} envíos, total {fmt_money(tot)}")
    pend_ent = [e for e in entregas if e.get("estado") in ("pendiente", "en_proceso")]
    if pend_ent:
        lines.append(f"\nBandeja de tareas activas ({len(pend_ent)}):")
        for e in pend_ent[:8]:
            lines.append(f"- {e['os_nombre']} ({e['area']} {e['period']}, {e['estado']}, por {e['created_by_name']})")
    in_tr = [p for p in postal if not p.get("fecha_entrega")]
    if in_tr:
        lines.append(f"\nEnvíos Andreani en tránsito ({len(in_tr)}): " + ", ".join(f"{p['obra_social']} ({p['seguimiento']})" for p in in_tr[:8]))
    if general_guide:
        lines.append("\nGuía General: " + "; ".join(f"{s.get('numero')}. {s.get('titulo')}" for s in general_guide[:6]))
    return "\n".join(lines)[:4500]


def answer_portal_question(
    question: str,
    company: Dict[str, Any],
    institution: Dict[str, Any],
    financiadoras: List[Dict[str, Any]],
    general_guide: List[Dict[str, Any]],
    envios: List[Dict[str, Any]],
    postal: List[Dict[str, Any]],
    entregas: List[Dict[str, Any]],
    gemini_api_key: str = "",
) -> Dict[str, Any]:
    """Responde consultas exclusivamente del portal para la empresa activa."""
    q = str(question or "").strip()
    if not q:
        return {
            "in_scope": True,
            "engine": "local",
            "answer": "Escribí una consulta sobre este portal (por ejemplo: clave o email de una obra social, vencimientos, total enviado de un período, envíos Andreani en tránsito o tareas pendientes).",
            "actions": [],
            "suggestions": [
                "¿Qué obras sociales tienen vencimiento?",
                "¿Cuál fue el total enviado del último período?",
                "¿Qué tareas pendientes hay en la bandeja?",
                "¿Qué envíos de Andreani están en tránsito?",
            ],
        }

    q_norm = excel_importer.norm_text(q)
    sigla = company.get("sigla", "PORTAL")
    matched_fins = find_mentioned_financiadoras(q_norm, financiadoras)

    if not is_portal_related(q_norm, matched_fins):
        return {
            "in_scope": False,
            "engine": "guardrail",
            "answer": (
                f"Solo puedo responder consultas relacionadas con este portal de Facturación y Exportación (**{sigla} — {company.get('nombre', '')}**).\n\n"
                "Podés preguntarme por: **claves, emails, portales o normativas** de cualquier financiadora, **vencimientos**, "
                "**requisitos de TXT/Drive**, **totales o faltantes del Control Mensual**, **seguimiento Andreani**, "
                "**Guía Geclisa/PDF24** o **tareas pendientes de facturistas**."
            ),
            "actions": [],
            "suggestions": [
                "¿Qué obras sociales tienen vencimiento?",
                "¿Qué financiadoras requieren archivo TXT?",
                "¿Cuál fue el total enviado del último período?",
                "¿Qué entregas pendientes hay en la bandeja?",
            ],
        }

    actions: List[Dict[str, Any]] = []
    periods_avail = sorted({e.get("period", "") for e in envios if e.get("period")}, reverse=True)
    req_period = extract_query_period(q_norm, periods_avail)

    # Detección de intenciones
    asks_help = any(w in q_norm for w in ("que podes hacer", "que sabes", "ayuda", "como funciona"))
    asks_creds = any(w in q_norm for w in ("clave", "claves", "contrasena", "password", "usuario", "usuarios", "acceso", "login", "ingresar"))
    asks_email = any(w in q_norm for w in ("mail", "mails", "email", "emails", "correo", "correos", "casilla", "webmail", "gmail"))
    asks_portal = any(w in q_norm for w in ("portal", "link", "pagina", "url", "web"))
    asks_money = any(w in q_norm for w in ("cuanto", "monto", "montos", "importe", "total", "totales", "facturado", "enviado", "enviamos", "control mensual", "refact"))
    asks_missing = any(w in q_norm for w in ("falta", "faltan", "sin enviar", "faltante", "faltantes"))
    asks_postal = any(w in q_norm for w in ("andreani", "postal", "seguimiento", "transito", "correo fisico", "sobre"))
    asks_tasks = any(w in q_norm for w in ("bandeja", "tarea", "tareas", "facturista", "entregas pendientes", "entregaron", "entrego"))
    asks_deadlines = any(w in q_norm for w in ("vencimiento", "vencimientos", "fecha tope", "plazo", "vence"))
    asks_channel = any(w in q_norm for w in ("requieren txt", "llevan txt", "con txt", "por drive", "usan drive", "envio fisico", "por portal"))
    asks_guide = any(w in q_norm for w in ("geclisa", "pdf24", "como export", "guia general", "unificar txt", "rotar", "hojas en blanco"))
    asks_inst = any(w in q_norm for w in ("cuit", "carpeta", "ruta", "rutas", "razon social", "mail institucional", "gmail de " + sigla.lower(), "clave gmail"))

    # 1. Ayuda general del asistente
    if asks_help and not matched_fins:
        return {
            "in_scope": True,
            "engine": "local",
            "answer": (
                f"Estoy conectado a los datos exclusivos de **{sigla} ({company.get('nombre', '')})**. Puedo ayudarte al instante con:\n"
                "• **Financiadoras:** claves, usuarios, casillas de correo, portales, vencimientos y normativas (Ambulatorio / Internado).\n"
                "• **Control Mensual:** totales enviados por período, desglose Ambulatorio/Internado/ART y obras sociales pendientes.\n"
                "• **Bandeja de Tareas:** entregas cargadas por los facturistas pendientes de despacho.\n"
                "• **Envíos Andreani:** paquetes en tránsito, números de seguimiento y fechas de entrega.\n"
                "• **Guía Geclisa / Datos institucionales:** CUIT, carpetas compartidas y pasos de exportación."
            ),
            "actions": [],
            "suggestions": [
                "¿Qué obras sociales tienen vencimiento?",
                "¿Cuánto se envió en el último período?",
                "¿Qué entregas pendientes hay?",
                f"¿Cuál es el CUIT y mail principal de {sigla}?",
            ],
        }

    # 2. Consultas sobre una o varias financiadoras específicas
    if matched_fins:
        fin = matched_fins[0]
        actions.append({"type": "open_fin", "id": fin["id"], "label": f"🏥 Abrir ficha de {fin['nombre']}"})
        if fin.get("portales"):
            actions.append({"type": "open_url", "url": fin["portales"][0]["url"], "label": f"🌐 {fin['portales'][0].get('label') or 'Abrir Portal'}"})
        if fin.get("emails"):
            all_em = "; ".join(e["address"] for e in fin["emails"] if e.get("address"))
            actions.append({"type": "copy", "value": all_em, "label": f"📋 Copiar {len(fin['emails'])} mail(s)"})

        # 2a. ¿Consultó montos / envíos de esa financiadora?
        if asks_money and not (asks_creds or asks_email):
            fin_envs = [
                e for e in envios
                if (e.get("financiadora_id") == fin["id"]) or (excel_importer.norm_text(e.get("os_nombre")) == excel_importer.norm_text(fin["nombre"]))
            ]
            if req_period:
                fin_envs = [e for e in fin_envs if e.get("period") == req_period]
            if not fin_envs:
                p_txt = f" en el período **{req_period}**" if req_period else ""
                return {
                    "in_scope": True,
                    "engine": "local",
                    "answer": f"En **{sigla}** no hay envíos registrados para **{fin['nombre']}**{p_txt}.",
                    "actions": actions + [{"type": "switch_view", "view": "seguimiento", "period": req_period or (periods_avail[0] if periods_avail else ""), "label": "📊 Ver Control Mensual"}],
                }
            target_per = req_period or fin_envs[0]["period"]
            per_envs = [e for e in fin_envs if e["period"] == target_per]
            tot_amb = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("area") == "ambulatorio")
            tot_int = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("area") == "internado")
            lines = [
                f"**{fin['nombre']} — Período {target_per} ({sigla})**:",
                f"• Total enviado: **{fmt_money(tot_amb + tot_int)}** ({len(per_envs)} registro/s)",
                f"• Ambulatorio: **{fmt_money(tot_amb)}** | Internado: **{fmt_money(tot_int)}**",
            ]
            for e in per_envs[:6]:
                tag = f" [{e['etiqueta']}]" if e.get("etiqueta") else ""
                lines.append(f"  - {e.get('fecha_envio') or 'sin fecha'} · {e['area'].capitalize()}{tag}: {fmt_money(e.get('importe', 0))}")
            actions.append({"type": "switch_view", "view": "seguimiento", "period": target_per, "label": f"📊 Ir a Control {target_per}"})
            return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

        # 2b. ¿Consultó Andreani de esa financiadora?
        if asks_postal:
            fn = excel_importer.norm_text(fin["nombre"])
            p_rows = [p for p in postal if fn in excel_importer.norm_text(p.get("obra_social", "")) or excel_importer.norm_text(p.get("obra_social", "")) in fn]
            if not p_rows:
                return {
                    "in_scope": True,
                    "engine": "local",
                    "answer": f"No hay envíos postales registrados en Andreani para **{fin['nombre']}** ({sigla}).",
                    "actions": actions + [{"type": "switch_view", "view": "postal", "label": "📦 Ver Envíos Andreani"}],
                }
            lines = [f"**Envíos postales de {fin['nombre']} ({sigla})** — últimos registros:"]
            for p in p_rows[:5]:
                est = f"✅ Entregado {p['fecha_entrega']}" if p.get("fecha_entrega") else "🚚 En tránsito"
                lines.append(f"• {p.get('fecha_envio') or '—'} · {p.get('medio')} `{p.get('seguimiento') or 's/n'}` · {est}")
            actions.append({"type": "switch_view", "view": "postal", "label": "📦 Abrir Envíos Andreani"})
            return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

        # 2c. Ficha / Credenciales / Emails / Normativa de esa financiadora (si pide clave, responder siempre local por seguridad)
        lines = [f"**{fin['nombre']}** ({sigla}" + (f" · Cód. {fin['codigo']}" if fin.get("codigo") else "") + "):"]
        if asks_creds or (not asks_email and not asks_portal and fin.get("credenciales")):
            if fin.get("credenciales"):
                lines.append("🔑 **Credenciales:**")
                for c in fin["credenciales"]:
                    extra = f" ({c['extra']})" if c.get("extra") else ""
                    lines.append(f"• {c.get('label') or 'Acceso'}: usuario `{c.get('usuario') or '—'}` | clave `{c.get('clave') or 'sin definir'}`{extra}")
                    if c.get("usuario"):
                        actions.append({"type": "copy", "value": c["usuario"], "label": f"📋 Copiar usuario"})
                    if c.get("clave"):
                        actions.append({"type": "copy", "value": c["clave"], "label": f"🔑 Copiar clave"})
            elif asks_creds:
                lines.append("• Esta financiadora no tiene credenciales de portal registradas.")

        if asks_email or (not asks_creds and fin.get("emails")):
            if fin.get("emails"):
                lines.append("✉️ **Casillas de correo:**")
                for e in fin["emails"]:
                    lines.append(f"• `{e['address']}`" + (f" ({e['label']})" if e.get("label") else ""))
            elif asks_email:
                lines.append("• No tiene casillas de correo registradas (se gestiona por otro canal).")

        if asks_portal or (not asks_creds and not asks_email and fin.get("portales")):
            if fin.get("portales"):
                lines.append("🌐 **Portales:** " + ", ".join(p["url"] for p in fin["portales"]))

        if not (asks_creds and not asks_email and not asks_portal):
            if fin.get("vencimiento"):
                lines.append(f"⏰ **Vencimiento:** {fin['vencimiento']}")
            if fin.get("ambulatorio"):
                lines.append(f"🩺 **Ambulatorio:** {fin['ambulatorio']}")
            if fin.get("internado"):
                lines.append(f"🏥 **Internado:** {fin['internado']}")
            if fin.get("asuntoRegla"):
                lines.append(f"📌 **Regla de asunto / archivo:** {fin['asuntoRegla']}")
            if fin.get("archivos"):
                lines.append(f"📎 **Archivos:** {', '.join(fin['archivos'])}")
            if not asks_email and not asks_portal and fin.get("instrucciones"):
                inst_short = fin["instrucciones"].strip()
                if len(inst_short) > 360:
                    inst_short = inst_short[:357] + "..."
                lines.append(f"📋 **Resumen:** {inst_short}")

        # Si hay Gemini configurado y NO preguntó por contraseñas, enriquecer si es pregunta abierta
        if gemini_api_key and not asks_creds and len(q.split()) >= 5:
            rag_ctx = build_safe_rag_context(company, institution, matched_fins, financiadoras, general_guide, envios, postal, entregas)
            gem_ans = call_gemini_optional(gemini_api_key, q, company, rag_ctx)
            if gem_ans:
                return {"in_scope": True, "engine": "gemini", "answer": gem_ans, "actions": actions[:5]}

        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions[:5]}

    # 3. Consultas sobre Bandeja de Tareas / Entregas de Facturistas
    if asks_tasks:
        pend = [e for e in entregas if e.get("estado") == "pendiente"]
        proc = [e for e in entregas if e.get("estado") == "en_proceso"]
        obs = [e for e in entregas if e.get("estado") == "observado"]
        actions.append({"type": "switch_view", "view": "tareas", "label": "📥 Abrir Bandeja de Tareas"})
        if not pend and not proc and not obs:
            return {
                "in_scope": True,
                "engine": "local",
                "answer": f"¡Al día! No hay tareas pendientes ni en proceso en la Bandeja de Tareas de **{sigla}**.",
                "actions": actions,
            }
        lines = [
            f"**Bandeja de Tareas ({sigla}):** {len(pend)} pendiente(s), {len(proc)} en proceso, {len(obs)} observada(s)."
        ]
        for e in (pend + proc)[:8]:
            cond = f" · {e['condicion']}" if e.get("condicion") else ""
            imp = f" · {fmt_money(e['importe'])}" if float(e.get("importe") or 0) > 0 else ""
            lines.append(f"• **{e['os_nombre']}** ({e['area']} {e['period']}{cond}{imp}) — por {e['created_by_name']} [{e['estado']}]")
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 4. Consultas sobre Envíos Andreani / Postal
    if asks_postal:
        in_tr = [p for p in postal if not p.get("fecha_entrega")]
        actions.append({"type": "switch_view", "view": "postal", "label": "📦 Abrir Envíos Andreani"})
        if not postal:
            return {
                "in_scope": True,
                "engine": "local",
                "answer": f"No hay envíos postales registrados en **{sigla}**.",
                "actions": actions,
            }
        lines = [f"**Seguimiento Postal Andreani ({sigla}):** {len(in_tr)} en tránsito de {len(postal)} totales."]
        for p in (in_tr[:8] if in_tr else postal[:6]):
            est = "🚚 En tránsito" if not p.get("fecha_entrega") else f"✅ Entregado {p['fecha_entrega']}"
            lines.append(f"• **{p['obra_social']}** ({p.get('fecha_envio') or '—'}) · `{p.get('seguimiento') or 's/n'}` · {est}")
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 5. Consultas sobre Vencimientos
    if asks_deadlines:
        with_dl = [f for f in financiadoras if (f.get("vencimiento") or "").strip()]
        if not with_dl:
            return {"in_scope": True, "engine": "local", "answer": f"No hay fechas de vencimiento específicas cargadas en **{sigla}**.", "actions": []}
        lines = [f"**Financiadoras con vencimiento / fecha tope en {sigla} ({len(with_dl)}):**"]
        for f in with_dl[:15]:
            lines.append(f"• **{f['nombre']}**: {f['vencimiento']}")
        for f in with_dl[:4]:
            actions.append({"type": "open_fin", "id": f["id"], "label": f"🏥 {f['nombre']}"})
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 6. Consultas por canal (TXT, Drive, Físico, Portal)
    if asks_channel:
        ch_key, ch_lbl = None, ""
        if "txt" in q_norm:
            ch_key, ch_lbl = "txt", "Archivo TXT (Exp. Fact.)"
        elif "drive" in q_norm:
            ch_key, ch_lbl = "drive", "Google Drive"
        elif "fisico" in q_norm or "sobre" in q_norm:
            ch_key, ch_lbl = "fisico", "Envío Físico"
        elif "portal" in q_norm:
            ch_key, ch_lbl = "portal", "Portal Web"
        if ch_key:
            hits = [f for f in financiadoras if ch_key in (f.get("canales") or [])]
            lines = [f"**Financiadoras con {ch_lbl} en {sigla} ({len(hits)}):**"]
            lines.append(", ".join(f"**{f['nombre']}**" for f in hits) if hits else "Ninguna registrada con ese canal.")
            for f in hits[:4]:
                actions.append({"type": "open_fin", "id": f["id"], "label": f"🏥 {f['nombre']}"})
            return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 7. Faltantes del Control Mensual
    if asks_missing:
        target_per = req_period or (periods_avail[0] if periods_avail else "")
        if not target_per:
            return {"in_scope": True, "engine": "local", "answer": f"Aún no hay períodos cargados en Control Mensual para **{sigla}**.", "actions": []}
        per_envs = [e for e in envios if e.get("period") == target_per]
        sent_ids = {e.get("financiadora_id") for e in per_envs if e.get("financiadora_id")}
        sent_names = {excel_importer.norm_text(e.get("os_nombre")) for e in per_envs}
        missing = [
            f for f in financiadoras
            if f["id"] not in sent_ids and excel_importer.norm_text(f["nombre"]) not in sent_names
        ]
        actions.append({"type": "switch_view", "view": "seguimiento", "period": target_per, "label": f"📊 Ver Control {target_per}"})
        lines = [
            f"**Financiadoras sin envíos registrados en {target_per} ({sigla}):** {len(missing)} de {len(financiadoras)}.",
        ]
        if missing:
            sample = ", ".join(f["nombre"] for f in missing[:18])
            more = f" (+{len(missing) - 18} más)" if len(missing) > 18 else ""
            lines.append(f"• {sample}{more}")
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 8. Totales / Control Mensual por período
    if asks_money or req_period:
        target_per = req_period or (periods_avail[0] if periods_avail else "")
        if not target_per:
            return {"in_scope": True, "engine": "local", "answer": f"No hay envíos cargados en el Control Mensual de **{sigla}**.", "actions": []}
        per_envs = [e for e in envios if e.get("period") == target_per]
        tot_amb = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("area") == "ambulatorio")
        tot_int = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("area") == "internado")
        tot_dir = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("grupo") != "art")
        tot_art = sum(float(e.get("importe", 0) or 0) for e in per_envs if e.get("grupo") == "art")
        actions.append({"type": "switch_view", "view": "seguimiento", "period": target_per, "label": f"📊 Abrir Control {target_per}"})
        lines = [
            f"**Resumen Control Mensual — Período {target_per} ({sigla}):**",
            f"• **Total General:** {fmt_money(tot_amb + tot_int)} ({len(per_envs)} envíos registrados)",
            f"• Ambulatorio: **{fmt_money(tot_amb)}** | Internado: **{fmt_money(tot_int)}**",
            f"• Directas / Obras Sociales: **{fmt_money(tot_dir)}** | ART y Seguros: **{fmt_money(tot_art)}**",
        ]
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 9. Datos institucionales (CUIT, mails, rutas)
    if asks_inst:
        lines = [f"**Datos institucionales de {company.get('nombre', sigla)} ({sigla}):**"]
        if institution.get("cuitGuiones") or institution.get("cuit"):
            cuit_v = institution.get("cuitGuiones") or institution.get("cuit")
            lines.append(f"• **CUIT:** `{cuit_v}` (sin guiones: `{institution.get('cuit', '')}`)")
            actions.append({"type": "copy", "value": institution.get("cuit", cuit_v), "label": "📋 Copiar CUIT"})
        if institution.get("emailPrincipal"):
            lines.append(f"• **Email principal:** `{institution['emailPrincipal']}`")
            actions.append({"type": "copy", "value": institution["emailPrincipal"], "label": "📋 Copiar email"})
        if institution.get("emailPrincipalClave"):
            lines.append(f"• **Clave Gmail:** `{institution['emailPrincipalClave']}`")
            actions.append({"type": "copy", "value": institution["emailPrincipalClave"], "label": "🔑 Copiar clave"})
        for r in institution.get("rutas") or []:
            lines.append(f"• **{r['label']}:** `{r['path']}`")
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions[:4]}

    # 10. Guía General (Geclisa / PDF24)
    if asks_guide and general_guide:
        best = general_guide[0]
        best_score = -1
        q_words = [w for w in re.findall(r"[a-z0-9]+", q_norm) if len(w) >= 3]
        for s in general_guide:
            hay = excel_importer.norm_text(f"{s.get('titulo')} {s.get('subtitulo')} {' '.join(s.get('pasos', []))}")
            sc = sum(1 for w in q_words if w in hay)
            if sc > best_score:
                best_score = sc
                best = s
        lines = [f"**Guía General ({sigla}) — Paso {best.get('numero')}: {best.get('titulo')}**"]
        for i, p in enumerate(best.get("pasos") or [], 1):
            lines.append(f"{i}. {p}")
        actions.append({"type": "switch_view", "view": "guia", "label": "📘 Ver Guía General completa"})
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions}

    # 11. Fallback opcional con Gemini (si el admin configuró API key) o búsqueda contextual local
    if gemini_api_key:
        rag_ctx = build_safe_rag_context(company, institution, matched_fins, financiadoras, general_guide, envios, postal, entregas)
        gem_ans = call_gemini_optional(gemini_api_key, q, company, rag_ctx)
        if gem_ans:
            return {"in_scope": True, "engine": "gemini", "answer": gem_ans, "actions": actions}

    # Búsqueda full-text sobre instrucciones/notas de financiadoras de la empresa activa
    q_words = [w for w in re.findall(r"[a-z0-9]+", q_norm) if len(w) >= 4]
    text_hits = []
    for f in financiadoras:
        hay = excel_importer.norm_text(
            f"{f.get('nombre')} {f.get('ambulatorio')} {f.get('internado')} {f.get('asuntoRegla')} {f.get('instrucciones')} {f.get('notasInternas')}"
        )
        sc = sum(1 for w in q_words if w in hay)
        if sc > 0:
            text_hits.append((sc, f))
    text_hits.sort(key=lambda x: x[0], reverse=True)
    if text_hits:
        top = [f for _, f in text_hits[:5]]
        lines = [f"Encontré coincidencias en **{sigla}** relacionadas con tu consulta:"]
        for f in top:
            snip = (f.get("asuntoRegla") or f.get("ambulatorio") or f.get("instrucciones") or "")[:120]
            lines.append(f"• **{f['nombre']}**: {snip}")
            actions.append({"type": "open_fin", "id": f["id"], "label": f"🏥 {f['nombre']}"})
        return {"in_scope": True, "engine": "local", "answer": "\n".join(lines), "actions": actions[:4]}

    return {
        "in_scope": True,
        "engine": "local",
        "answer": (
            f"No encontré un dato exacto para «{q}» en **{sigla}**. "
            "Probá incluir el nombre de una financiadora (ej. *clave de OSDE*, *mail de Swiss Medical*) o preguntar por vencimientos, totales de un período, Andreani o Bandeja de Tareas."
        ),
        "actions": [],
        "suggestions": [
            "¿Qué obras sociales tienen vencimiento?",
            "¿Cuál fue el total enviado del último período?",
            "¿Qué entregas pendientes hay?",
        ],
    }
