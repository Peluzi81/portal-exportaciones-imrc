#!/usr/bin/env python3
"""
API Serverless para Vercel + Supabase (Starlette ASGI)
Centro de Exportación y Facturación — Multi-Empresa (IMRC / PPSL)
- Base de datos: PostgreSQL en Supabase (vía PostgREST + service_role key)
- Archivos privados (PDFs de Geclisa y capturas): Supabase Storage (bucket 'uploads')
- Autenticación: PBKDF2-SHA256 + sesiones en Supabase + cookies HttpOnly/Secure/SameSite=Lax
- Roles: admin, exportacion, consulta, facturista (eliminación exclusiva de admin)
"""

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

# Asegurar imports relativos desde la carpeta api/
API_DIR = os.path.dirname(os.path.abspath(__file__))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import ai_assistant
import excel_importer
import pdf_parser
from supabase_client import SupabaseClient, SupabaseError

ASSETS_IMG_DIR = os.path.join(API_DIR, "assets_img")
STORAGE_BUCKET = "uploads"
DEFAULT_COMPANY_ID = "imrc"
SESSION_HOURS = 12
COOKIE_NAME = "imrc_session"
PBKDF2_ITERATIONS = 260_000
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 5

# Zona horaria Argentina (UTC-3)
AR_TZ = timezone(timedelta(hours=-3))

_DB_CLIENT: Optional[SupabaseClient] = None


def get_db() -> SupabaseClient:
    global _DB_CLIENT
    if _DB_CLIENT is None:
        _DB_CLIENT = SupabaseClient()
    return _DB_CLIENT


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_now_str() -> str:
    return datetime.now(AR_TZ).strftime("%Y-%m-%d %H:%M:%S")


def local_today_iso() -> str:
    return datetime.now(AR_TZ).strftime("%Y-%m-%d")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, iters_s, salt_hex, hash_hex = stored_hash.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iters = int(iters_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def slugify(text: str) -> str:
    s = text.lower().strip()
    repl = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u"}
    for k, v in repl.items():
        s = s.replace(k, v)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or f"fin-{int(time.time())}"


def parse_float(val: Any) -> float:
    if isinstance(val, (int, float)):
        return round(float(val), 2)
    s = str(val or "").strip()
    if not s:
        return 0.0
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
        return 0.0


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


def is_https_request(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "")
    if proto:
        return proto.lower().startswith("https")
    return request.url.scheme == "https"


def api_json(payload: Dict[str, Any], status_code: int = 200) -> JSONResponse:
    resp = JSONResponse(payload, status_code=status_code)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


def log_audit(db: SupabaseClient, username: str, action: str, target: str, details: str, ip: str = "", company_id: str = ""):
    try:
        db.insert(
            "audit_log",
            {
                "timestamp": local_now_str(),
                "username": username,
                "action": action,
                "target": target,
                "details": details,
                "ip": ip,
                "company_id": company_id or "",
            },
            returning=False,
        )
    except Exception:
        pass


def get_current_user(request: Request, db: SupabaseClient) -> Optional[Dict[str, Any]]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    sess = db.select_one("sessions", {"token": token})
    if not sess:
        return None
    if sess["expires_at"] < utc_now_iso():
        try:
            db.delete("sessions", {"token": token})
        except Exception:
            pass
        return None
    user_row = db.select_one("users", {"id": sess["user_id"]})
    if not user_row or user_row.get("active") != 1:
        try:
            db.delete("sessions", {"token": token})
        except Exception:
            pass
        return None
    return {
        "id": user_row["id"],
        "username": user_row["username"],
        "full_name": user_row["full_name"],
        "role": user_row["role"],
        "must_change_password": bool(user_row.get("must_change_password")),
        "allowed_companies": user_row.get("allowed_companies") or "*",
    }


def require_auth(
    request: Request,
    db: SupabaseClient,
    admin_only: bool = False,
    allow_facturista: bool = False,
    fin_editor_only: bool = False,
) -> Tuple[Optional[Dict[str, Any]], Optional[JSONResponse]]:
    user = get_current_user(request, db)
    if not user:
        return None, api_json({"error": "Debe iniciar sesión para acceder."}, 401)
    if admin_only and user["role"] != "admin":
        return None, api_json({"error": "Permisos insuficientes: se requiere rol Administrador."}, 403)
    if fin_editor_only and user["role"] not in ("admin", "exportacion"):
        return None, api_json({"error": "Permisos insuficientes: se requiere rol Administrador o Sector Exportaciones."}, 403)
    if not allow_facturista and user["role"] == "facturista":
        return None, api_json({"error": "Tu perfil de Facturista solo tiene acceso al módulo de Entregas."}, 403)
    return user, None


def get_user_companies(db: SupabaseClient, user: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = db.select(
        "companies",
        filters={"active": 1},
        select="id,sigla,nombre,subtitulo,theme_color,sort_order",
        order="sort_order.asc,id.asc",
    )
    if user["role"] == "admin" or (user.get("allowed_companies") or "*").strip() == "*":
        return rows
    allowed = {x.strip().lower() for x in str(user.get("allowed_companies", "")).split(",") if x.strip()}
    return [c for c in rows if c["id"] in allowed]


def resolve_company_id(request: Request, db: SupabaseClient, user: Dict[str, Any]) -> Tuple[Optional[str], List[Dict[str, Any]], Optional[JSONResponse]]:
    allowed_comps = get_user_companies(db, user)
    if not allowed_comps:
        return None, [], api_json({"error": "Tu usuario no tiene empresas habilitadas. Contactá al Administrador."}, 403)
    allowed_ids = [c["id"] for c in allowed_comps]
    req = (request.headers.get("x-company-id") or request.query_params.get("company") or "").strip().lower()
    if not req:
        return allowed_ids[0], allowed_comps, None
    if req not in allowed_ids:
        return None, allowed_comps, api_json({"error": f"No tenés permisos para acceder a la empresa '{req}'."}, 403)
    return req, allowed_comps, None


def is_rate_limited(db: SupabaseClient, ip: str, username: str) -> bool:
    cutoff = (datetime.now(AR_TZ) - timedelta(minutes=LOCKOUT_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    rows = db.select(
        "audit_log",
        filters={
            "action": "LOGIN_FALLIDO",
            "username": username or "desconocido",
            "ip": ip,
            "timestamp": ("gte", cutoff),
        },
        select="id",
        limit=MAX_FAILED_ATTEMPTS,
    )
    return len(rows) >= MAX_FAILED_ATTEMPTS


def process_uploaded_images(db: SupabaseClient, imagenes: Any) -> List[Dict[str, str]]:
    result = []
    if not isinstance(imagenes, list):
        return result
    for item in imagenes:
        if not isinstance(item, dict):
            continue
        src = str(item.get("src", "")).strip()
        caption = str(item.get("caption", "")).strip()
        if src.startswith("data:image/"):
            m = re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,(.+)$", src, re.I)
            if not m:
                continue
            ext = m.group(1).lower()
            if ext == "jpeg":
                ext = "jpg"
            raw = base64.b64decode(m.group(2))
            if len(raw) > 4 * 1024 * 1024:
                continue
            fname = f"cap_{secrets.token_hex(8)}.{ext}"
            ctype = "image/jpeg" if ext == "jpg" else f"image/{ext}"
            db.upload_file(STORAGE_BUCKET, fname, raw, ctype)
            result.append({"src": f"/api/uploads/{fname}", "caption": caption})
        elif src.startswith("assets/img/") or src.startswith("/assets/img/") or src.startswith("/api/uploads/"):
            norm = src if src.startswith("/") else f"/{src}"
            result.append({"src": norm, "caption": caption})
    return result


def sanitize_fin_payload(db: SupabaseClient, body: Dict[str, Any], existing_id: Optional[str] = None, existing_obj: Optional[Dict[str, Any]] = None):
    nombre = str(body.get("nombre", "")).strip().upper()
    if not nombre:
        return None, "El nombre de la financiadora es obligatorio."
    categoria = str(body.get("categoria", "obra_social")).strip()
    if categoria not in ("obra_social", "directa", "art", "colegio_medico"):
        categoria = "obra_social"

    imagenes = process_uploaded_images(db, body.get("imagenes", []))
    payload = {
        "id": existing_id or slugify(nombre),
        "codigo": str(body.get("codigo", existing_obj.get("codigo", "") if existing_obj else "")).strip(),
        "nombre": nombre,
        "categoria": categoria,
        "canales": [str(c) for c in body.get("canales", []) if c in ("portal", "email", "drive", "txt", "fisico")],
        "archivos": [str(a).strip() for a in body.get("archivos", []) if str(a).strip()],
        "ambulatorio": str(body.get("ambulatorio", "")).strip(),
        "internado": str(body.get("internado", "")).strip(),
        "vencimiento": str(body.get("vencimiento", "")).strip(),
        "asuntoRegla": str(body.get("asuntoRegla", "")).strip(),
        "nomenclaturaTipo": str(body.get("nomenclaturaTipo", existing_obj.get("nomenclaturaTipo", "") if existing_obj else "")).strip(),
        "portales": [
            {"label": str(p.get("label", "Portal Web")).strip() or "Portal Web", "url": str(p.get("url", "")).strip()}
            for p in body.get("portales", [])
            if isinstance(p, dict) and str(p.get("url", "")).strip()
        ],
        "credenciales": [
            {
                "label": str(c.get("label", "Acceso")).strip() or "Acceso",
                "usuario": str(c.get("usuario", "")).strip(),
                "clave": str(c.get("clave", "")).strip(),
                "extra": str(c.get("extra", "")).strip(),
            }
            for c in body.get("credenciales", [])
            if isinstance(c, dict) and (str(c.get("usuario", "")).strip() or str(c.get("clave", "")).strip() or str(c.get("extra", "")).strip())
        ],
        "emails": [
            {"address": str(e.get("address", "")).strip(), "label": str(e.get("label", "Facturación")).strip() or "Facturación"}
            for e in body.get("emails", [])
            if isinstance(e, dict) and str(e.get("address", "")).strip()
        ],
        "instrucciones": str(body.get("instrucciones", "")).strip(),
        "imagenes": imagenes,
        "notasInternas": str(body.get("notasInternas", existing_obj.get("notasInternas", "") if existing_obj else "")),
    }
    return payload, None


def sanitize_facturas_json(raw_val: Any) -> str:
    if isinstance(raw_val, str):
        try:
            raw_val = json.loads(raw_val)
        except Exception:
            return "[]"
    if not isinstance(raw_val, list):
        return "[]"
    clean = []
    for f in raw_val[:250]:
        if not isinstance(f, dict):
            continue
        clean.append({
            "presentacion": str(f.get("presentacion", "")).strip()[:20],
            "fecha": str(f.get("fecha", "")).strip()[:10],
            "tipo_comp": str(f.get("tipo_comp", "")).strip()[:15],
            "numero": str(f.get("numero", "")).strip()[:25],
            "cuit": str(f.get("cuit", "")).strip()[:20],
            "neto": parse_float(f.get("neto", 0)),
            "iva": parse_float(f.get("iva", 0)),
            "total": parse_float(f.get("total", 0)),
            "condicion": str(f.get("condicion", "")).strip()[:20],
        })
    return json.dumps(clean, ensure_ascii=False)


def sanitize_pdf_url(raw_url: Any) -> str:
    s = str(raw_url or "").strip()
    if s.startswith("/api/uploads/") and s.lower().endswith(".pdf") and ".." not in s:
        return s
    return ""


def sanitize_envio(body: Dict[str, Any]):
    period = str(body.get("period", "")).strip()
    if not re.match(r"^\d{4}-\d{2}$", period):
        return None, "Período inválido (usar AAAA-MM)."
    os_nombre = str(body.get("os_nombre", "")).strip().upper()
    if not os_nombre:
        return None, "Indicá el nombre de la financiadora."
    area = str(body.get("area", "ambulatorio")).strip().lower()
    if area not in ("ambulatorio", "internado"):
        area = "ambulatorio"
    grupo = str(body.get("grupo", "directas")).strip().lower()
    if grupo not in ("directas", "art", "otro"):
        grupo = "directas"
    tipo = str(body.get("tipo", "normal")).strip().lower()
    if tipo not in ("normal", "refacturacion", "diferencia_arancel", "preliquidacion", "otros"):
        tipo = "normal"
    return {
        "period": period,
        "financiadora_id": str(body.get("financiadora_id", "")).strip(),
        "os_cod": str(body.get("os_cod", "")).strip(),
        "os_nombre": os_nombre,
        "grupo": grupo,
        "area": area,
        "tipo": tipo,
        "fecha_envio": str(body.get("fecha_envio", "")).strip()[:10],
        "importe": parse_float(body.get("importe", 0)),
        "etiqueta": str(body.get("etiqueta", "")).strip()[:60],
        "observacion": str(body.get("observacion", "")).strip()[:300],
        "pdf_filename": os.path.basename(str(body.get("pdf_filename", "")).strip())[:160],
        "pdf_url": sanitize_pdf_url(body.get("pdf_url", "")),
        "facturas_json": sanitize_facturas_json(body.get("facturas", body.get("facturas_json", []))),
    }, None


def sanitize_postal(body: Dict[str, Any]):
    obra = str(body.get("obra_social", "")).strip().upper()
    if not obra:
        return None, "Indicá la Obra Social."
    fecha_envio = str(body.get("fecha_envio", "")).strip()[:10]
    period = str(body.get("period", "")).strip()
    if not re.match(r"^\d{4}-\d{2}$", period):
        period = fecha_envio[:7] if re.match(r"^\d{4}-\d{2}", fecha_envio) else datetime.now(AR_TZ).strftime("%Y-%m")
    return {
        "period": period,
        "fecha_envio": fecha_envio,
        "obra_social": obra,
        "medio": str(body.get("medio", "ANDREANI")).strip() or "ANDREANI",
        "seguimiento": str(body.get("seguimiento", "")).strip().upper(),
        "fecha_entrega": str(body.get("fecha_entrega", "")).strip()[:10],
        "observacion": str(body.get("observacion", "")).strip()[:300],
    }, None


def fetch_entregas_for_user(db: SupabaseClient, company_id: str, user: Dict[str, Any]) -> List[Dict[str, Any]]:
    filters: Dict[str, Any] = {"company_id": company_id}
    if user["role"] == "facturista":
        filters["created_by_id"] = user["id"]
    rows = db.select("entregas_facturacion", filters=filters, order="id.desc", limit=350)
    if user["role"] == "facturista":
        order_map = {"observado": 0, "pendiente": 1, "en_proceso": 2, "enviado": 3}
    else:
        order_map = {"pendiente": 0, "en_proceso": 1, "observado": 2, "enviado": 3}
    rows.sort(key=lambda r: (order_map.get(r.get("estado", "pendiente"), 9), -int(r.get("id", 0))))
    return rows


def get_gemini_api_key(db: SupabaseClient) -> str:
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key
    row = db.select_one("meta", {"key": "gemini_api_key"})
    if row:
        try:
            val = json.loads(row["value_json"])
            if isinstance(val, str):
                return val.strip()
            if isinstance(val, dict):
                return str(val.get("key", "")).strip()
        except Exception:
            return ""
    return ""


async def read_json_safe(request: Request) -> Optional[Dict[str, Any]]:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else None
    except Exception:
        return None


# ===================== ARCHIVOS PRIVADOS (ASSETS & UPLOADS) =====================
async def ep_assets_img(request: Request):
    db = get_db()
    _, err = require_auth(request, db)
    if err:
        return err
    fname = os.path.basename(urllib.parse.unquote(request.path_params["filename"]))
    target = os.path.realpath(os.path.join(ASSETS_IMG_DIR, fname))
    if not target.startswith(os.path.realpath(ASSETS_IMG_DIR) + os.sep) or not os.path.isfile(target):
        return api_json({"error": "Archivo no encontrado"}, 404)
    with open(target, "rb") as f:
        raw = f.read()
    mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
    return Response(raw, media_type=mime, headers={"Cache-Control": "private, max-age=3600"})


async def ep_uploads(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    fname = os.path.basename(urllib.parse.unquote(request.path_params["filename"]))
    if user["role"] == "facturista":
        if not fname.lower().endswith(".pdf"):
            return api_json({"error": "Sin permisos para este archivo."}, 403)
        own = db.select_one("entregas_facturacion", {"created_by_id": user["id"], "pdf_url": f"/api/uploads/{fname}"})
        if not own:
            return api_json({"error": "Solo podés abrir los PDFs de tus propias entregas."}, 403)
    raw, ctype = db.download_file(STORAGE_BUCKET, fname)
    if raw is None:
        return api_json({"error": "Archivo no encontrado"}, 404)
    if not ctype or ctype == "application/octet-stream":
        ctype = "application/pdf" if fname.lower().endswith(".pdf") else (mimetypes.guess_type(fname)[0] or "image/jpeg")
    return Response(raw, media_type=ctype, headers={"Cache-Control": "private, no-store"})


# ===================== AUTH =====================
async def ep_login(request: Request):
    db = get_db()
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos de inicio de sesión inválidos."}, 400)
    username = str(body.get("username", "")).strip().lower()
    password = str(body.get("password", ""))
    ip = client_ip(request)
    if not username or not password:
        return api_json({"error": "Ingresá usuario y contraseña."}, 400)

    if is_rate_limited(db, ip, username):
        return api_json({"error": f"Demasiados intentos fallidos. Esperá {LOCKOUT_MINUTES} minutos."}, 429)

    row = db.select_one("users", {"username": username})
    if not row or row.get("active") != 1 or not verify_password(password, row.get("password_hash", "")):
        log_audit(db, username or "desconocido", "LOGIN_FALLIDO", "sistema", "Credenciales inválidas o cuenta inactiva", ip)
        return api_json({"error": "Usuario o contraseña incorrectos."}, 401)

    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)).isoformat(timespec="seconds")
    try:
        db.delete("sessions", {"expires_at": ("lt", utc_now_iso())})
    except Exception:
        pass
    db.insert("sessions", {"token": token, "user_id": row["id"], "created_at": utc_now_iso(), "expires_at": expires}, returning=False)
    db.update("users", {"id": row["id"]}, {"last_login": local_now_str()}, returning=False)
    log_audit(db, row["username"], "LOGIN", "sistema", f"Inicio de sesión ({row['role']})", ip)

    resp = api_json({
        "user": {
            "id": row["id"],
            "username": row["username"],
            "full_name": row["full_name"],
            "role": row["role"],
            "must_change_password": bool(row.get("must_change_password")),
            "allowed_companies": row.get("allowed_companies") or "*",
        }
    })
    resp.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=SESSION_HOURS * 3600,
        httponly=True,
        samesite="lax",
        secure=is_https_request(request),
        path="/",
    )
    return resp


async def ep_logout(request: Request):
    db = get_db()
    token = request.cookies.get(COOKIE_NAME)
    if token:
        user = get_current_user(request, db)
        try:
            db.delete("sessions", {"token": token})
        except Exception:
            pass
        if user:
            log_audit(db, user["username"], "LOGOUT", "sistema", "Cierre de sesión", client_ip(request))
    resp = api_json({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


async def ep_me(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    return api_json({"user": user})


async def ep_change_own_password(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Solicitud inválida."}, 400)
    current_pwd = str(body.get("current_password", ""))
    new_pwd = str(body.get("new_password", ""))
    if len(new_pwd) < 6:
        return api_json({"error": "La nueva contraseña debe tener al menos 6 caracteres."}, 400)
    row = db.select_one("users", {"id": user["id"]}, select="password_hash")
    if not row or not verify_password(current_pwd, row["password_hash"]):
        return api_json({"error": "La contraseña actual es incorrecta."}, 400)
    db.update("users", {"id": user["id"]}, {"password_hash": hash_password(new_pwd), "must_change_password": 0}, returning=False)
    log_audit(db, user["username"], "CAMBIO_CLAVE", user["username"], "Actualizó su propia contraseña", client_ip(request))
    return api_json({"ok": True})


# ===================== BOOTSTRAP =====================
async def ep_bootstrap(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    company_id, allowed_comps, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr

    comp_row = db.select_one("companies", {"id": company_id})
    company_obj = {
        "id": comp_row["id"],
        "sigla": comp_row["sigla"],
        "nombre": comp_row["nombre"],
        "subtitulo": comp_row.get("subtitulo", ""),
        "theme_color": comp_row.get("theme_color", "teal"),
    } if comp_row else {"id": company_id, "sigla": company_id.upper(), "nombre": company_id.upper(), "subtitulo": "", "theme_color": "teal"}

    fin_rows = db.select("financiadoras", filters={"company_id": company_id}, order="nombre.asc")
    entregas = fetch_entregas_for_user(db, company_id, user)

    if user["role"] == "facturista":
        safe_fins = []
        for r in fin_rows:
            f = json.loads(r["data_json"])
            safe_fins.append({
                "id": f.get("id", ""),
                "codigo": f.get("codigo", ""),
                "nombre": f.get("nombre", ""),
                "categoria": f.get("categoria", "obra_social"),
                "vencimiento": f.get("vencimiento", ""),
            })
        return api_json({
            "user": user,
            "company": company_obj,
            "companies": allowed_comps,
            "institution": {"nombre": company_obj["nombre"], "sigla": company_obj["sigla"]},
            "general_guide": [],
            "financiadoras": safe_fins,
            "favorites": [],
            "tracker": {},
            "envios": [],
            "postal": [],
            "entregas": entregas,
        })

    fin_list = []
    fin_id_set = set()
    for r in fin_rows:
        obj = json.loads(r["data_json"])
        obj["_updated_at"] = r.get("updated_at") or ""
        obj["_updated_by"] = r.get("updated_by") or ""
        fin_list.append(obj)
        fin_id_set.add(obj["id"])

    fav_rows = db.select("favorites", filters={"user_id": user["id"]})
    favorites = [r["financiadora_id"] for r in fav_rows if r["financiadora_id"] in fin_id_set]

    trk_rows = db.select("tracker")
    tracker: Dict[str, Dict[str, Any]] = {}
    for r in trk_rows:
        if r["financiadora_id"] in fin_id_set:
            tracker.setdefault(r["period"], {})[r["financiadora_id"]] = {
                "amb": r["amb"],
                "int": r["int"],
                "nota": r["nota"],
                "updated_by": r.get("updated_by"),
                "updated_at": r.get("updated_at"),
            }

    env_rows = db.select("envios_facturacion", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc,id.desc")
    pos_rows = db.select("envios_postal", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc,id.desc")

    return api_json({
        "user": user,
        "company": company_obj,
        "companies": allowed_comps,
        "institution": json.loads(comp_row["institution_json"]) if comp_row else {},
        "general_guide": json.loads(comp_row["general_guide_json"]) if comp_row else [],
        "financiadoras": fin_list,
        "favorites": favorites,
        "tracker": tracker,
        "envios": env_rows,
        "postal": pos_rows,
        "entregas": entregas,
    })


# ===================== PDF GECLISA & IA =====================
async def ep_parse_geclisa_pdf(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    body = await read_json_safe(request)
    if not body or not body.get("content_base64"):
        return api_json({"error": "Seleccioná un archivo PDF exportado de Geclisa."}, 400)

    fname = str(body.get("filename", "reporte_geclisa.pdf")).strip()
    save_file = bool(body.get("save_file", True))
    b64 = str(body.get("content_base64", ""))
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return api_json({"error": "No se pudo decodificar el archivo PDF."}, 400)
    if len(raw) > 4 * 1024 * 1024:
        return api_json({"error": "El PDF supera el límite permitido en Vercel (4 MB)."}, 400)
    if not raw.lstrip()[:5].startswith(b"%PDF-"):
        return api_json({"error": "El archivo seleccionado no es un PDF válido."}, 400)

    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr

    fins = [json.loads(r["data_json"]) for r in db.select("financiadoras", filters={"company_id": company_id}, select="data_json")]
    try:
        parsed = pdf_parser.parse_geclisa_pdf(raw, fname, fins)
    except Exception as ex:
        return api_json({"error": f"Error leyendo el PDF: {ex}"}, 400)

    pdf_url = ""
    if save_file:
        safe_name = f"geclisa_{secrets.token_hex(8)}.pdf"
        db.upload_file(STORAGE_BUCKET, safe_name, raw, "application/pdf")
        pdf_url = f"/api/uploads/{safe_name}"

    parsed["pdf_url"] = pdf_url
    parsed["pdf_filename"] = os.path.basename(fname)
    parsed["company_mismatch"] = bool(parsed["empresa_detectada"] and parsed["empresa_detectada"] != company_id)
    return api_json({"parsed": parsed})


async def ep_ai_ask(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=False)
    if err:
        return err
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Consulta inválida."}, 400)
    question = str(body.get("question", "")).strip()[:500]
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr

    comp_row = db.select_one("companies", {"id": company_id})
    company_obj = comp_row or {"id": company_id, "sigla": company_id.upper(), "nombre": company_id.upper()}
    institution = json.loads(comp_row["institution_json"]) if comp_row else {}
    general_guide = json.loads(comp_row["general_guide_json"]) if comp_row else []
    financiadoras = [json.loads(r["data_json"]) for r in db.select("financiadoras", filters={"company_id": company_id}, select="data_json", order="nombre.asc")]
    envios = db.select("envios_facturacion", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc")
    postal = db.select("envios_postal", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc")
    entregas = fetch_entregas_for_user(db, company_id, user)
    gemini_key = get_gemini_api_key(db)

    res = ai_assistant.answer_portal_question(
        question=question,
        company=company_obj,
        institution=institution,
        financiadoras=financiadoras,
        general_guide=general_guide,
        envios=envios,
        postal=postal,
        entregas=entregas,
        gemini_api_key=gemini_key,
    )
    return api_json(res)


async def ep_ai_config(request: Request):
    db = get_db()
    user, err = require_auth(request, db, admin_only=True)
    if err:
        return err
    if request.method == "GET":
        key = get_gemini_api_key(db)
        return api_json({"has_gemini_key": bool(key), "from_env": bool(os.environ.get("GEMINI_API_KEY", "").strip())})
    body = await read_json_safe(request)
    if body is None:
        return api_json({"error": "Datos inválidos."}, 400)
    api_key = str(body.get("gemini_api_key", "")).strip()
    if api_key:
        db.insert("meta", {"key": "gemini_api_key", "value_json": json.dumps(api_key)}, upsert=True, on_conflict="key", returning=False)
        log_audit(db, user["username"], "CONFIG_IA", "sistema", "Activó conexión opcional Gemini API", client_ip(request))
    else:
        db.delete("meta", {"key": "gemini_api_key"})
        log_audit(db, user["username"], "CONFIG_IA", "sistema", "Desactivó Gemini API (modo 100% local)", client_ip(request))
    return api_json({"ok": True, "has_gemini_key": bool(get_gemini_api_key(db))})


# ===================== ENTREGAS / BANDEJA DE TAREAS =====================
async def ep_entregas(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr

    if request.method == "GET":
        return api_json({"entregas": fetch_entregas_for_user(db, company_id, user)})

    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    period = str(body.get("period", "")).strip()
    if not re.match(r"^\d{4}-\d{2}$", period):
        return api_json({"error": "El período es obligatorio (formato AAAA-MM)."}, 400)
    area = str(body.get("area", "")).strip().lower()
    if area not in ("ambulatorio", "internado"):
        return api_json({"error": "Debés indicar si corresponde a Ambulatorio o Internado."}, 400)

    fin_id_req = str(body.get("financiadora_id", "")).strip()
    os_nombre_req = str(body.get("os_nombre", "")).strip().upper()
    if not fin_id_req and not os_nombre_req:
        return api_json({"error": "Debés seleccionar una financiadora."}, 400)

    condicion = str(body.get("condicion", "")).strip()[:40]
    tipo = str(body.get("tipo", "normal")).strip().lower()
    if tipo not in ("normal", "refacturacion", "diferencia_arancel", "preliquidacion", "otros"):
        tipo = "normal"
    importe = parse_float(body.get("importe", 0))
    observacion = str(body.get("observacion", "")).strip()[:300]
    pdf_filename = os.path.basename(str(body.get("pdf_filename", "")).strip())[:160]
    pdf_url = sanitize_pdf_url(body.get("pdf_url", ""))
    facturas_json = sanitize_facturas_json(body.get("facturas", body.get("facturas_json", [])))

    fin_row = None
    if fin_id_req:
        fin_row = db.select_one("financiadoras", {"id": fin_id_req, "company_id": company_id})
    if not fin_row and os_nombre_req:
        fin_row = db.select_one("financiadoras", {"nombre": os_nombre_req, "company_id": company_id})

    if fin_row:
        fin_data = json.loads(fin_row["data_json"])
        fin_id = fin_row["id"]
        os_cod = str(fin_data.get("codigo", "")).strip()
        os_nombre = fin_row["nombre"]
        grupo = "art" if fin_row["categoria"] == "art" else "directas"
    else:
        fin_id = ""
        os_cod = str(body.get("os_cod", "")).strip()[:20]
        os_nombre = os_nombre_req
        grupo = "directas"

    now = local_now_str()
    inserted = db.insert(
        "entregas_facturacion",
        {
            "company_id": company_id,
            "financiadora_id": fin_id,
            "os_cod": os_cod,
            "os_nombre": os_nombre,
            "grupo": grupo,
            "area": area,
            "period": period,
            "condicion": condicion,
            "tipo": tipo,
            "importe": importe,
            "observacion": observacion,
            "pdf_filename": pdf_filename,
            "pdf_url": pdf_url,
            "facturas_json": facturas_json,
            "estado": "pendiente",
            "respuesta_exportacion": "",
            "created_by_id": user["id"],
            "created_by_name": user["full_name"] or user["username"],
            "created_at": now,
            "processed_by": "",
            "processed_at": "",
            "updated_at": now,
        },
    )
    row = inserted[0]
    det = f"{period} {area}" + (f" ({condicion})" if condicion else "") + (f" [PDF: {pdf_filename}]" if pdf_filename else "")
    log_audit(db, user["username"], "NUEVA_ENTREGA", os_nombre, det, client_ip(request), company_id)
    return api_json({"entrega": row}, 201)


async def ep_entrega_item(request: Request):
    db = get_db()
    entrega_id = int(request.path_params["entrega_id"])

    if request.method == "DELETE":
        user, err = require_auth(request, db, admin_only=True)
        if err:
            return err
        company_id, _, cerr = resolve_company_id(request, db, user)
        if cerr:
            return cerr
        row = db.select_one("entregas_facturacion", {"id": entrega_id, "company_id": company_id})
        if not row:
            return api_json({"error": "Entrega no encontrada."}, 404)
        db.delete("entregas_facturacion", {"id": entrega_id, "company_id": company_id})
        log_audit(db, user["username"], "ELIMINAR_ENTREGA", row["os_nombre"], f"Entrega #{entrega_id} ({row['period']} {row['area']})", client_ip(request), company_id)
        return api_json({"ok": True})

    # PUT
    user, err = require_auth(request, db, allow_facturista=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    row = db.select_one("entregas_facturacion", {"id": entrega_id, "company_id": company_id})
    if not row:
        return api_json({"error": "Entrega no encontrada."}, 404)

    now = local_now_str()
    if user["role"] == "facturista":
        if row["created_by_id"] != user["id"]:
            return api_json({"error": "Solo podés modificar tus propias entregas."}, 403)
        if row["estado"] not in ("pendiente", "observado"):
            return api_json({"error": "Esta entrega ya fue tomada o enviada por Exportaciones y no puede modificarse."}, 400)
        period = str(body.get("period", row["period"])).strip()
        if not re.match(r"^\d{4}-\d{2}$", period):
            return api_json({"error": "Período inválido (usar AAAA-MM)."}, 400)
        area = str(body.get("area", row["area"])).strip().lower()
        if area not in ("ambulatorio", "internado"):
            area = row["area"]
        condicion = str(body.get("condicion", row["condicion"])).strip()[:40]
        tipo = str(body.get("tipo", row["tipo"])).strip().lower()
        if tipo not in ("normal", "refacturacion", "diferencia_arancel", "preliquidacion", "otros"):
            tipo = row["tipo"]
        importe = parse_float(body.get("importe", row["importe"]))
        observacion = str(body.get("observacion", row["observacion"])).strip()[:300]
        upd = db.update(
            "entregas_facturacion",
            {"id": entrega_id, "company_id": company_id},
            {"period": period, "area": area, "condicion": condicion, "tipo": tipo, "importe": importe, "observacion": observacion, "estado": "pendiente", "updated_at": now},
        )[0]
        log_audit(db, user["username"], "CORREGIR_ENTREGA", row["os_nombre"], f"ID #{entrega_id} ({period} {area})", client_ip(request), company_id)
        return api_json({"entrega": upd})

    new_estado = str(body.get("estado", row["estado"])).strip().lower()
    if new_estado not in ("pendiente", "en_proceso", "observado", "enviado"):
        return api_json({"error": "Estado inválido."}, 400)
    respuesta = str(body.get("respuesta_exportacion", row["respuesta_exportacion"])).strip()[:300]
    proc_by = user["username"] if new_estado in ("en_proceso", "observado", "enviado") else row.get("processed_by", "")
    proc_at = now if new_estado == "enviado" else row.get("processed_at", "")
    upd = db.update(
        "entregas_facturacion",
        {"id": entrega_id, "company_id": company_id},
        {"estado": new_estado, "respuesta_exportacion": respuesta, "processed_by": proc_by, "processed_at": proc_at, "updated_at": now},
    )[0]
    log_audit(db, user["username"], "ACTUALIZAR_TAREA", row["os_nombre"], f"ID #{entrega_id} -> {new_estado}" + (f" ({respuesta})" if respuesta else ""), client_ip(request), company_id)
    return api_json({"entrega": upd})


async def ep_completar_entrega(request: Request):
    db = get_db()
    user, err = require_auth(request, db, allow_facturista=False)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    entrega_id = int(request.path_params["entrega_id"])
    body = await read_json_safe(request) or {}
    row = db.select_one("entregas_facturacion", {"id": entrega_id, "company_id": company_id})
    if not row:
        return api_json({"error": "Tarea de entrega no encontrada."}, 404)
    if row["estado"] == "enviado":
        return api_json({"error": "Esta entrega ya fue marcada como enviada anteriormente."}, 400)

    now = local_now_str()
    fecha_envio = str(body.get("fecha_envio", "")).strip()[:10] or local_today_iso()
    importe = parse_float(body.get("importe", row["importe"]))
    tipo = str(body.get("tipo", row["tipo"])).strip().lower()
    if tipo not in ("normal", "refacturacion", "diferencia_arancel", "preliquidacion", "otros"):
        tipo = "normal"
    etiqueta = str(body.get("etiqueta", row["condicion"])).strip()[:60]
    obs_parts = [str(body.get("observacion", row["observacion"])).strip()]
    if row["created_by_name"] and f"Facturista: {row['created_by_name']}" not in obs_parts[0]:
        obs_parts.append(f"Facturista: {row['created_by_name']}")
    observacion_envio = " · ".join(p for p in obs_parts if p)[:300]
    respuesta = str(body.get("respuesta_exportacion", "")).strip()[:300]
    registrar_en_control = bool(body.get("registrar_en_control", True))

    envio_obj = None
    envio_id = None
    if registrar_en_control:
        envio_obj = db.insert(
            "envios_facturacion",
            {
                "company_id": company_id,
                "period": row["period"],
                "financiadora_id": row["financiadora_id"],
                "os_cod": row["os_cod"],
                "os_nombre": row["os_nombre"],
                "grupo": row["grupo"],
                "area": row["area"],
                "tipo": tipo,
                "fecha_envio": fecha_envio,
                "importe": importe,
                "etiqueta": etiqueta,
                "observacion": observacion_envio,
                "pdf_filename": row.get("pdf_filename") or "",
                "pdf_url": row.get("pdf_url") or "",
                "facturas_json": row.get("facturas_json") or "[]",
                "created_by": user["username"],
                "updated_at": now,
            },
        )[0]
        envio_id = envio_obj["id"]

    updated_entrega = db.update(
        "entregas_facturacion",
        {"id": entrega_id, "company_id": company_id},
        {
            "estado": "enviado",
            "importe": importe,
            "respuesta_exportacion": respuesta,
            "envio_id": envio_id,
            "processed_by": user["username"],
            "processed_at": now,
            "updated_at": now,
        },
    )[0]
    log_audit(
        db,
        user["username"],
        "DESPACHAR_ENTREGA",
        row["os_nombre"],
        f"Entrega #{entrega_id} ({row['period']} {row['area']}) -> Enviado ${importe:,.2f}" + (f" [Control #{envio_id}]" if envio_id else ""),
        client_ip(request),
        company_id,
    )
    return api_json({"entrega": updated_entrega, "envio": envio_obj})


# ===================== FINANCIADORAS =====================
async def ep_create_financiadora(request: Request):
    db = get_db()
    user, err = require_auth(request, db, fin_editor_only=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Cuerpo JSON inválido."}, 400)
    payload, perr = sanitize_fin_payload(db, body)
    if perr:
        return api_json({"error": perr}, 400)

    base_id = payload["id"]
    if company_id != DEFAULT_COMPANY_ID and not base_id.startswith(f"{company_id}-"):
        base_id = f"{company_id}-{base_id}"
    candidate = base_id
    i = 2
    while db.select_one("financiadoras", {"id": candidate}, select="id"):
        candidate = f"{base_id}-{i}"
        i += 1
    payload["id"] = candidate
    now = local_now_str()
    db.insert(
        "financiadoras",
        {
            "id": payload["id"],
            "company_id": company_id,
            "nombre": payload["nombre"],
            "categoria": payload["categoria"],
            "data_json": json.dumps(payload, ensure_ascii=False),
            "updated_at": now,
            "updated_by": user["username"],
        },
        returning=False,
    )
    log_audit(db, user["username"], "CREAR_FINANCIADORA", payload["nombre"], f"ID: {payload['id']}", client_ip(request), company_id)
    payload["_updated_at"] = now
    payload["_updated_by"] = user["username"]
    return api_json({"financiadora": payload}, 201)


async def ep_financiadora_item(request: Request):
    db = get_db()
    fin_id = urllib.parse.unquote(request.path_params["fin_id"])

    if request.method == "DELETE":
        user, err = require_auth(request, db, admin_only=True)
        if err:
            return err
        company_id, _, cerr = resolve_company_id(request, db, user)
        if cerr:
            return cerr
        row = db.select_one("financiadoras", {"id": fin_id, "company_id": company_id}, select="nombre")
        if not row:
            return api_json({"error": "Financiadora no encontrada en la empresa activa."}, 404)
        db.delete("financiadoras", {"id": fin_id, "company_id": company_id})
        log_audit(db, user["username"], "ELIMINAR_FINANCIADORA", row["nombre"], f"ID: {fin_id}", client_ip(request), company_id)
        return api_json({"ok": True})

    # PUT
    user, err = require_auth(request, db, fin_editor_only=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Cuerpo JSON inválido."}, 400)
    row = db.select_one("financiadoras", {"id": fin_id, "company_id": company_id})
    if not row:
        return api_json({"error": "Financiadora no encontrada en la empresa activa."}, 404)
    existing = json.loads(row["data_json"])
    payload, perr = sanitize_fin_payload(db, body, existing_id=fin_id, existing_obj=existing)
    if perr:
        return api_json({"error": perr}, 400)
    now = local_now_str()
    changed_fields = [
        k for k in ("codigo", "nombre", "categoria", "canales", "archivos", "ambulatorio", "internado", "vencimiento", "asuntoRegla", "portales", "credenciales", "emails", "instrucciones", "imagenes")
        if existing.get(k) != payload.get(k)
    ]
    diff_txt = f"Cambió: {', '.join(changed_fields)}" if changed_fields else "Sin cambios de campos"
    db.update(
        "financiadoras",
        {"id": fin_id, "company_id": company_id},
        {
            "nombre": payload["nombre"],
            "categoria": payload["categoria"],
            "data_json": json.dumps(payload, ensure_ascii=False),
            "updated_at": now,
            "updated_by": user["username"],
        },
        returning=False,
    )
    log_audit(db, user["username"], "EDITAR_FINANCIADORA", payload["nombre"], f"ID: {fin_id} · {diff_txt}", client_ip(request), company_id)
    payload["_updated_at"] = now
    payload["_updated_by"] = user["username"]
    return api_json({"financiadora": payload})


async def ep_financiadora_notes(request: Request):
    db = get_db()
    user, err = require_auth(request, db, fin_editor_only=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    fin_id = urllib.parse.unquote(request.path_params["fin_id"])
    body = await read_json_safe(request)
    if body is None:
        return api_json({"error": "Cuerpo inválido."}, 400)
    row = db.select_one("financiadoras", {"id": fin_id, "company_id": company_id})
    if not row:
        return api_json({"error": "Financiadora no encontrada en la empresa activa."}, 404)
    data = json.loads(row["data_json"])
    data["notasInternas"] = str(body.get("notasInternas", ""))
    db.update(
        "financiadoras",
        {"id": fin_id, "company_id": company_id},
        {"data_json": json.dumps(data, ensure_ascii=False), "updated_at": local_now_str(), "updated_by": user["username"]},
        returning=False,
    )
    log_audit(db, user["username"], "EDITAR_NOTAS", row["nombre"], "Actualizó notas internas", client_ip(request), company_id)
    return api_json({"ok": True})


# ===================== ENVIOS CONTROL MENSUAL =====================
async def ep_create_envio(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    d, perr = sanitize_envio(body)
    if perr:
        return api_json({"error": perr}, 400)
    now = local_now_str()
    row = db.insert(
        "envios_facturacion",
        {"company_id": company_id, **d, "created_by": user["username"], "updated_at": now},
    )[0]
    log_audit(db, user["username"], "REGISTRAR_ENVIO", d["os_nombre"], f"{d['period']} {d['area']} ({d['tipo']}) ${d['importe']:,.2f}", client_ip(request), company_id)
    return api_json({"envio": row}, 201)


async def ep_envio_item(request: Request):
    db = get_db()
    envio_id = int(request.path_params["envio_id"])

    if request.method == "DELETE":
        user, err = require_auth(request, db, admin_only=True)
        if err:
            return err
        company_id, _, cerr = resolve_company_id(request, db, user)
        if cerr:
            return cerr
        row = db.select_one("envios_facturacion", {"id": envio_id, "company_id": company_id})
        if not row:
            return api_json({"error": "Envío no encontrado en la empresa activa."}, 404)
        db.delete("envios_facturacion", {"id": envio_id, "company_id": company_id})
        log_audit(db, user["username"], "ELIMINAR_ENVIO", row["os_nombre"], f"ID #{envio_id} ({row['period']}) ${float(row['importe'] or 0):,.2f}", client_ip(request), company_id)
        return api_json({"ok": True})

    # PUT
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    d, perr = sanitize_envio(body)
    if perr:
        return api_json({"error": perr}, 400)
    existing = db.select_one("envios_facturacion", {"id": envio_id, "company_id": company_id})
    if not existing:
        return api_json({"error": "Envío no encontrado en la empresa activa."}, 404)
    d["pdf_filename"] = d["pdf_filename"] or existing.get("pdf_filename") or ""
    d["pdf_url"] = d["pdf_url"] or existing.get("pdf_url") or ""
    d["facturas_json"] = d["facturas_json"] if d["facturas_json"] != "[]" else (existing.get("facturas_json") or "[]")
    row = db.update(
        "envios_facturacion",
        {"id": envio_id, "company_id": company_id},
        {**d, "created_by": user["username"], "updated_at": local_now_str()},
    )[0]
    log_audit(db, user["username"], "EDITAR_ENVIO", d["os_nombre"], f"ID #{envio_id} {d['period']} {d['area']} ${d['importe']:,.2f}", client_ip(request), company_id)
    return api_json({"envio": row})


async def ep_import_envios_excel(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body or not isinstance(body.get("files"), list) or len(body["files"]) == 0:
        return api_json({"error": "Seleccioná al menos una planilla Excel (.xls o .xlsx)."}, 400)

    dry_run = bool(body.get("dry_run", True))
    replace_existing = bool(body.get("replace_existing", True))
    fins = [json.loads(r["data_json"]) for r in db.select("financiadoras", filters={"company_id": company_id}, select="data_json")]

    parsed_files = []
    for item in body["files"]:
        fname = str(item.get("filename", "planilla.xlsx"))
        b64 = str(item.get("content_base64", ""))
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
            res = excel_importer.parse_billing_excel(raw, fname, fins, period_override=str(item.get("period_override", "")).strip())
        except Exception as ex:
            return api_json({"error": f"Error leyendo '{fname}': {ex}"}, 400)
        res["existing_in_db"] = db.count("envios_facturacion", {"company_id": company_id, "period": res["period"]})
        parsed_files.append(res)

    if dry_run:
        return api_json({
            "summaries": [
                {
                    "filename": p["filename"],
                    "period": p["period"],
                    "count": p["count"],
                    "total_directas": p["total_directas"],
                    "total_art": p["total_art"],
                    "total_general": p["total_general"],
                    "existing_in_db": p["existing_in_db"],
                }
                for p in parsed_files
            ]
        })

    if replace_existing:
        has_existing = any(p["count"] > 0 and p["existing_in_db"] > 0 for p in parsed_files)
        if has_existing and user["role"] != "admin":
            return api_json({"error": "Solo el Administrador puede reemplazar/eliminar registros ya cargados en un período."}, 403)
        for p in parsed_files:
            if p["count"] > 0:
                db.delete("envios_facturacion", {"company_id": company_id, "period": p["period"]})

    now = local_now_str()
    rows_to_insert = []
    periods_touched = set()
    for p in parsed_files:
        for e in p["envios"]:
            rows_to_insert.append({
                "company_id": company_id,
                "period": e["period"],
                "financiadora_id": e["financiadora_id"],
                "os_cod": e["os_cod"],
                "os_nombre": e["os_nombre"],
                "grupo": e["grupo"],
                "area": e["area"],
                "tipo": e["tipo"],
                "fecha_envio": e["fecha_envio"],
                "importe": e["importe"],
                "etiqueta": e["etiqueta"],
                "observacion": e["observacion"],
                "pdf_filename": "",
                "pdf_url": "",
                "facturas_json": "[]",
                "created_by": user["username"],
                "updated_at": now,
            })
            periods_touched.add(e["period"])

    if rows_to_insert:
        db.insert("envios_facturacion", rows_to_insert, returning=False)

    periods_sorted = sorted(periods_touched, reverse=True)
    log_audit(
        db,
        user["username"],
        "IMPORTAR_EXCEL_ENVIOS",
        ", ".join(periods_sorted) or "sin datos",
        f"{len(parsed_files)} archivo(s), {len(rows_to_insert)} envíos (reemplazar={'sí' if replace_existing else 'no'})",
        client_ip(request),
        company_id,
    )
    all_envios = db.select("envios_facturacion", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc,id.desc")
    return api_json({"ok": True, "imported": len(rows_to_insert), "periods": periods_sorted, "envios": all_envios})


# ===================== POSTAL (ANDREANI) =====================
async def ep_create_postal(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    d, perr = sanitize_postal(body)
    if perr:
        return api_json({"error": perr}, 400)
    row = db.insert("envios_postal", {"company_id": company_id, **d, "created_by": user["username"], "updated_at": local_now_str()})[0]
    log_audit(db, user["username"], "REGISTRAR_POSTAL", d["obra_social"], f"{d['medio']} #{d['seguimiento']}", client_ip(request), company_id)
    return api_json({"postal": row}, 201)


async def ep_postal_item(request: Request):
    db = get_db()
    postal_id = int(request.path_params["postal_id"])

    if request.method == "DELETE":
        user, err = require_auth(request, db, admin_only=True)
        if err:
            return err
        company_id, _, cerr = resolve_company_id(request, db, user)
        if cerr:
            return cerr
        row = db.select_one("envios_postal", {"id": postal_id, "company_id": company_id})
        if not row:
            return api_json({"error": "Envío postal no encontrado en la empresa activa."}, 404)
        db.delete("envios_postal", {"id": postal_id, "company_id": company_id})
        log_audit(db, user["username"], "ELIMINAR_POSTAL", row["obra_social"], f"ID #{postal_id} #{row['seguimiento']}", client_ip(request), company_id)
        return api_json({"ok": True})

    # PUT
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    d, perr = sanitize_postal(body)
    if perr:
        return api_json({"error": perr}, 400)
    if not db.select_one("envios_postal", {"id": postal_id, "company_id": company_id}, select="id"):
        return api_json({"error": "Envío postal no encontrado en la empresa activa."}, 404)
    row = db.update("envios_postal", {"id": postal_id, "company_id": company_id}, {**d, "created_by": user["username"], "updated_at": local_now_str()})[0]
    log_audit(db, user["username"], "EDITAR_POSTAL", d["obra_social"], f"ID #{postal_id} #{d['seguimiento']} entrega={d['fecha_entrega'] or 'pendiente'}", client_ip(request), company_id)
    return api_json({"postal": row})


async def ep_import_postal_excel(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body or not isinstance(body.get("files"), list) or len(body["files"]) == 0:
        return api_json({"error": "Seleccioná al menos una planilla Excel (.xls o .xlsx)."}, 400)

    dry_run = bool(body.get("dry_run", True))
    parsed_files = []
    for item in body["files"]:
        fname = str(item.get("filename", "andreani.xlsx"))
        b64 = str(item.get("content_base64", ""))
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
            res = excel_importer.parse_postal_excel(raw, fname)
        except Exception as ex:
            return api_json({"error": f"Error leyendo '{fname}': {ex}"}, 400)
        parsed_files.append(res)

    if dry_run:
        return api_json({"summaries": [{"filename": p["filename"], "count": p["count"], "sheets": p["sheets"]} for p in parsed_files]})

    existing_rows = db.select("envios_postal", filters={"company_id": company_id}, select="period,seguimiento,obra_social")
    existing_keys = {(r["period"], r["seguimiento"], r["obra_social"]) for r in existing_rows if r.get("seguimiento")}
    now = local_now_str()
    to_insert = []
    skipped = 0
    for p in parsed_files:
        for rec in p["postal"]:
            key = (rec["period"], rec["seguimiento"], rec["obra_social"])
            if rec["seguimiento"] and key in existing_keys:
                skipped += 1
                continue
            if rec["seguimiento"]:
                existing_keys.add(key)
            to_insert.append({"company_id": company_id, **rec, "created_by": user["username"], "updated_at": now})
    if to_insert:
        db.insert("envios_postal", to_insert, returning=False)
    log_audit(db, user["username"], "IMPORTAR_EXCEL_POSTAL", "Andreani", f"{len(parsed_files)} archivo(s), {len(to_insert)} nuevos, {skipped} duplicados omitidos", client_ip(request), company_id)
    all_postal = db.select("envios_postal", filters={"company_id": company_id}, order="period.desc,fecha_envio.desc,id.desc")
    return api_json({"ok": True, "imported": len(to_insert), "skipped": skipped, "postal": all_postal})


# ===================== FAVORITES & TRACKER =====================
async def ep_toggle_favorite(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    fin_id = urllib.parse.unquote(request.path_params["fin_id"])
    if not db.select_one("financiadoras", {"id": fin_id, "company_id": company_id}, select="id"):
        return api_json({"error": "Financiadora no encontrada en la empresa activa."}, 404)
    exists = db.select_one("favorites", {"user_id": user["id"], "financiadora_id": fin_id})
    if exists:
        db.delete("favorites", {"user_id": user["id"], "financiadora_id": fin_id})
        return api_json({"favorited": False})
    db.insert("favorites", {"user_id": user["id"], "financiadora_id": fin_id}, upsert=True, on_conflict="user_id,financiadora_id", returning=False)
    return api_json({"favorited": True})


async def ep_update_tracker(request: Request):
    db = get_db()
    user, err = require_auth(request, db)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, user)
    if cerr:
        return cerr
    period = request.path_params["period"]
    fin_id = urllib.parse.unquote(request.path_params["fin_id"])
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Cuerpo inválido."}, 400)
    if not db.select_one("financiadoras", {"id": fin_id, "company_id": company_id}, select="id"):
        return api_json({"error": "Financiadora no encontrada en la empresa activa."}, 404)
    valid = ("pendiente", "proceso", "enviado", "na")
    cur = db.select_one("tracker", {"period": period, "financiadora_id": fin_id})
    amb = body.get("amb", cur["amb"] if cur else "pendiente")
    intern = body.get("int", cur["int"] if cur else "pendiente")
    nota = str(body.get("nota", cur["nota"] if cur else ""))[:300]
    amb = amb if amb in valid else "pendiente"
    intern = intern if intern in valid else "pendiente"
    now = local_now_str()
    db.insert(
        "tracker",
        {"period": period, "financiadora_id": fin_id, "amb": amb, "int": intern, "nota": nota, "updated_at": now, "updated_by": user["username"]},
        upsert=True,
        on_conflict="period,financiadora_id",
        returning=False,
    )
    return api_json({"entry": {"amb": amb, "int": intern, "nota": nota, "updated_by": user["username"], "updated_at": now}})


# ===================== GESTION DE USUARIOS (ADMIN) =====================
def sanitize_allowed_companies(db: SupabaseClient, raw_val: Any, role: str) -> str:
    if role == "admin":
        return "*"
    if raw_val is None or raw_val == "*":
        return "*"
    valid_ids = {r["id"] for r in db.select("companies", filters={"active": 1}, select="id")}
    if isinstance(raw_val, list):
        chosen = [str(x).strip().lower() for x in raw_val if str(x).strip().lower() in valid_ids]
    else:
        s = str(raw_val).strip().lower()
        if s == "*":
            return "*"
        chosen = [x.strip() for x in s.split(",") if x.strip() in valid_ids]
    if not chosen or set(chosen) == valid_ids:
        return "*" if set(chosen) == valid_ids else ""
    return ",".join(sorted(set(chosen)))


async def ep_users(request: Request):
    db = get_db()
    admin_user, err = require_auth(request, db, admin_only=True)
    if err:
        return err

    if request.method == "GET":
        users = db.select(
            "users",
            select="id,username,full_name,role,active,must_change_password,allowed_companies,created_at,last_login",
            order="role.asc,username.asc",
        )
        companies = db.select("companies", filters={"active": 1}, select="id,sigla,nombre,theme_color", order="sort_order.asc,id.asc")
        logs = db.select("audit_log", select="id,timestamp,username,action,target,details,ip,company_id", order="id.desc", limit=120)
        return api_json({"users": users, "companies": companies, "audit": logs})

    # POST
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    username = re.sub(r"[^a-z0-9._-]", "", str(body.get("username", "")).strip().lower())
    full_name = str(body.get("full_name", "")).strip()
    role = str(body.get("role", "consulta")).strip()
    password = str(body.get("password", ""))
    if len(username) < 3:
        return api_json({"error": "El usuario debe tener al menos 3 caracteres."}, 400)
    if not full_name:
        return api_json({"error": "Ingresá el nombre completo."}, 400)
    if role not in ("admin", "exportacion", "consulta", "facturista"):
        return api_json({"error": "Rol inválido."}, 400)
    if len(password) < 6:
        return api_json({"error": "La contraseña inicial debe tener al menos 6 caracteres."}, 400)
    if db.select_one("users", {"username": username}, select="id"):
        return api_json({"error": f"Ya existe un usuario llamado '{username}'."}, 409)
    allowed = sanitize_allowed_companies(db, body.get("allowed_companies", "*"), role)
    if not allowed:
        return api_json({"error": "Seleccioná al menos una empresa habilitada para este usuario."}, 400)
    db.insert(
        "users",
        {
            "username": username,
            "full_name": full_name,
            "role": role,
            "password_hash": hash_password(password),
            "active": 1,
            "must_change_password": 1,
            "allowed_companies": allowed,
            "created_at": local_now_str(),
        },
        returning=False,
    )
    log_audit(db, admin_user["username"], "CREAR_USUARIO", username, f"Rol: {role}, Empresas: {allowed} ({full_name})", client_ip(request))
    return api_json({"ok": True}, 201)


async def ep_user_item(request: Request):
    db = get_db()
    admin_user, err = require_auth(request, db, admin_only=True)
    if err:
        return err
    target_id = int(request.path_params["target_id"])

    if request.method == "DELETE":
        if admin_user["id"] == target_id:
            return api_json({"error": "No podés eliminar tu propia cuenta mientras estás conectado."}, 400)
        target = db.select_one("users", {"id": target_id})
        if not target:
            return api_json({"error": "Usuario no encontrado."}, 404)
        if target["role"] == "admin":
            other_admins = db.select("users", {"role": "admin", "active": 1, "id": ("neq", target_id)}, select="id")
            if not other_admins:
                return api_json({"error": "No se puede eliminar al último Administrador activo."}, 400)
        db.delete("users", {"id": target_id})
        log_audit(db, admin_user["username"], "ELIMINAR_USUARIO", target["username"], "Cuenta eliminada", client_ip(request))
        return api_json({"ok": True})

    # PUT
    body = await read_json_safe(request)
    if not body:
        return api_json({"error": "Datos inválidos."}, 400)
    target = db.select_one("users", {"id": target_id})
    if not target:
        return api_json({"error": "Usuario no encontrado."}, 404)
    new_full_name = str(body.get("full_name", target["full_name"])).strip() or target["full_name"]
    new_role = str(body.get("role", target["role"])).strip()
    if new_role not in ("admin", "exportacion", "consulta", "facturista"):
        new_role = target["role"]
    new_active = 1 if body.get("active", bool(target["active"])) else 0
    new_password = str(body.get("password", ""))
    new_allowed = sanitize_allowed_companies(db, body.get("allowed_companies", target.get("allowed_companies") or "*"), new_role)
    if not new_allowed:
        return api_json({"error": "Seleccioná al menos una empresa habilitada para este usuario."}, 400)

    if target["role"] == "admin" and (new_role != "admin" or new_active == 0):
        other_admins = db.select("users", {"role": "admin", "active": 1, "id": ("neq", target_id)}, select="id")
        if not other_admins:
            return api_json({"error": "Debe quedar al menos un Administrador activo en el sistema."}, 400)

    changes = []
    patch: Dict[str, Any] = {"full_name": new_full_name, "role": new_role, "active": new_active, "allowed_companies": new_allowed}
    if new_password:
        if len(new_password) < 6:
            return api_json({"error": "La contraseña debe tener al menos 6 caracteres."}, 400)
        patch["password_hash"] = hash_password(new_password)
        patch["must_change_password"] = 1
        db.delete("sessions", {"user_id": target_id})
        changes.append("clave restablecida")
    elif new_active == 0:
        db.delete("sessions", {"user_id": target_id})

    db.update("users", {"id": target_id}, patch, returning=False)
    changes.append(f"rol={new_role}, empresas={new_allowed}, activo={'sí' if new_active else 'no'}")
    log_audit(db, admin_user["username"], "EDITAR_USUARIO", target["username"], "; ".join(changes), client_ip(request))
    return api_json({"ok": True})


# ===================== BACKUP (ADMIN, POR EMPRESA) =====================
async def ep_export_backup(request: Request):
    db = get_db()
    admin_user, err = require_auth(request, db, admin_only=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, admin_user)
    if cerr:
        return cerr
    fin_rows = db.select("financiadoras", filters={"company_id": company_id}, order="nombre.asc")
    fins = [json.loads(r["data_json"]) for r in fin_rows]
    fin_ids = {f["id"] for f in fins}
    trk_rows = db.select("tracker")
    tracker: Dict[str, Dict[str, Any]] = {}
    for r in trk_rows:
        if r["financiadora_id"] in fin_ids:
            tracker.setdefault(r["period"], {})[r["financiadora_id"]] = {"amb": r["amb"], "int": r["int"], "nota": r["nota"]}
    env_rows = db.select("envios_facturacion", filters={"company_id": company_id}, order="id.asc")
    pos_rows = db.select("envios_postal", filters={"company_id": company_id}, order="id.asc")
    log_audit(db, admin_user["username"], "EXPORTAR_BACKUP", company_id.upper(), f"{len(fins)} fin, {len(env_rows)} envios, {len(pos_rows)} postal", client_ip(request), company_id)
    return api_json({
        "exportedAt": utc_now_iso(),
        "company_id": company_id,
        "financiadoras": fins,
        "tracker": tracker,
        "envios": env_rows,
        "postal": pos_rows,
    })


async def ep_import_backup(request: Request):
    db = get_db()
    admin_user, err = require_auth(request, db, admin_only=True)
    if err:
        return err
    company_id, _, cerr = resolve_company_id(request, db, admin_user)
    if cerr:
        return cerr
    body = await read_json_safe(request)
    if not body or not isinstance(body.get("financiadoras"), list):
        return api_json({"error": "Archivo de backup inválido."}, 400)
    backup_comp = str(body.get("company_id", "")).strip().lower()
    if backup_comp and backup_comp != company_id:
        return api_json({"error": f"Este backup pertenece a '{backup_comp.upper()}', pero estás en '{company_id.upper()}'. Cambiá de empresa antes de importar."}, 400)

    now = local_now_str()
    fin_batch = []
    for raw in body["financiadoras"]:
        if not isinstance(raw, dict):
            continue
        fid = str(raw.get("id", "")).strip() or slugify(str(raw.get("nombre", "")))
        if company_id != DEFAULT_COMPANY_ID and not fid.startswith(f"{company_id}-"):
            fid = f"{company_id}-{fid}"
        payload, perr = sanitize_fin_payload(db, raw, existing_id=fid, existing_obj=raw)
        if perr:
            continue
        fin_batch.append({
            "id": payload["id"],
            "company_id": company_id,
            "nombre": payload["nombre"],
            "categoria": payload["categoria"],
            "data_json": json.dumps(payload, ensure_ascii=False),
            "updated_at": now,
            "updated_by": admin_user["username"],
        })
    if fin_batch:
        db.insert("financiadoras", fin_batch, upsert=True, on_conflict="id", returning=False)

    if isinstance(body.get("envios"), list) and len(body["envios"]) > 0:
        db.delete("envios_facturacion", {"company_id": company_id})
        env_batch = []
        for raw_e in body["envios"]:
            d, perr = sanitize_envio(raw_e)
            if not perr:
                env_batch.append({"company_id": company_id, **d, "created_by": admin_user["username"], "updated_at": now})
        if env_batch:
            db.insert("envios_facturacion", env_batch, returning=False)

    if isinstance(body.get("postal"), list) and len(body["postal"]) > 0:
        db.delete("envios_postal", {"company_id": company_id})
        pos_batch = []
        for raw_p in body["postal"]:
            d, perr = sanitize_postal(raw_p)
            if not perr:
                pos_batch.append({"company_id": company_id, **d, "created_by": admin_user["username"], "updated_at": now})
        if pos_batch:
            db.insert("envios_postal", pos_batch, returning=False)

    log_audit(db, admin_user["username"], "IMPORTAR_BACKUP", company_id.upper(), f"{len(fin_batch)} financiadoras importadas", client_ip(request), company_id)
    return api_json({"ok": True, "imported": len(fin_batch)})


async def ep_health(request: Request):
    return api_json({"ok": True, "runtime": "vercel-supabase"})


async def handle_supabase_error(request: Request, exc: SupabaseError):
    return api_json({"error": exc.message}, status_code=500 if exc.status_code >= 500 else exc.status_code)


routes = [
    Route("/api/health", ep_health, methods=["GET"]),
    Route("/assets/img/{filename:path}", ep_assets_img, methods=["GET"]),
    Route("/api/uploads/{filename:path}", ep_uploads, methods=["GET"]),
    Route("/api/login", ep_login, methods=["POST"]),
    Route("/api/logout", ep_logout, methods=["POST"]),
    Route("/api/me", ep_me, methods=["GET"]),
    Route("/api/me/password", ep_change_own_password, methods=["POST"]),
    Route("/api/bootstrap", ep_bootstrap, methods=["GET"]),
    Route("/api/parse-geclisa-pdf", ep_parse_geclisa_pdf, methods=["POST"]),
    Route("/api/ai/ask", ep_ai_ask, methods=["POST"]),
    Route("/api/ai/config", ep_ai_config, methods=["GET", "POST"]),
    Route("/api/entregas", ep_entregas, methods=["GET", "POST"]),
    Route("/api/entregas/{entrega_id:int}/completar", ep_completar_entrega, methods=["POST"]),
    Route("/api/entregas/{entrega_id:int}", ep_entrega_item, methods=["PUT", "DELETE"]),
    Route("/api/financiadoras", ep_create_financiadora, methods=["POST"]),
    Route("/api/financiadoras/{fin_id}/notes", ep_financiadora_notes, methods=["PATCH"]),
    Route("/api/financiadoras/{fin_id}", ep_financiadora_item, methods=["PUT", "DELETE"]),
    Route("/api/envios", ep_create_envio, methods=["POST"]),
    Route("/api/envios/import-excel", ep_import_envios_excel, methods=["POST"]),
    Route("/api/envios/{envio_id:int}", ep_envio_item, methods=["PUT", "DELETE"]),
    Route("/api/postal", ep_create_postal, methods=["POST"]),
    Route("/api/postal/import-excel", ep_import_postal_excel, methods=["POST"]),
    Route("/api/postal/{postal_id:int}", ep_postal_item, methods=["PUT", "DELETE"]),
    Route("/api/favorites/{fin_id}", ep_toggle_favorite, methods=["POST"]),
    Route("/api/tracker/{period}/{fin_id}", ep_update_tracker, methods=["PUT"]),
    Route("/api/users", ep_users, methods=["GET", "POST"]),
    Route("/api/users/{target_id:int}", ep_user_item, methods=["PUT", "DELETE"]),
    Route("/api/backup", ep_export_backup, methods=["GET"]),
    Route("/api/backup/import", ep_import_backup, methods=["POST"]),
]

class VercelPathRestoreMiddleware:
    """Restaura scope['path'] cuando Vercel reescribe /api/:path* hacia /api/index?_vpath=..."""

    def __init__(self, asgi_app):
        self.asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            raw_qs = scope.get("query_string", b"").decode("latin-1")
            path = scope.get("path", "")
            if "_vpath=" in raw_qs:
                pairs = urllib.parse.parse_qsl(raw_qs, keep_blank_values=True)
                vpath = ""
                kept = []
                for k, v in pairs:
                    if k == "_vpath" and not vpath:
                        vpath = v
                    else:
                        kept.append((k, v))
                if vpath:
                    if not vpath.startswith("/"):
                        vpath = "/" + vpath
                    scope = dict(scope)
                    scope["path"] = vpath
                    scope["raw_path"] = vpath.encode("utf-8")
                    scope["query_string"] = urllib.parse.urlencode(kept).encode("latin-1")
            elif path in ("/api/index", "/api/index.py"):
                hdrs = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
                orig = hdrs.get("x-forwarded-uri") or hdrs.get("x-original-url") or hdrs.get("x-invoke-path") or ""
                if orig and orig not in ("/api/index", "/api/index.py"):
                    p_only = orig.split("?", 1)[0]
                    scope = dict(scope)
                    scope["path"] = p_only
                    scope["raw_path"] = p_only.encode("utf-8")
        await self.asgi_app(scope, receive, send)


app = Starlette(
    debug=False,
    routes=routes,
    middleware=[Middleware(VercelPathRestoreMiddleware)],
    exception_handlers={SupabaseError: handle_supabase_error},
)
