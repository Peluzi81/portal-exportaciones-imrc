#!/usr/bin/env python3
"""
Migrador idempotente: SQLite local (InstructivoExportacion/data/instructivo.db) -> Supabase (PostgreSQL + Storage).

Qué migra:
  1. Empresas (IMRC y PPSL) con sus datos institucionales y guías generales.
  2. Usuarios con sus contraseñas encriptadas (PBKDF2-SHA256) y roles intactos.
  3. Todas las Financiadoras de IMRC y PPSL.
  4. Favoritos y Tracker mensual.
  5. Todo el historial de Control Mensual (envios_facturacion) y Seguimiento Andreani (envios_postal).
  6. Bandeja de Entregas de Facturistas (entregas_facturacion), configuración (meta) y Auditoría (audit_log).
  7. Todos los archivos PDF/imágenes subidos en data/uploads/ hacia el bucket privado 'uploads' de Supabase Storage.

Uso:
  python migrar_a_supabase.py
  python migrar_a_supabase.py --dry-run
  python migrar_a_supabase.py --db "C:\\ruta\\a\\instructivo.db"
"""

import argparse
import getpass
import mimetypes
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "api"))

from supabase_client import SupabaseClient, SupabaseError  # noqa: E402

DEFAULT_SQLITE_PATH = SCRIPT_DIR.parent / "InstructivoExportacion" / "data" / "instructivo.db"
DEFAULT_UPLOADS_DIR = SCRIPT_DIR.parent / "InstructivoExportacion" / "data" / "uploads"

# Orden estricto respetando Foreign Keys: (tabla, columna_conflicto, columnas_a_exportar)
TABLES_PLAN: List[Tuple[str, str, List[str]]] = [
    (
        "companies",
        "id",
        ["id", "sigla", "nombre", "subtitulo", "theme_color", "institution_json", "general_guide_json", "sort_order", "active"],
    ),
    (
        "users",
        "id",
        ["id", "username", "full_name", "role", "password_hash", "active", "must_change_password", "allowed_companies", "created_at", "last_login"],
    ),
    (
        "financiadoras",
        "id",
        ["id", "company_id", "nombre", "categoria", "data_json", "updated_at", "updated_by"],
    ),
    (
        "favorites",
        "user_id,financiadora_id",
        ["user_id", "financiadora_id"],
    ),
    (
        "tracker",
        "period,financiadora_id",
        ["period", "financiadora_id", "amb", "int", "nota", "updated_at", "updated_by"],
    ),
    (
        "envios_facturacion",
        "id",
        [
            "id", "company_id", "period", "financiadora_id", "os_cod", "os_nombre", "grupo",
            "area", "tipo", "fecha_envio", "importe", "etiqueta", "observacion",
            "pdf_filename", "pdf_url", "facturas_json", "created_by", "updated_at",
        ],
    ),
    (
        "envios_postal",
        "id",
        [
            "id", "company_id", "period", "fecha_envio", "obra_social", "medio",
            "seguimiento", "fecha_entrega", "observacion", "created_by", "updated_at",
        ],
    ),
    (
        "entregas_facturacion",
        "id",
        [
            "id", "company_id", "financiadora_id", "os_cod", "os_nombre", "grupo", "area",
            "period", "condicion", "tipo", "importe", "observacion", "pdf_filename", "pdf_url",
            "facturas_json", "estado", "respuesta_exportacion", "envio_id",
            "created_by_id", "created_by_name", "created_at", "processed_by", "processed_at", "updated_at",
        ],
    ),
    (
        "meta",
        "key",
        ["key", "value_json"],
    ),
    (
        "audit_log",
        "id",
        ["id", "timestamp", "username", "action", "target", "details", "ip", "company_id"],
    ),
]


def load_dotenv(env_path: Path) -> None:
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def read_sqlite_table(conn: sqlite3.Connection, table: str, expected_cols: List[str]) -> List[Dict[str, Any]]:
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
    if not cur.fetchone():
        return []
    existing_cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    use_cols = [c for c in expected_cols if c in existing_cols]
    if not use_cols:
        return []
    rows = conn.execute(f"SELECT {', '.join(use_cols)} FROM {table}").fetchall()
    out: List[Dict[str, Any]] = []
    for r in rows:
        item = {}
        for c in expected_cols:
            if c in existing_cols:
                val = r[c]
                # Normalizar valores nulos en campos NOT NULL de Postgres
                if val is None and c not in ("last_login", "updated_by", "envio_id", "ip"):
                    if c in ("importe",):
                        val = 0.0
                    elif c in ("sort_order", "active", "must_change_password"):
                        val = 0
                    else:
                        val = ""
                item[c] = val
            else:
                if c in ("importe",):
                    item[c] = 0.0
                elif c in ("sort_order", "active", "must_change_password"):
                    item[c] = 0
                elif c == "facturas_json":
                    item[c] = "[]"
                elif c in ("last_login", "updated_by", "envio_id", "ip"):
                    item[c] = None
                else:
                    item[c] = ""
        out.append(item)
    return out


def migrate(
    db_path: Path,
    uploads_dir: Path,
    client: Optional[SupabaseClient],
    dry_run: bool = False,
) -> Dict[str, int]:
    if not db_path.exists():
        raise FileNotFoundError(f"No se encontró la base de datos local SQLite en: {db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    summary: Dict[str, int] = {}

    try:
        print(f"Origen SQLite: {db_path}")
        if dry_run:
            print("MODO SIMULACION (--dry-run): no se enviaran datos a Supabase.\n")
        else:
            print(f"Destino Supabase: {client.url}\n")

        for table, on_conflict, cols in TABLES_PLAN:
            rows = read_sqlite_table(conn, table, cols)
            summary[table] = len(rows)
            print(f"  - {table:<22}: {len(rows):>5} registros", end="", flush=True)
            if not dry_run and rows:
                assert client is not None
                client.insert(table, rows, upsert=True, on_conflict=on_conflict, returning=False)
                print("  [OK]")
            elif dry_run:
                print("  [dry-run]")
            else:
                print("  [vacía]")

        # Sincronizar secuencias IDENTITY para que los nuevos INSERT no choquen con IDs migrados
        if not dry_run:
            assert client is not None
            print("\nSincronizando secuencias auto-incrementales en PostgreSQL...", end="", flush=True)
            client.rpc("sync_identity_sequences")
            print("  [OK]")

        # Migrar archivos subidos (PDFs de Geclisa y capturas de financiadoras)
        uploaded_files = 0
        if uploads_dir.exists() and uploads_dir.is_dir():
            files = [p for p in sorted(uploads_dir.iterdir()) if p.is_file() and not p.name.startswith(".")]
            print(f"\nArchivos locales en {uploads_dir.name}/: {len(files)}")
            for fpath in files:
                ctype, _ = mimetypes.guess_type(fpath.name)
                ctype = ctype or "application/octet-stream"
                print(f"  - {fpath.name} ({fpath.stat().st_size:,} bytes)", end="", flush=True)
                if not dry_run:
                    assert client is not None
                    client.upload_file("uploads", fpath.name, fpath.read_bytes(), ctype)
                    print("  [OK]")
                else:
                    print("  [dry-run]")
                uploaded_files += 1
        summary["storage_files"] = uploaded_files
    finally:
        conn.close()

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrar base SQLite local a Supabase (PostgreSQL + Storage).")
    parser.add_argument("--db", type=Path, default=DEFAULT_SQLITE_PATH, help="Ruta al archivo instructivo.db")
    parser.add_argument("--uploads", type=Path, default=DEFAULT_UPLOADS_DIR, help="Ruta a la carpeta data/uploads")
    parser.add_argument("--dry-run", action="store_true", help="Solo contar y validar sin escribir en Supabase")
    args = parser.parse_args()

    load_dotenv(SCRIPT_DIR / ".env")

    client: Optional[SupabaseClient] = None
    if not args.dry_run:
        url = os.environ.get("SUPABASE_URL", "").strip()
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url:
            url = input("Ingresá tu SUPABASE_URL (ej. https://xxxx.supabase.co): ").strip()
        if not key:
            key = getpass.getpass("Ingresá tu SUPABASE_SERVICE_ROLE_KEY (oculta al escribir): ").strip()
        client = SupabaseClient(url=url, service_key=key, timeout=45)
        client.ensure_configured()

    print("=" * 66)
    print("  MIGRADOR A SUPABASE — Centro de Exportación y Facturación")
    print("=" * 66)
    try:
        summary = migrate(args.db, args.uploads, client, dry_run=args.dry_run)
    except SupabaseError as e:
        print(f"\n[ERROR SUPABASE] {e}")
        print("Verificá que hayas ejecutado primero 'supabase_schema.sql' en el SQL Editor de Supabase")
        print("y que la clave ingresada sea la 'service_role' (no la 'anon').")
        return 1
    except Exception as e:
        print(f"\n[ERROR] {e}")
        return 1

    print("\n" + "=" * 66)
    if args.dry_run:
        print("Simulación completada sin errores.")
    else:
        print("¡Migración completada con éxito!")
        print(f"Total financiadoras: {summary.get('financiadoras', 0)}")
        print(f"Total envíos Control Mensual: {summary.get('envios_facturacion', 0)}")
        print(f"Total envíos Andreani: {summary.get('envios_postal', 0)}")
        print(f"Total usuarios migrados (con sus contraseñas): {summary.get('users', 0)}")
        print(f"Total archivos subidos a Storage: {summary.get('storage_files', 0)}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
