# Guía de Despliegue Online — Vercel + Supabase (Gratis y Seguro)

Esta carpeta (`InstructivoExportacionCloud`) contiene la versión 100% lista para publicar en **Vercel + Supabase**, conservando exactamente todas las funciones de tu portal:

- **Multi-empresa estrictamente aislada**: Instituto Médico Río Cuarto (**IMRC**) y Policlínico Privado San Lucas (**PPSL**).
- **4 roles con permisos en servidor**: `admin`, `exportacion` (Sector Exportaciones), `consulta` y `facturista`.
- **Eliminación exclusiva de Administrador**: solo el rol `admin` puede eliminar registros o sobrescribir períodos.
- **Lector inteligente de PDFs de Geclisa** con almacenamiento privado en Supabase Storage (los PDFs nunca quedan públicos).
- **Asistente IA del portal** (motor local inteligente incluido + opción de agregar `GEMINI_API_KEY`).
- **Control Mensual**, **Seguimiento Andreani**, **Importador de Excel** y **Auditoría de cambios**.

> Tu versión local anterior (`InstructivoExportacion`) quedó **intacta** y sin modificar.

---

## Paso 1: Crear el proyecto y las tablas en Supabase (3 minutos)

1. Ingresá a [https://supabase.com](https://supabase.com) y creá una cuenta gratuita (podés iniciar sesión con GitHub o Google).
2. Hacé clic en **New Project**:
   - **Name**: `instructivo-exportacion`
   - **Database Password**: elegí una contraseña fuerte y guardala.
   - **Region**: elegí **South America (São Paulo)** (`sa-east-1`) para mínima latencia desde Argentina.
   - Plan: **Free**.
3. Esperá ~1 minuto a que termine de aprovisionarse.
4. En el menú izquierdo, entrá a **SQL Editor** → **New query**.
5. Abrí el archivo `supabase_schema.sql` de esta carpeta, copiá **todo su contenido**, pegalo en el editor y hacé clic en **Run** (Ctrl+Enter).
   - Verificá que diga **`Success. No rows returned`**.
   - Esto crea todas las tablas, índices, el bucket privado `uploads` y activa **Row Level Security (RLS)** sin políticas públicas (bloqueando el acceso anónimo desde internet).
6. En el menú izquierdo, entrá a **Project Settings** (ícono engranaje) → **API** y copiá estos dos valores:
   - **Project URL** (ej: `https://abcdefghijkl.supabase.co`)
   - **`service_role` secret key** (hacé clic en *Reveal* — **NUNCA** la compartas ni la subas a GitHub).

---

## Paso 2: Migrar tus datos actuales a Supabase (1 minuto)

Desde tu PC local (en esta carpeta `InstructivoExportacionCloud`), ejecutá una sola vez:

```powershell
python migrar_a_supabase.py
```

El script te va a pedir la `SUPABASE_URL` y la `SUPABASE_SERVICE_ROLE_KEY` (o las toma automáticamente si creás un archivo `.env` local a partir de `.env.example`) y va a subir automáticamente:
- Empresas **IMRC** y **PPSL**
- Tus **usuarios** actuales con sus contraseñas encriptadas (`PBKDF2-SHA256`) y roles
- Todas las **86 financiadoras** (50 IMRC + 36 PPSL)
- Todo el historial del **Control Mensual** (1.799 envíos IMRC + 58 envíos PPSL) y **43 envíos Andreani**
- Entregas de facturistas, favoritos, auditoría y los PDFs/imágenes de `data/uploads/`

> Si lo ejecutás de nuevo por error, es seguro (**idempotente**): actualiza sin duplicar filas.

---

## Paso 3: Subir el proyecto a un repositorio PRIVADO en GitHub (2 minutos)

1. Ingresá a [https://github.com](https://github.com) y creá un repositorio nuevo marcado como **Private (Privado)** (ej: `portal-exportacion-imrc`).
2. Subí únicamente el contenido de la carpeta `InstructivoExportacionCloud` (el archivo `.gitignore` ya protege `.env` y cachés para que nunca se suban claves):

```powershell
cd "c:\Users\Usuario\Documents\Antigravity\InstructivoExportacionCloud"
git init
git add .
git commit -m "Version inicial Vercel + Supabase"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/portal-exportacion-imrc.git
git push -u origin main
```

---

## Paso 4: Publicar en Vercel (2 minutos)

1. Ingresá a [https://vercel.com](https://vercel.com) e iniciá sesión con tu cuenta de GitHub.
2. Hacé clic en **Add New... → Project** e importá tu repositorio privado `portal-exportacion-imrc`.
3. Antes de presionar *Deploy*, desplegá la sección **Environment Variables** y cargá:
   - `SUPABASE_URL` = tu Project URL de Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` = tu clave `service_role` de Supabase
   - *(Opcional)* `GEMINI_API_KEY` = tu clave de Google Gemini si querés potenciar el Asistente IA
4. Hacé clic en **Deploy**. En ~45 segundos Vercel te dará tu enlace HTTPS permanente (por ejemplo `https://portal-exportacion-imrc.vercel.app`).

---

## Recomendaciones de Seguridad y Mantenimiento

1. **Cambiá la contraseña de `admin` apenas ingreses**: si todavía usás la clave por defecto, cambiala desde el botón **🔑 Clave** arriba a la derecha.
2. **Privacidad y Datos Sensibles**:
   - Las cookies de sesión viajan únicamente por **HTTPS** (`Secure; HttpOnly; SameSite=Lax`).
   - Los archivos PDF subidos de Geclisa y las capturas de pantallas del instructivo **no son públicos**: se entregan exclusivamente a usuarios autenticados con el rol adecuado.
   - Si en algún momento necesitás restringir el acceso solo a la clínica, podés usar un dominio propio o migrar en el futuro al servidor interno del hospital sin cambiar la interfaz.
3. **Plan Gratuito de Supabase (Pausa por inactividad)**:
   - El plan gratuito de Supabase pausa el proyecto si pasa **7 días seguidos sin ninguna visita**. Con el uso diario normal del equipo de Facturación/Exportación no se pausa nunca; y si sucediera por vacaciones, se reactiva con 1 clic desde el panel de Supabase sin perder datos.
4. **Copias de Seguridad (Backups)**:
   - Como Administrador, podés descargar un **Backup JSON** completo de cada empresa (IMRC y PPSL) en cualquier momento desde el botón **Backup** del portal para guardarlo en tu PC o Google Drive.
5. **Límite de tamaño de archivos en Vercel Free**:
   - Vercel Hobby permite subidas de hasta ~4.5 MB por archivo; el portal valida hasta **4 MB** por PDF/imagen (los reportes de Geclisa suelen pesar entre 50 KB y 500 KB, así que sobra espacio).
