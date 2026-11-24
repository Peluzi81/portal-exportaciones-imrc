#!/usr/bin/env python3
"""
Cliente ligero para Supabase PostgREST + Supabase Storage (solo requests HTTPS).
- Usa SUPABASE_SERVICE_ROLE_KEY del lado del servidor (nunca se expone al navegador).
- Paginación automática (>1000 filas) para que el Control Mensual histórico nunca se trunque.
"""

import os
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import requests


class SupabaseError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(f"Supabase HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class SupabaseClient:
    def __init__(self, url: Optional[str] = None, service_key: Optional[str] = None, timeout: int = 20):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).strip().rstrip("/")
        self.service_key = (service_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")).strip()
        self.timeout = timeout
        self.session = requests.Session()

    def ensure_configured(self):
        if not self.url or not self.service_key:
            raise SupabaseError(
                500,
                "Faltan configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Vercel.",
            )

    def _rest_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        self.ensure_configured()
        h = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _build_params(
        self,
        filters: Optional[Dict[str, Any]] = None,
        select: str = "*",
        order: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Tuple[str, str]]:
        params: List[Tuple[str, str]] = [("select", select)]
        if filters:
            for k, v in filters.items():
                if isinstance(v, tuple) and len(v) == 2:
                    op, val = v
                    params.append((k, f"{op}.{val}"))
                else:
                    params.append((k, f"eq.{v}"))
        if order:
            params.append(("order", order))
        if limit is not None:
            params.append(("limit", str(limit)))
        return params

    def _check(self, resp: requests.Response):
        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("message") or body.get("error") or body.get("hint") or resp.text
            except Exception:
                msg = resp.text
            raise SupabaseError(resp.status_code, str(msg)[:400])

    def select(
        self,
        table: str,
        filters: Optional[Dict[str, Any]] = None,
        select: str = "*",
        order: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        url = f"{self.url}/rest/v1/{table}"
        if limit is not None:
            params = self._build_params(filters, select=select, order=order, limit=limit)
            resp = self.session.get(url, headers=self._rest_headers(), params=params, timeout=self.timeout)
            self._check(resp)
            return resp.json() or []

        # Paginación automática en bloques de 1000 filas (PostgREST max default)
        all_rows: List[Dict[str, Any]] = []
        page_size = 1000
        offset = 0
        params = self._build_params(filters, select=select, order=order)
        while True:
            headers = self._rest_headers({"Range": f"{offset}-{offset + page_size - 1}"})
            resp = self.session.get(url, headers=headers, params=params, timeout=self.timeout)
            self._check(resp)
            batch = resp.json() or []
            all_rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return all_rows

    def select_one(
        self,
        table: str,
        filters: Optional[Dict[str, Any]] = None,
        select: str = "*",
    ) -> Optional[Dict[str, Any]]:
        rows = self.select(table, filters=filters, select=select, limit=1)
        return rows[0] if rows else None

    def count(self, table: str, filters: Optional[Dict[str, Any]] = None) -> int:
        url = f"{self.url}/rest/v1/{table}"
        params = self._build_params(filters, select="id")
        headers = self._rest_headers({"Prefer": "count=exact", "Range": "0-0"})
        resp = self.session.head(url, headers=headers, params=params, timeout=self.timeout)
        if resp.status_code >= 400:
            # Fallback si la tabla no tiene columna 'id'
            params = self._build_params(filters, select="*")
            resp = self.session.head(url, headers=headers, params=params, timeout=self.timeout)
        self._check(resp)
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            tot = cr.rsplit("/", 1)[1]
            if tot.isdigit():
                return int(tot)
        return 0

    def insert(
        self,
        table: str,
        payload: Any,
        upsert: bool = False,
        on_conflict: Optional[str] = None,
        returning: bool = True,
    ) -> List[Dict[str, Any]]:
        url = f"{self.url}/rest/v1/{table}"
        prefers = ["return=representation" if returning else "return=minimal"]
        if upsert:
            prefers.append("resolution=merge-duplicates")
        headers = self._rest_headers({"Prefer": ",".join(prefers)})
        params = [("on_conflict", on_conflict)] if (upsert and on_conflict) else []

        if isinstance(payload, list):
            if not payload:
                return []
            results: List[Dict[str, Any]] = []
            chunk_size = 300
            for i in range(0, len(payload), chunk_size):
                chunk = payload[i : i + chunk_size]
                resp = self.session.post(url, headers=headers, params=params, json=chunk, timeout=self.timeout)
                self._check(resp)
                if returning and resp.content:
                    results.extend(resp.json() or [])
            return results

        resp = self.session.post(url, headers=headers, params=params, json=payload, timeout=self.timeout)
        self._check(resp)
        if returning and resp.content:
            data = resp.json()
            return data if isinstance(data, list) else [data]
        return []

    def update(
        self,
        table: str,
        filters: Dict[str, Any],
        payload: Dict[str, Any],
        returning: bool = True,
    ) -> List[Dict[str, Any]]:
        url = f"{self.url}/rest/v1/{table}"
        headers = self._rest_headers({"Prefer": "return=representation" if returning else "return=minimal"})
        params = self._build_params(filters, select="*")
        resp = self.session.patch(url, headers=headers, params=params, json=payload, timeout=self.timeout)
        self._check(resp)
        if returning and resp.content:
            return resp.json() or []
        return []

    def delete(self, table: str, filters: Dict[str, Any]) -> None:
        url = f"{self.url}/rest/v1/{table}"
        headers = self._rest_headers({"Prefer": "return=minimal"})
        params = self._build_params(filters, select="*")
        resp = self.session.delete(url, headers=headers, params=params, timeout=self.timeout)
        self._check(resp)

    def rpc(self, fn_name: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.url}/rest/v1/rpc/{fn_name}"
        resp = self.session.post(url, headers=self._rest_headers(), json=payload or {}, timeout=self.timeout)
        self._check(resp)
        if resp.content:
            try:
                return resp.json()
            except Exception:
                return resp.text
        return None

    # ===================== SUPABASE STORAGE (BUCKET PRIVADO) =====================
    def upload_file(self, bucket: str, object_path: str, raw_bytes: bytes, content_type: str) -> None:
        self.ensure_configured()
        safe_path = urllib.parse.quote(object_path.lstrip("/"), safe="/")
        url = f"{self.url}/storage/v1/object/{bucket}/{safe_path}"
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": content_type,
            "x-upsert": "true",
        }
        resp = self.session.post(url, headers=headers, data=raw_bytes, timeout=self.timeout)
        self._check(resp)

    def download_file(self, bucket: str, object_path: str) -> Tuple[Optional[bytes], str]:
        self.ensure_configured()
        safe_path = urllib.parse.quote(object_path.lstrip("/"), safe="/")
        url = f"{self.url}/storage/v1/object/{bucket}/{safe_path}"
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
        }
        resp = self.session.get(url, headers=headers, timeout=self.timeout)
        if resp.status_code in (400, 404):
            return None, ""
        self._check(resp)
        ct = resp.headers.get("Content-Type", "application/octet-stream")
        return resp.content, ct
