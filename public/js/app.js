// Aplicación principal — Centro de Exportación y Facturación (IMRC)
// Conectada al servidor interno Python con autenticación, roles, control mensual de envíos/montos y seguimiento Andreani

(function () {
  const PREFS_KEYS = {
    THEME: "imrc_export_theme_v2",
    EMAIL_SEP: "imrc_export_email_sep_v2",
    COMPANY: "imrc_export_company_v1",
    TASK_CHECKS: "imrc_export_task_checks_v1"
  };

  const ENTREGA_ESTADO_META = {
    pendiente: { label: "Pendiente", icon: "🟡", cls: "badge-amber" },
    en_proceso: { label: "En proceso", icon: "🔵", cls: "badge-blue" },
    observado: { label: "Observado", icon: "⚠️", cls: "badge-rose" },
    enviado: { label: "Enviado", icon: "✅", cls: "badge-emerald" }
  };

  const CATEGORY_LABELS = {
    obra_social: "Obra Social / Prepaga",
    directa: "Directa Digital",
    art: "ART / Seguro",
    colegio_medico: "Colegio Médico"
  };

  const CHANNEL_META = {
    portal: { label: "Portal Web", icon: "🌐", cls: "badge-indigo" },
    email: { label: "Email", icon: "✉️", cls: "badge-blue" },
    drive: { label: "Drive", icon: "☁️", cls: "badge-emerald" },
    txt: { label: "TXT (Exp. Fact.)", icon: "📄", cls: "badge-amber" },
    fisico: { label: "Envío Físico", icon: "📦", cls: "badge-rose" }
  };

  const ENVIO_TIPO_META = {
    normal: { label: "Normal", short: "", cls: "badge-neutral" },
    refacturacion: { label: "Refacturación", short: "Refact.", cls: "badge-amber" },
    diferencia_arancel: { label: "Dif. Arancel", short: "Dif. Arancel", cls: "badge-purple" },
    preliquidacion: { label: "Preliquidación", short: "Preliq.", cls: "badge-blue" },
    otros: { label: "Otros", short: "Otro", cls: "badge-neutral" }
  };

  const EXTRA_POSTAL_OBRAS = [
    "COMFYE", "DIMSA", "FUTBOLISTAS", "INTERESTETICA", "OSDIPP",
    "OSPE URO (AMBULATORIO)", "OSPES", "OSPJAT", "OSPJTAP", "PREMEDIC", "SAN PEDRO"
  ];

  // ===================== STATE =====================
  let state = {
    user: null,
    activeCompanyId: "",
    company: null,
    companies: [],
    adminCompanies: [],
    institution: {},
    generalGuide: [],
    financiadoras: [],
    favorites: [],
    tracker: {},
    envios: [],
    postal: [],
    entregas: [],
    usersList: [],
    auditLogs: [],
    activeView: "financiadoras",
    selectedId: null,
    searchQuery: "",
    sidebarSearch: "",
    categoryFilter: "all",
    channelFilter: null,
    // Bandeja de tareas (Exportación) & Facturista
    tareasFilter: "activas", // "activas" | "pendiente" | "en_proceso" | "observado" | "enviado" | "all"
    tareasSearch: "",
    editingEntregaId: null,
    facturistaArea: "ambulatorio",
    facturistaPdf: null,
    modalEntregaPdf: null,
    modalEnvioPdf: null,
    expandedCredTaskIds: {},
    expandedPdfTaskIds: {},
    pollingTimer: null,
    knownPendingEntregaIds: null,
    // Control Mensual
    trackerPeriod: getCurrentYYYYMM(),
    envioSubtab: "consolidado", // "consolidado" | "detalle"
    envioFilter: "all", // "all" | "enviados" | "pendientes" | "especiales"
    envioAreaFilter: "all",
    envioSearch: "",
    // Postal Andreani
    postalPeriod: "all",
    postalStatusFilter: "all", // "all" | "transito" | "entregado"
    postalSearch: "",
    // Prefs & Modals
    emailSeparator: "; ",
    theme: "light",
    lightboxImages: [],
    lightboxIndex: 0,
    formImages: [],
    importMode: "envios", // "envios" | "postal"
    importFilesPayload: [],
    importSummaries: []
  };

  function isAdmin() {
    return Boolean(state.user && state.user.role === "admin");
  }

  function canEditFinanciadoras() {
    return Boolean(state.user && (state.user.role === "admin" || state.user.role === "exportacion"));
  }

  function isFacturista() {
    return Boolean(state.user && state.user.role === "facturista");
  }

  function getCurrentYYYYMM() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function getTodayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatMoney(num) {
    const n = Number(num || 0);
    return "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDateAR(iso) {
    if (!iso || iso.length < 10) return "—";
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }

  function daysBetween(isoStart, isoEnd) {
    if (!isoStart || !isoEnd) return null;
    const d1 = new Date(isoStart + "T00:00:00");
    const d2 = new Date(isoEnd + "T00:00:00");
    if (isNaN(d1) || isNaN(d2)) return null;
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  }

  // ===================== API HELPER =====================
  async function apiFetch(url, options = {}) {
    const companyHeaders = state.activeCompanyId ? { "X-Company-Id": state.activeCompanyId } : {};
    const opts = {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...companyHeaders,
        ...(options.headers || {})
      },
      ...options
    };
    const resp = await fetch(url, opts);
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      data = {};
    }

    if (resp.status === 401 && url !== "/api/login" && !url.startsWith("/api/bootstrap")) {
      handleSessionExpired();
      throw new Error(data.error || "Sesión expirada");
    }

    if (!resp.ok) {
      throw new Error(data.error || `Error HTTP ${resp.status}`);
    }
    return data;
  }

  // ===================== INIT & AUTH =====================
  async function init() {
    state.theme = localStorage.getItem(PREFS_KEYS.THEME) || "light";
    state.emailSeparator = localStorage.getItem(PREFS_KEYS.EMAIL_SEP) || "; ";
    state.activeCompanyId = localStorage.getItem(PREFS_KEYS.COMPANY) || "";
    applyTheme();

    const sepSel = document.getElementById("email-separator-select");
    if (sepSel) sepSel.value = state.emailSeparator;

    bindAuthEvents();
    bindGlobalEvents();

    if (window.location.protocol === "file:") {
      showAuthError(
        "Esta página funciona únicamente a través de su dirección web segura (HTTPS en Vercel). No puede abrirse haciendo doble clic en el archivo HTML."
      );
      document.getElementById("login-submit-btn").disabled = true;
      return;
    }

    await tryBootstrapSession();
  }

  async function fetchBootstrapForCompany(companyId = "") {
    const q = companyId ? `?company=${encodeURIComponent(companyId)}` : "";
    try {
      return await apiFetch(`/api/bootstrap${q}`, { method: "GET" });
    } catch (err) {
      if (companyId) {
        state.activeCompanyId = "";
        localStorage.removeItem(PREFS_KEYS.COMPANY);
        return await apiFetch("/api/bootstrap", { method: "GET" });
      }
      throw err;
    }
  }

  async function tryBootstrapSession() {
    try {
      const data = await fetchBootstrapForCompany(state.activeCompanyId);
      applyBootstrapData(data);
      showAppShell();
    } catch (_) {
      showAuthGate();
    }
  }

  function applyBootstrapData(data) {
    state.user = data.user;
    state.company = data.company || { id: "imrc", sigla: "IMRC", nombre: "Instituto Médico Río Cuarto S.A.", subtitulo: "Instructivo de Exportación", theme_color: "teal" };
    state.companies = data.companies || [state.company];
    state.activeCompanyId = state.company.id;
    localStorage.setItem(PREFS_KEYS.COMPANY, state.activeCompanyId);

    state.institution = data.institution || {};
    state.generalGuide = data.general_guide || [];
    state.financiadoras = data.financiadoras || [];
    state.favorites = data.favorites || [];
    state.tracker = data.tracker || {};
    state.envios = data.envios || [];
    state.postal = data.postal || [];
    state.entregas = data.entregas || [];
    state.selectedId = null;
    state.editingEntregaId = null;
    state.knownPendingEntregaIds = new Set(
      state.entregas.filter((e) => e.estado === "pendiente").map((e) => e.id)
    );

    const periodsWithEnvios = [...new Set(state.envios.map((e) => e.period))].sort().reverse();
    if (!periodsWithEnvios.includes(state.trackerPeriod) && periodsWithEnvios.length > 0) {
      state.trackerPeriod = periodsWithEnvios[0];
    } else if (periodsWithEnvios.length === 0) {
      state.trackerPeriod = getCurrentYYYYMM();
    }
    const periodInput = document.getElementById("tracker-period");
    if (periodInput) periodInput.value = state.trackerPeriod;

    const postalPeriods = [...new Set(state.postal.map((p) => p.period))].sort().reverse();
    if (postalPeriods.length > 0) {
      if (state.postalPeriod === "all" || !postalPeriods.includes(state.postalPeriod)) {
        state.postalPeriod = postalPeriods[0];
      }
    } else {
      state.postalPeriod = "all";
    }

    applyCompanyBranding();
    populateDatalists();
    applyRoleUI();

    if (isFacturista()) {
      switchView("entregar");
    } else {
      if (state.activeView === "entregar") state.activeView = "financiadoras";
      renderAll();
      switchView(state.activeView);
    }
    startEntregasPolling();
  }

  async function switchCompany(companyId) {
    if (!companyId || companyId === state.activeCompanyId) return;
    state.selectedId = null;
    state.editingEntregaId = null;
    state.searchQuery = "";
    state.sidebarSearch = "";
    state.categoryFilter = "all";
    state.channelFilter = null;
    state.envioSearch = "";
    state.envioFilter = "all";
    state.envioAreaFilter = "all";
    state.postalSearch = "";
    state.postalStatusFilter = "all";
    state.postalPeriod = "all";
    state.tareasSearch = "";
    state.trackerPeriod = getCurrentYYYYMM();

    const gSearch = document.getElementById("global-search");
    if (gSearch) gSearch.value = "";
    const gClear = document.getElementById("global-search-clear");
    if (gClear) gClear.classList.add("hidden");
    const sSearch = document.getElementById("sidebar-filter-input");
    if (sSearch) sSearch.value = "";
    document.querySelectorAll("#category-filters .chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.cat === "all");
    });
    document.querySelectorAll("#channel-filters .chip-sm").forEach((c) => c.classList.remove("active"));

    try {
      state.activeCompanyId = companyId;
      const data = await apiFetch(`/api/bootstrap?company=${encodeURIComponent(companyId)}`, { method: "GET" });
      applyBootstrapData(data);
      if (state.activeView === "usuarios" && isAdmin()) {
        loadAndRenderUsuariosView();
      }
      closeMobileSidebar();
      showToast(`Empresa activa: ${state.company.sigla} — ${state.company.nombre}`);
    } catch (err) {
      showToast(err.message || "No se pudo cambiar de empresa");
    }
  }

  function applyCompanyBranding() {
    const comp = state.company || { id: "imrc", sigla: "IMRC", nombre: "Instituto Médico Río Cuarto S.A.", theme_color: "teal" };
    document.documentElement.setAttribute("data-company", comp.id);
    document.title = `Centro de Exportación — ${comp.sigla}`;

    const bt = document.getElementById("brand-title");
    if (bt) bt.textContent = `Facturación ${comp.sigla}`;
    const bs = document.getElementById("brand-sub");
    if (bs) bs.textContent = comp.nombre;

    const tpSigla = document.getElementById("topbar-company-sigla");
    if (tpSigla) tpSigla.textContent = comp.sigla;
    const tpPill = document.getElementById("topbar-company-pill");
    if (tpPill) tpPill.title = `Empresa activa: ${comp.nombre} (datos 100% separados)`;

    const gSearch = document.getElementById("global-search");
    if (gSearch) gSearch.placeholder = `Buscar en ${comp.sigla} o preguntar a la IA (Enter)...`;

    const aiCompBadge = document.getElementById("ai-company-badge");
    if (aiCompBadge) aiCompBadge.textContent = comp.sigla;
    closeAiPopover();

    const hTitle = document.getElementById("hero-dir-title");
    if (hTitle) hTitle.textContent = `Directorio de Financiadoras — ${comp.sigla}`;
    const hSub = document.getElementById("hero-dir-sub");
    if (hSub) hSub.textContent = `Normativas, credenciales, casillas de correo y requisitos exclusivos de ${comp.nombre}.`;

    const tHdr = document.getElementById("tareas-header-title");
    if (tHdr) tHdr.textContent = `Bandeja de Tareas — ${comp.sigla}`;
    const eHdr = document.getElementById("entregar-header-title");
    if (eHdr) eHdr.textContent = `Entregar Facturación a Exportaciones — ${comp.sigla}`;

    const gTitle = document.getElementById("guia-header-title");
    if (gTitle) gTitle.textContent = `Guía General de Exportación — ${comp.sigla}`;
    const gSub = document.getElementById("guia-header-sub");
    if (gSub) gSub.textContent = `Procedimiento operativo y controles clave de ${comp.nombre}.`;

    const tTitle = document.getElementById("tools-inst-title");
    if (tTitle) tTitle.textContent = `Ficha Rápida — ${comp.nombre} (${comp.sigla})`;

    const bLbl = document.getElementById("backup-company-label");
    if (bLbl) bLbl.textContent = comp.sigla;

    renderCompanySwitcher();
    renderHeroQuickPaths();
  }

  function renderCompanySwitcher() {
    const container = document.getElementById("company-switcher");
    if (!container) return;
    const list = state.companies || [];
    container.innerHTML = list.map((c) => {
      const isAct = c.id === state.activeCompanyId;
      const dotCls = c.theme_color === "indigo" ? "company-dot-indigo" : c.theme_color === "sky" ? "company-dot-sky" : "company-dot-teal";
      return `
        <button type="button" class="company-switch-btn ${isAct ? "active" : ""}" data-company-id="${escapeAttr(c.id)}" title="${escapeAttr(c.nombre)}">
          <span class="company-switch-top">
            <span class="company-dot ${dotCls}"></span>
            <span>${escapeHtml(c.sigla)}</span>
          </span>
          <span class="company-switch-name">${escapeHtml(c.nombre)}</span>
        </button>
      `;
    }).join("");

    container.querySelectorAll(".company-switch-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchCompany(btn.dataset.companyId));
    });
  }

  function renderHeroQuickPaths() {
    const wrap = document.getElementById("hero-quick-paths");
    if (!wrap) return;
    const inst = state.institution || {};
    const pills = [];
    if (inst.rutas && inst.rutas.length > 0 && inst.rutas[0].path) {
      pills.push({ icon: "📁", label: inst.rutas[0].path, copy: inst.rutas[0].path, title: `Copiar ${inst.rutas[0].label}` });
    }
    if (inst.cuit) {
      pills.push({ icon: "🏢", label: `CUIT: ${inst.cuit}`, copy: inst.cuit, title: `Copiar CUIT ${inst.sigla || ""}` });
    }
    if (inst.emailPrincipal) {
      pills.push({ icon: "✉️", label: inst.emailPrincipal, copy: inst.emailPrincipal, title: "Copiar email principal" });
    }
    if (inst.emailPrincipalClave) {
      pills.push({ icon: "🔑", label: "Copiar clave Gmail", copy: inst.emailPrincipalClave, title: `Copiar clave de ${inst.emailPrincipal}` });
    }
    wrap.innerHTML = pills.map((p) => `
      <button class="path-pill" data-copy="${escapeAttr(p.copy)}" title="${escapeAttr(p.title)}">
        <span>${p.icon}</span> ${escapeHtml(p.label)}
      </button>
    `).join("");

    wrap.querySelectorAll(".path-pill").forEach((pill) => {
      pill.addEventListener("click", () => copyText(pill.dataset.copy, `Copiado: ${pill.dataset.copy === inst.emailPrincipalClave ? "Clave de correo" : pill.dataset.copy}`));
    });
  }

  function stopEntregasPolling() {
    if (state.pollingTimer) {
      clearInterval(state.pollingTimer);
      state.pollingTimer = null;
    }
  }

  function startEntregasPolling() {
    stopEntregasPolling();
    state.pollingTimer = setInterval(() => {
      if (!state.user || document.hidden) return;
      refreshEntregasSilent();
    }, 20000);
  }

  async function refreshEntregasSilent(showManualToast = false) {
    if (!state.user) return;
    try {
      const res = await apiFetch("/api/entregas", { method: "GET" });
      const fresh = res.entregas || [];
      if (!isFacturista() && state.knownPendingEntregaIds) {
        const nuevos = fresh.filter((e) => e.estado === "pendiente" && !state.knownPendingEntregaIds.has(e.id));
        if (nuevos.length > 0) {
          const first = nuevos[0];
          const msg = nuevos.length === 1
            ? `🔔 Nueva entrega de ${first.created_by_name}: ${first.os_nombre} (${first.area} ${first.period})`
            : `🔔 Llegaron ${nuevos.length} nuevas entregas de facturación`;
          showToast(msg);
        }
      }
      state.entregas = fresh;
      state.knownPendingEntregaIds = new Set(
        state.entregas.filter((e) => e.estado === "pendiente").map((e) => e.id)
      );
      updateNavBadges();
      if (state.activeView === "tareas") renderTareasView();
      if (state.activeView === "entregar") renderEntregarView();
      if (showManualToast) showToast("Bandeja actualizada");
    } catch (_) {
      // Silencioso en polling de fondo
    }
  }

  function populateDatalists() {
    const dlFin = document.getElementById("dl-financiadoras");
    if (dlFin) {
      dlFin.innerHTML = getSortedFinanciadoras()
        .map((f) => `<option value="${escapeAttr(f.nombre)}">${f.codigo ? `Cód. ${escapeHtml(f.codigo)}` : ""}</option>`)
        .join("");
    }
    const dlPostal = document.getElementById("dl-postal-obras");
    if (dlPostal) {
      const names = new Set([
        ...state.financiadoras.map((f) => f.nombre),
        ...EXTRA_POSTAL_OBRAS,
        ...state.postal.map((p) => p.obra_social)
      ]);
      dlPostal.innerHTML = [...names]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "es"))
        .map((n) => `<option value="${escapeAttr(n)}"></option>`)
        .join("");
    }
  }

  function applyRoleUI() {
    const admin = isAdmin();
    const canEdit = canEditFinanciadoras();
    const fact = isFacturista();
    document.querySelectorAll(".admin-only").forEach((el) => {
      el.classList.toggle("hidden", !admin);
    });
    document.querySelectorAll(".fin-editor-only").forEach((el) => {
      el.classList.toggle("hidden", !canEdit);
    });
    document.querySelectorAll(".export-only").forEach((el) => {
      el.classList.toggle("hidden", fact);
    });
    document.querySelectorAll(".facturista-only").forEach((el) => {
      el.classList.toggle("hidden", !fact);
    });

    if (state.user) {
      document.getElementById("current-user-name").textContent = state.user.full_name || state.user.username;
      const roleEl = document.getElementById("current-user-role");
      if (admin) {
        roleEl.textContent = "Admin";
        roleEl.className = "badge badge-teal";
      } else if (state.user.role === "exportacion") {
        roleEl.textContent = "Exportaciones";
        roleEl.className = "badge badge-emerald";
      } else if (fact) {
        roleEl.textContent = "Facturista";
        roleEl.className = "badge badge-amber";
      } else {
        roleEl.textContent = "Consulta";
        roleEl.className = "badge badge-blue";
      }

      const banner = document.getElementById("pwd-change-banner");
      banner.classList.toggle("hidden", !state.user.must_change_password);
    }
  }

  function showAuthGate() {
    stopEntregasPolling();
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("auth-gate").classList.remove("hidden");
    document.getElementById("login-password").value = "";
    const uInp = document.getElementById("login-username");
    if (uInp) uInp.focus();
  }

  function showAppShell() {
    document.getElementById("auth-gate").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");
    hideAuthError();
  }

  function showAuthError(msg) {
    const box = document.getElementById("auth-error");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function hideAuthError() {
    document.getElementById("auth-error").classList.add("hidden");
  }

  function handleSessionExpired() {
    stopEntregasPolling();
    state.user = null;
    state.financiadoras = [];
    state.entregas = [];
    showAuthGate();
    showAuthError("Tu sesión expiró. Volvé a iniciar sesión.");
  }

  function bindAuthEvents() {
    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      hideAuthError();
      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;
      const btn = document.getElementById("login-submit-btn");
      btn.disabled = true;
      btn.textContent = "Verificando...";
      try {
        await apiFetch("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
        const boot = await fetchBootstrapForCompany(state.activeCompanyId);
        applyBootstrapData(boot);
        showAppShell();
        showToast(`Bienvenido/a, ${state.user.full_name} (${state.company.sigla})`);
      } catch (err) {
        showAuthError(err.message || "Error al iniciar sesión");
      } finally {
        btn.disabled = false;
        btn.textContent = "Iniciar Sesión";
      }
    });

    document.getElementById("login-pwd-toggle").addEventListener("click", () => {
      const inp = document.getElementById("login-password");
      const btn = document.getElementById("login-pwd-toggle");
      const isPwd = inp.type === "password";
      inp.type = isPwd ? "text" : "password";
      btn.textContent = isPwd ? "🙈" : "👁️";
    });

    document.getElementById("btn-logout").addEventListener("click", async () => {
      stopEntregasPolling();
      try { await apiFetch("/api/logout", { method: "POST" }); } catch (_) {}
      state.user = null;
      state.financiadoras = [];
      state.envios = [];
      state.postal = [];
      state.entregas = [];
      showAuthGate();
      showToast("Sesión cerrada correctamente");
    });

    const openPwdModal = () => {
      document.getElementById("form-my-password").reset();
      openModal("modal-my-password");
    };
    document.getElementById("btn-my-password").addEventListener("click", openPwdModal);
    document.getElementById("btn-banner-change-pwd").addEventListener("click", openPwdModal);

    document.getElementById("form-my-password").addEventListener("submit", async (e) => {
      e.preventDefault();
      const current_password = document.getElementById("mp-current").value;
      const new_password = document.getElementById("mp-new").value;
      const confirm_password = document.getElementById("mp-confirm").value;
      if (new_password !== confirm_password) {
        showToast("Las contraseñas nuevas no coinciden");
        return;
      }
      try {
        await apiFetch("/api/me/password", {
          method: "POST",
          body: JSON.stringify({ current_password, new_password })
        });
        state.user.must_change_password = false;
        applyRoleUI();
        closeModal("modal-my-password");
        showToast("Contraseña actualizada correctamente");
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) btn.textContent = state.theme === "dark" ? "☀️" : "🌙";
  }

  // ===================== GLOBAL EVENTS =====================
  function bindGlobalEvents() {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.view === "financiadoras") state.selectedId = null;
        switchView(btn.dataset.view);
        closeMobileSidebar();
      });
    });

    document.getElementById("menu-toggle").addEventListener("click", () => {
      document.getElementById("sidebar").classList.add("open");
      document.getElementById("sidebar-overlay").classList.add("open");
    });
    document.getElementById("sidebar-close").addEventListener("click", closeMobileSidebar);
    document.getElementById("sidebar-overlay").addEventListener("click", closeMobileSidebar);

    document.getElementById("btn-theme-toggle").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      localStorage.setItem(PREFS_KEYS.THEME, state.theme);
      applyTheme();
    });

    const searchInput = document.getElementById("global-search");
    const searchClear = document.getElementById("global-search-clear");
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      searchClear.classList.toggle("hidden", !state.searchQuery);
      if (state.activeView !== "financiadoras") switchView("financiadoras");
      if (state.selectedId) state.selectedId = null;
      renderFinanciadorasView();
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !isFacturista()) {
        e.preventDefault();
        askPortalAI(searchInput.value.trim());
      }
    });

    searchClear.addEventListener("click", () => {
      state.searchQuery = "";
      searchInput.value = "";
      searchClear.classList.add("hidden");
      closeAiPopover();
      renderFinanciadorasView();
      searchInput.focus();
    });

    // Asistente IA exclusivo del portal
    document.getElementById("btn-ai-ask").addEventListener("click", () => {
      if (isFacturista()) return;
      const q = searchInput.value.trim();
      if (q) {
        askPortalAI(q);
      } else {
        openAiPopover();
      }
    });
    document.getElementById("btn-close-ai-popover").addEventListener("click", closeAiPopover);
    document.getElementById("btn-open-ai-config").addEventListener("click", () => {
      if (isAdmin()) openAiConfigModal();
    });
    document.getElementById("form-ai-config").addEventListener("submit", handleSaveAiConfig);
    document.getElementById("btn-clear-ai-key").addEventListener("click", clearAiGeminiKey);
    document.addEventListener("click", (e) => {
      const box = document.getElementById("global-search-box");
      const pop = document.getElementById("ai-popover");
      if (pop && !pop.classList.contains("hidden") && box && !box.contains(e.target)) {
        closeAiPopover();
      }
    });

    document.getElementById("sidebar-filter-input").addEventListener("input", (e) => {
      state.sidebarSearch = e.target.value;
      renderSidebarList();
    });

    document.querySelectorAll("#category-filters .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#category-filters .chip").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        state.categoryFilter = btn.dataset.cat;
        renderFinanciadorasGrid();
      });
    });

    document.querySelectorAll("#channel-filters .chip-sm").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ch = btn.dataset.channel;
        if (state.channelFilter === ch) {
          state.channelFilter = null;
          btn.classList.remove("active");
        } else {
          document.querySelectorAll("#channel-filters .chip-sm").forEach((c) => c.classList.remove("active"));
          state.channelFilter = ch;
          btn.classList.add("active");
        }
        renderFinanciadorasGrid();
      });
    });

    document.getElementById("email-separator-select").addEventListener("change", (e) => {
      state.emailSeparator = e.target.value;
      localStorage.setItem(PREFS_KEYS.EMAIL_SEP, state.emailSeparator);
      showToast(`Separador de emails cambiado a "${state.emailSeparator.trim()}"`);
    });

    document.querySelectorAll(".path-pill").forEach((pill) => {
      pill.addEventListener("click", () => copyText(pill.dataset.copy, `Copiado: ${pill.dataset.copy}`));
    });

    // Financiadora Modal
    document.getElementById("btn-new-financiadora").addEventListener("click", () => {
      if (canEditFinanciadoras()) openFinModal(null);
    });
    document.getElementById("btn-add-portal").addEventListener("click", () => addPortalRow());
    document.getElementById("btn-add-cred").addEventListener("click", () => addCredRow());
    document.getElementById("btn-add-email").addEventListener("click", () => addEmailRow());
    document.getElementById("f-image-upload").addEventListener("change", handleFormImageUpload);
    document.getElementById("form-financiadora").addEventListener("submit", handleSaveFinanciadora);

    // Control Mensual (Envíos de facturación)
    document.getElementById("tracker-period").addEventListener("change", (e) => {
      state.trackerPeriod = e.target.value || getCurrentYYYYMM();
      renderSeguimientoView();
      renderSidebarList();
      updateNavBadges();
    });
    document.getElementById("btn-new-envio").addEventListener("click", () => openEnvioModal(null));
    document.getElementById("btn-import-envios-excel").addEventListener("click", () => openImportExcelModal("envios"));
    document.getElementById("btn-export-tracker-csv").addEventListener("click", exportEnviosCsv);
    document.getElementById("form-envio").addEventListener("submit", handleSaveEnvio);
    document.getElementById("btn-delete-envio").addEventListener("click", handleDeleteEnvioFromModal);

    // Autocompletar código y grupo al elegir financiadora en modal de envío
    document.getElementById("ev-nombre").addEventListener("input", (e) => {
      const val = normalizeStr(e.target.value);
      const match = state.financiadoras.find((f) => normalizeStr(f.nombre) === val);
      if (match) {
        document.getElementById("ev-fin-id").value = match.id;
        if (match.codigo) document.getElementById("ev-cod").value = match.codigo;
        document.getElementById("ev-grupo").value = match.categoria === "art" ? "art" : "directas";
      } else {
        document.getElementById("ev-fin-id").value = "";
      }
    });

    // Envíos Andreani (Correo Postal)
    document.getElementById("postal-period-filter").addEventListener("change", (e) => {
      state.postalPeriod = e.target.value;
      renderPostalView();
    });
    document.getElementById("btn-new-postal").addEventListener("click", () => openPostalModal(null));
    document.getElementById("btn-import-postal-excel").addEventListener("click", () => openImportExcelModal("postal"));
    document.getElementById("btn-export-postal-csv").addEventListener("click", exportPostalCsv);

    // Importador Excel (.xls / .xlsx)
    const excelInput = document.getElementById("excel-file-input");
    const excelDrop = document.getElementById("excel-dropzone");
    excelInput.addEventListener("change", (e) => handleExcelFilesSelected(e.target.files));
    excelDrop.addEventListener("dragover", (e) => { e.preventDefault(); excelDrop.classList.add("dragover"); });
    excelDrop.addEventListener("dragleave", () => excelDrop.classList.remove("dragover"));
    excelDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      excelDrop.classList.remove("dragover");
      handleExcelFilesSelected(e.dataTransfer.files);
    });
    document.getElementById("btn-confirm-import-excel").addEventListener("click", confirmImportExcel);
    document.getElementById("form-postal").addEventListener("submit", handleSavePostal);
    document.getElementById("btn-delete-postal").addEventListener("click", handleDeletePostalFromModal);
    document.getElementById("pos-fecha").addEventListener("change", (e) => {
      if (e.target.value && !document.getElementById("pos-id").value) {
        document.getElementById("pos-period").value = e.target.value.slice(0, 7);
      }
    });

    // Admin Users
    document.getElementById("btn-new-user").addEventListener("click", () => openUserModal(null));
    document.getElementById("form-user").addEventListener("submit", handleSaveUser);
    document.getElementById("u-role").addEventListener("change", () => syncUserCompaniesUI());

    // Bandeja de Tareas y Entregas de Facturistas
    document.getElementById("btn-banner-go-tareas").addEventListener("click", () => switchView("tareas"));
    document.getElementById("btn-refresh-tareas").addEventListener("click", () => refreshEntregasSilent(true));
    document.getElementById("btn-refresh-mis-entregas").addEventListener("click", () => refreshEntregasSilent(true));
    document.getElementById("btn-new-entrega-manual").addEventListener("click", openNewEntregaModal);
    document.getElementById("form-nueva-entrega-modal").addEventListener("submit", handleNewEntregaModalSubmit);
    document.getElementById("form-completar-entrega").addEventListener("submit", handleCompletarEntregaSubmit);
    document.getElementById("form-observar-entrega").addEventListener("submit", handleObservarEntregaSubmit);

    // Lector PDF Geclisa en modales de Envío y Entrega Manual
    bindPdfDropzone("ev-pdf-input", "ev-pdf-drop", (file) => handleEnvioModalPdf(file));
    bindPdfDropzone("ne-pdf-input", "ne-pdf-drop", (file) => handleNewEntregaModalPdf(file));

    // Backup Modal
    document.getElementById("btn-open-backup").addEventListener("click", () => {
      closeMobileSidebar();
      if (isAdmin()) openModal("modal-backup");
    });
    document.getElementById("btn-export-json").addEventListener("click", exportBackupJson);
    document.getElementById("input-import-json").addEventListener("change", importBackupJson);

    // Modals & Lightbox
    document.querySelectorAll(".modal-close").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.classList.add("hidden");
      });
    });

    document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
    document.getElementById("lightbox-prev").addEventListener("click", () => navLightbox(-1));
    document.getElementById("lightbox-next").addEventListener("click", () => navLightbox(1));
    document.getElementById("lightbox").addEventListener("click", (e) => {
      if (e.target.id === "lightbox") closeLightbox();
    });

    document.addEventListener("keydown", (e) => {
      if (!state.user) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !isFacturista()) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      if (e.key === "Escape") {
        closeLightbox();
        closeAiPopover();
        document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
      }
      if (!document.getElementById("lightbox").classList.contains("hidden")) {
        if (e.key === "ArrowLeft") navLightbox(-1);
        if (e.key === "ArrowRight") navLightbox(1);
      }
    });
  }

  function closeMobileSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebar-overlay").classList.remove("open");
  }

  function switchView(viewName) {
    if (isFacturista()) {
      viewName = "entregar";
    } else {
      if (viewName === "entregar") viewName = "tareas";
      if (viewName === "usuarios" && !isAdmin()) return;
    }
    state.activeView = viewName;
    if (viewName !== "financiadoras") state.selectedId = null;

    document.querySelectorAll(".nav-item").forEach((n) => {
      n.classList.toggle("active", n.dataset.view === viewName);
    });
    document.querySelectorAll(".view").forEach((v) => {
      v.classList.toggle("active", v.id === `view-${viewName}`);
    });

    if (viewName === "tareas") renderTareasView();
    if (viewName === "entregar") renderEntregarView();
    if (viewName === "financiadoras") renderFinanciadorasView();
    if (viewName === "guia") renderGuiaView();
    if (viewName === "seguimiento") renderSeguimientoView();
    if (viewName === "postal") renderPostalView();
    if (viewName === "herramientas") renderHerramientasView();
    if (viewName === "usuarios") loadAndRenderUsuariosView();
    updateNavBadges();
    if (!isFacturista()) renderSidebarList();
  }

  // ===================== RENDER ALL =====================
  function renderAll() {
    updateNavBadges();
    if (isFacturista()) {
      renderEntregarView();
      return;
    }
    renderSidebarList();
    renderTareasView();
    renderFinanciadorasView();
    renderGuiaView();
    renderSeguimientoView();
    renderPostalView();
    renderHerramientasView();
  }

  function getSortedFinanciadoras() {
    return [...state.financiadoras].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })
    );
  }

  function getPeriodEnvios(period = state.trackerPeriod) {
    return state.envios.filter((e) => e.period === period);
  }

  function getFinPeriodEnvios(fin, period = state.trackerPeriod) {
    const fn = normalizeStr(fin.nombre);
    return state.envios.filter((e) => {
      if (e.period !== period) return false;
      if (e.financiadora_id && e.financiadora_id === fin.id) return true;
      return normalizeStr(e.os_nombre) === fn;
    });
  }

  function getFinMonthlyCompletion(fin) {
    const envs = getFinPeriodEnvios(fin);
    if (envs.length === 0) return "pending";
    const hasAmb = envs.some((e) => e.area === "ambulatorio");
    const hasInt = envs.some((e) => e.area === "internado");
    return (hasAmb && hasInt) ? "done" : "partial";
  }

  function updateNavBadges() {
    const pendCount = state.entregas.filter((e) => e.estado === "pendiente").length;
    const activeCount = state.entregas.filter((e) => e.estado === "pendiente" || e.estado === "en_proceso").length;

    const tareasBadge = document.getElementById("nav-tareas-badge");
    if (tareasBadge) {
      tareasBadge.textContent = activeCount;
      tareasBadge.style.background = pendCount > 0 ? "rgba(245, 158, 11, 0.3)" : "";
      tareasBadge.style.color = pendCount > 0 ? "#fcd34d" : "";
      tareasBadge.classList.toggle("badge-pulse", pendCount > 0);
    }

    const entregarBadge = document.getElementById("nav-entregar-badge");
    if (entregarBadge) {
      const myObs = state.entregas.filter((e) => e.estado === "observado").length;
      entregarBadge.textContent = myObs > 0 ? `${myObs} obs.` : state.entregas.length;
      entregarBadge.style.background = myObs > 0 ? "rgba(239, 68, 68, 0.3)" : "";
      entregarBadge.style.color = myObs > 0 ? "#fca5a5" : "";
    }

    // Banner alerta en vivo cuando hay tareas pendientes y estamos en otra pestaña
    const liveBanner = document.getElementById("tareas-live-banner");
    const liveBannerTxt = document.getElementById("tareas-live-banner-text");
    if (liveBanner && liveBannerTxt) {
      const showBanner = !isFacturista() && pendCount > 0 && state.activeView !== "tareas";
      liveBanner.classList.toggle("hidden", !showBanner);
      if (showBanner) {
        const latest = state.entregas.find((e) => e.estado === "pendiente");
        liveBannerTxt.innerHTML = `<strong>🔔 Tenés ${pendCount} entrega${pendCount > 1 ? "s" : ""} pendiente${pendCount > 1 ? "s" : ""} de envío (${escapeHtml((state.company && state.company.sigla) || "")})</strong>` +
          (latest ? ` · Última: <strong>${escapeHtml(latest.os_nombre)}</strong> (${latest.area === "ambulatorio" ? "Ambulatorio" : "Internado"} ${escapeHtml(latest.period)}) enviada por ${escapeHtml(latest.created_by_name)}` : "");
      }
    }

    const finCnt = document.getElementById("nav-count-fin");
    if (finCnt) finCnt.textContent = state.financiadoras.length;
    const periodEnvs = getPeriodEnvios();
    const progBadge = document.getElementById("nav-progress-badge");
    if (progBadge) progBadge.textContent = periodEnvs.length;

    const inTransit = state.postal.filter((p) => !p.fecha_entrega).length;
    const postalBadge = document.getElementById("nav-postal-badge");
    if (postalBadge) {
      postalBadge.textContent = inTransit > 0 ? `${inTransit} pend.` : state.postal.length;
      postalBadge.style.background = inTransit > 0 ? "rgba(245, 158, 11, 0.25)" : "";
      postalBadge.style.color = inTransit > 0 ? "#fcd34d" : "";
    }
  }

  // ===================== CHECKBOXES LOCALES POR TAREA =====================
  function loadTaskDocChecks() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEYS.TASK_CHECKS) || "{}"); }
    catch (_) { return {}; }
  }

  function toggleTaskDocCheck(taskId, idx, checked) {
    const all = loadTaskDocChecks();
    const key = String(taskId);
    all[key] = all[key] || {};
    all[key][String(idx)] = Boolean(checked);
    localStorage.setItem(PREFS_KEYS.TASK_CHECKS, JSON.stringify(all));
  }

  function findFinanciadoraForEntrega(ent) {
    if (ent.financiadora_id) {
      const byId = state.financiadoras.find((f) => f.id === ent.financiadora_id);
      if (byId) return byId;
    }
    const target = normalizeStr(ent.os_nombre);
    return state.financiadoras.find((f) => normalizeStr(f.nombre) === target) || null;
  }

  // ===================== LECTOR PDF DE GECLISA =====================
  function parseFacturasJson(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function renderFacturasMiniTableHtml(facturas) {
    if (!facturas || facturas.length === 0) return "";
    const sumNeto = facturas.reduce((a, f) => a + Number(f.neto || 0), 0);
    const sumIva = facturas.reduce((a, f) => a + Number(f.iva || 0), 0);
    const sumTot = facturas.reduce((a, f) => a + Number(f.total || 0), 0);
    return `
      <div class="pdf-mini-table-wrap">
        <table class="pdf-mini-table">
          <thead>
            <tr>
              <th>N° Pr.</th>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th>IVA/Ex.</th>
              <th class="num">Neto</th>
              <th class="num">IVA</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            ${facturas.map((f) => `
              <tr>
                <td>${escapeHtml(f.presentacion || "—")}</td>
                <td>${formatDateAR(f.fecha)}</td>
                <td><strong>${escapeHtml(f.tipo_comp || "")}</strong> ${escapeHtml(f.numero || "")}</td>
                <td><span class="badge ${Number(f.iva || 0) > 0 ? "badge-blue" : "badge-neutral"}">${escapeHtml(f.condicion || (Number(f.iva || 0) > 0 ? "Gravado" : "Exento"))}</span></td>
                <td class="num">${formatMoney(f.neto)}</td>
                <td class="num">${formatMoney(f.iva)}</td>
                <td class="num"><strong>${formatMoney(f.total)}</strong></td>
              </tr>
            `).join("")}
            <tr style="background:var(--bg-subtle);font-weight:800;">
              <td colspan="4">TOTAL (${facturas.length} comprobante${facturas.length !== 1 ? "s" : ""})</td>
              <td class="num">${formatMoney(sumNeto)}</td>
              <td class="num">${formatMoney(sumIva)}</td>
              <td class="num">${formatMoney(sumTot)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  function bindPdfDropzone(inputId, dropId, onFile) {
    const inp = document.getElementById(inputId);
    const drop = document.getElementById(dropId);
    if (!inp || !drop) return;
    inp.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) onFile(file);
      e.target.value = "";
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  async function uploadAndParseGeclisaPdf(file, previewEl, onParsed) {
    if (!file || !/\.pdf$/i.test(file.name)) {
      showToast("Seleccioná un archivo con extensión .pdf exportado desde Geclisa");
      return;
    }
    if (previewEl) {
      previewEl.classList.remove("hidden");
      previewEl.innerHTML = `<div class="pdf-preview-box">⏳ Leyendo PDF <strong>${escapeHtml(file.name)}</strong>...</div>`;
    }
    try {
      const b64 = await readFileAsDataUrl(file);
      const res = await apiFetch("/api/parse-geclisa-pdf", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, content_base64: b64, save_file: true })
      });
      const parsed = res.parsed;
      onParsed(parsed);
      showToast(`📄 PDF leído: ${parsed.os_nombre || file.name} (${parsed.cant_facturas} comp. · ${formatMoney(parsed.total_general)})`);
    } catch (err) {
      if (previewEl) {
        previewEl.innerHTML = `<div class="auth-alert" style="margin:6px 0 0;">${escapeHtml(err.message)}</div>`;
      }
      showToast(err.message);
    }
  }

  function renderPdfPreviewBox(parsed, previewEl, onClear) {
    if (!previewEl) return;
    if (!parsed) {
      previewEl.innerHTML = "";
      previewEl.classList.add("hidden");
      return;
    }
    const facts = parsed.facturas || [];
    const ivaInfo = (parsed.cant_exento || parsed.cant_gravado)
      ? ` (${parsed.cant_exento || 0} Exento · ${parsed.cant_gravado || 0} Gravado)`
      : "";
    previewEl.classList.remove("hidden");
    previewEl.innerHTML = `
      <div class="pdf-preview-box">
        <div class="pdf-preview-head">
          <div>
            <strong>✅ PDF Geclisa:</strong> ${escapeHtml(parsed.pdf_filename || parsed.filename || "reporte.pdf")}
            · <span class="badge badge-teal">${facts.length} comp.${ivaInfo}</span>
            ${parsed.total_general > 0 ? `<strong style="margin-left:6px;font-family:var(--font-mono);color:var(--accent-text);">${formatMoney(parsed.total_general)}</strong>` : ""}
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${parsed.pdf_url ? `<a href="${escapeAttr(parsed.pdf_url)}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary">📄 Ver PDF</a>` : ""}
            ${onClear ? `<button type="button" class="btn-icon-sm pdf-clear-btn" title="Quitar PDF">✕</button>` : ""}
          </div>
        </div>
        ${parsed.company_mismatch ? `
          <div class="pdf-mismatch-alert">
            ⚠️ Atención: el encabezado del PDF indica «${escapeHtml(parsed.empresa_raw)}» (${escapeHtml((parsed.empresa_detectada || "").toUpperCase())}), pero estás trabajando en <strong>${escapeHtml((state.company && state.company.sigla) || "")}</strong>. Verificá la empresa activa antes de guardar.
          </div>
        ` : ""}
        ${renderFacturasMiniTableHtml(facts)}
      </div>
    `;
    if (onClear) {
      const clr = previewEl.querySelector(".pdf-clear-btn");
      if (clr) clr.addEventListener("click", onClear);
    }
  }

  async function handleNewEntregaModalPdf(file) {
    const previewEl = document.getElementById("ne-pdf-preview");
    await uploadAndParseGeclisaPdf(file, previewEl, (parsed) => {
      state.modalEntregaPdf = parsed;
      if (parsed.os_nombre) document.getElementById("ne-fin").value = parsed.os_nombre;
      if (parsed.area) document.getElementById("ne-area").value = parsed.area;
      if (parsed.period) document.getElementById("ne-period").value = parsed.period;
      if (parsed.condicion_iva) document.getElementById("ne-condicion").value = parsed.condicion_iva;
      if (parsed.total_general > 0) document.getElementById("ne-importe").value = String(parsed.total_general).replace(".", ",");
      if (parsed.resumen_facturas) document.getElementById("ne-obs").value = parsed.resumen_facturas;
      renderPdfPreviewBox(parsed, previewEl, () => {
        state.modalEntregaPdf = null;
        renderPdfPreviewBox(null, previewEl);
      });
    });
  }

  async function handleEnvioModalPdf(file) {
    const previewEl = document.getElementById("ev-pdf-preview");
    await uploadAndParseGeclisaPdf(file, previewEl, (parsed) => {
      state.modalEnvioPdf = parsed;
      if (parsed.period) document.getElementById("ev-period").value = parsed.period;
      if (parsed.grupo) document.getElementById("ev-grupo").value = parsed.grupo;
      if (parsed.os_nombre) document.getElementById("ev-nombre").value = parsed.os_nombre;
      if (parsed.financiadora_id) document.getElementById("ev-fin-id").value = parsed.financiadora_id;
      if (parsed.os_cod) document.getElementById("ev-cod").value = parsed.os_cod;
      if (parsed.area) document.getElementById("ev-area").value = parsed.area;
      if (parsed.condicion_iva) document.getElementById("ev-etiqueta").value = parsed.condicion_iva;
      if (parsed.total_general > 0) document.getElementById("ev-importe").value = String(parsed.total_general).replace(".", ",");
      if (parsed.resumen_facturas) document.getElementById("ev-obs").value = parsed.resumen_facturas;
      renderPdfPreviewBox(parsed, previewEl, () => {
        state.modalEnvioPdf = null;
        renderPdfPreviewBox(null, previewEl);
      });
    });
  }

  // ===================== ASISTENTE IA EXCLUSIVO DEL PORTAL =====================
  const DEFAULT_AI_SUGGESTIONS = [
    "¿Qué obras sociales tienen vencimiento?",
    "¿Cuál fue el total enviado del último período?",
    "¿Qué tareas pendientes hay en la bandeja?",
    "¿Qué envíos de Andreani están en tránsito?"
  ];

  function openAiPopover() {
    const pop = document.getElementById("ai-popover");
    if (!pop || isFacturista()) return;
    pop.classList.remove("hidden");
    renderAiSuggestions(DEFAULT_AI_SUGGESTIONS);
  }

  function closeAiPopover() {
    const pop = document.getElementById("ai-popover");
    if (pop) pop.classList.add("hidden");
  }

  function formatAiMarkdown(text) {
    let safe = escapeHtml(text || "");
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    return safe;
  }

  function renderAiSuggestions(list) {
    const wrap = document.getElementById("ai-suggestions");
    if (!wrap) return;
    const items = (list && list.length > 0) ? list : DEFAULT_AI_SUGGESTIONS;
    wrap.innerHTML = items.map((s) => `
      <button type="button" class="chip-sm ai-sugg-btn" data-q="${escapeAttr(s)}">✨ ${escapeHtml(s)}</button>
    `).join("");
    wrap.querySelectorAll(".ai-sugg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById("global-search");
        if (inp) inp.value = btn.dataset.q;
        askPortalAI(btn.dataset.q);
      });
    });
  }

  async function askPortalAI(question) {
    if (isFacturista()) return;
    openAiPopover();
    const bodyEl = document.getElementById("ai-popover-body");
    const engBadge = document.getElementById("ai-engine-badge");
    if (!question) {
      bodyEl.innerHTML = `<div class="ai-welcome"><p>Escribí una pregunta arriba y presioná <strong>Enter</strong> o elegí una consulta rápida abajo. Solo respondo cuestiones de este portal (<strong>${escapeHtml((state.company && state.company.sigla) || "")}</strong>).</p></div>`;
      return;
    }

    bodyEl.innerHTML = `<div style="color:var(--text-muted);padding:8px 0;">✨ Analizando datos de <strong>${escapeHtml((state.company && state.company.sigla) || "")}</strong>...</div>`;
    try {
      const res = await apiFetch("/api/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question })
      });
      if (engBadge) {
        engBadge.textContent = res.engine === "gemini" ? "✨ Gemini + Portal" : res.engine === "guardrail" ? "🔒 Solo Portal" : "⚡ IA Local";
        engBadge.className = `badge ${res.engine === "gemini" ? "badge-purple" : res.engine === "guardrail" ? "badge-amber" : "badge-blue"}`;
      }
      const acts = res.actions || [];
      bodyEl.innerHTML = `
        <div class="ai-answer-box ${res.in_scope === false ? "out-of-scope" : ""}">${formatAiMarkdown(res.answer)}</div>
        ${acts.length > 0 ? `
          <div class="ai-actions-row">
            ${acts.map((a, idx) => `
              <button type="button" class="btn btn-xs btn-secondary ai-act-btn" data-idx="${idx}">${escapeHtml(a.label)}</button>
            `).join("")}
          </div>
        ` : ""}
      `;
      bodyEl.querySelectorAll(".ai-act-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = acts[Number(btn.dataset.idx)];
          if (!act) return;
          if (act.type === "open_fin" && act.id) {
            closeAiPopover();
            openFinDetail(act.id);
          } else if (act.type === "copy" && act.value) {
            copyText(act.value, "Copiado desde el Asistente IA");
          } else if (act.type === "open_url" && act.url) {
            window.open(act.url, "_blank", "noopener");
          } else if (act.type === "switch_view" && act.view) {
            if (act.period) {
              state.trackerPeriod = act.period;
              const pInp = document.getElementById("tracker-period");
              if (pInp) pInp.value = act.period;
            }
            closeAiPopover();
            switchView(act.view);
          }
        });
      });
      if (res.suggestions && res.suggestions.length > 0) {
        renderAiSuggestions(res.suggestions);
      }
    } catch (err) {
      bodyEl.innerHTML = `<div class="auth-alert">${escapeHtml(err.message)}</div>`;
    }
  }

  async function openAiConfigModal() {
    document.getElementById("ai-gemini-key").value = "";
    const statusEl = document.getElementById("ai-config-status");
    const clrBtn = document.getElementById("btn-clear-ai-key");
    statusEl.innerHTML = "Consultando estado...";
    clrBtn.classList.add("hidden");
    openModal("modal-ai-config");
    try {
      const res = await apiFetch("/api/ai/config", { method: "GET" });
      if (res.has_gemini_key) {
        statusEl.innerHTML = `<span class="badge badge-emerald">✨ Gemini API conectada</span> ${res.from_env ? "(desde variable de entorno GEMINI_API_KEY)" : "(clave guardada en servidor)"}`;
        if (!res.from_env) clrBtn.classList.remove("hidden");
      } else {
        statusEl.innerHTML = `<span class="badge badge-blue">⚡ Modo 100% Local activo</span> (sin clave externa configurada)`;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--danger);">${escapeHtml(err.message)}</span>`;
    }
  }

  async function handleSaveAiConfig(e) {
    e.preventDefault();
    const key = document.getElementById("ai-gemini-key").value.trim();
    try {
      const res = await apiFetch("/api/ai/config", {
        method: "POST",
        body: JSON.stringify({ gemini_api_key: key })
      });
      closeModal("modal-ai-config");
      showToast(res.has_gemini_key ? "✨ Gemini API activada para el asistente del portal" : "Asistente configurado en modo 100% local");
    } catch (err) {
      showToast(err.message);
    }
  }

  async function clearAiGeminiKey() {
    try {
      await apiFetch("/api/ai/config", { method: "POST", body: JSON.stringify({ gemini_api_key: "" }) });
      closeModal("modal-ai-config");
      showToast("Clave Gemini eliminada · Asistente en modo 100% local");
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===================== VIEW 0A: BANDEJA DE TAREAS (EXPORTACION) =====================
  function renderTareasView() {
    const container = document.getElementById("tareas-content");
    if (!container || isFacturista()) return;

    const all = state.entregas || [];
    const cntPend = all.filter((e) => e.estado === "pendiente").length;
    const cntProc = all.filter((e) => e.estado === "en_proceso").length;
    const cntObs = all.filter((e) => e.estado === "observado").length;
    const cntEnv = all.filter((e) => e.estado === "enviado").length;

    const q = normalizeStr(state.tareasSearch);
    const filtered = all.filter((e) => {
      if (state.tareasFilter === "activas" && e.estado !== "pendiente" && e.estado !== "en_proceso") return false;
      if (["pendiente", "en_proceso", "observado", "enviado"].includes(state.tareasFilter) && e.estado !== state.tareasFilter) return false;
      if (q) {
        const hay = normalizeStr(`${e.os_cod} ${e.os_nombre} ${e.area} ${e.period} ${e.condicion} ${e.tipo} ${e.observacion} ${e.created_by_name} ${e.respuesta_exportacion}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const checksMap = loadTaskDocChecks();

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card" style="cursor:pointer;" data-tjump="pendiente">
          <div class="kpi-icon" style="background:var(--amber-bg);color:var(--amber-text);">🟡</div>
          <div>
            <div class="kpi-value">${cntPend}</div>
            <div class="kpi-label">Pendientes de envío</div>
          </div>
        </div>
        <div class="kpi-card" style="cursor:pointer;" data-tjump="en_proceso">
          <div class="kpi-icon" style="background:var(--blue-bg);color:var(--blue-text);">🔵</div>
          <div>
            <div class="kpi-value">${cntProc}</div>
            <div class="kpi-label">En proceso</div>
          </div>
        </div>
        <div class="kpi-card" style="cursor:pointer;" data-tjump="observado">
          <div class="kpi-icon" style="background:var(--rose-bg);color:var(--rose-text);">⚠️</div>
          <div>
            <div class="kpi-value">${cntObs}</div>
            <div class="kpi-label">Observadas / Devueltas</div>
          </div>
        </div>
        <div class="kpi-card" style="cursor:pointer;" data-tjump="enviado">
          <div class="kpi-icon" style="background:var(--emerald-bg);color:var(--emerald-text);">✅</div>
          <div>
            <div class="kpi-value">${cntEnv}</div>
            <div class="kpi-label">Enviadas y registradas</div>
          </div>
        </div>
      </div>

      <div class="subtabs-bar">
        <div class="filter-group">
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "activas" ? "active" : ""}" data-tf="activas">📥 Activas (${cntPend + cntProc})</button>
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "pendiente" ? "active" : ""}" data-tf="pendiente">🟡 Pendientes (${cntPend})</button>
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "en_proceso" ? "active" : ""}" data-tf="en_proceso">🔵 En proceso (${cntProc})</button>
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "observado" ? "active" : ""}" data-tf="observado">⚠️ Observadas (${cntObs})</button>
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "enviado" ? "active" : ""}" data-tf="enviado">✅ Enviadas (${cntEnv})</button>
          <button class="chip-sm tarea-f-btn ${state.tareasFilter === "all" ? "active" : ""}" data-tf="all">Todas (${all.length})</button>
        </div>
        <input type="text" class="inline-search-input" id="tareas-search-input" value="${escapeAttr(state.tareasSearch)}" placeholder="Filtrar por obra social, facturista, período...">
      </div>

      ${filtered.length === 0 ? `
        <div class="empty-state">
          <h3>No hay entregas en esta vista</h3>
          <p>Cuando los facturistas carguen facturaciones listas para enviar, aparecerán aquí automáticamente con su checklist de documentación.</p>
        </div>
      ` : `
        <div class="task-list-grid">
          ${filtered.map((ent) => {
            const stMeta = ENTREGA_ESTADO_META[ent.estado] || ENTREGA_ESTADO_META.pendiente;
            const tMeta = ENVIO_TIPO_META[ent.tipo] || ENVIO_TIPO_META.normal;
            const fin = findFinanciadoraForEntrega(ent);
            const docs = (fin && fin.archivos && fin.archivos.length > 0)
              ? fin.archivos
              : ["Factura PDF", "Detalle / Planilla", "Documentación respaldatoria"];
            const taskChecks = checksMap[String(ent.id)] || {};
            const modalityText = fin
              ? (ent.area === "internado" ? fin.internado : fin.ambulatorio)
              : "";
            const hasPortal = fin && (fin.portales || []).length > 0;
            const emails = (fin && fin.emails) || [];
            const creds = (fin && fin.credenciales) || [];
            const showCreds = Boolean(state.expandedCredTaskIds[ent.id]);
            const entFacturas = parseFacturasJson(ent.facturas_json);
            const showPdfTable = Boolean(state.expandedPdfTaskIds[ent.id]);

            return `
              <article class="task-card status-${escapeAttr(ent.estado)}">
                <div class="task-card-header">
                  <div>
                    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
                      <span class="badge ${stMeta.cls}">${stMeta.icon} ${stMeta.label}</span>
                      ${ent.os_cod ? `<span class="code-pill">#${escapeHtml(ent.os_cod)}</span>` : ""}
                      <h3 class="task-card-title">${escapeHtml(ent.os_nombre)}</h3>
                      <span class="badge ${ent.area === "ambulatorio" ? "badge-blue" : "badge-indigo"}">
                        ${ent.area === "ambulatorio" ? "🩺 Ambulatorio" : "🏥 Internado"}
                      </span>
                      <span class="badge badge-teal">📅 ${escapeHtml(ent.period)}</span>
                      ${ent.condicion ? `<span class="badge badge-purple">${escapeHtml(ent.condicion)}</span>` : ""}
                      ${tMeta.short ? `<span class="badge ${tMeta.cls}">${tMeta.short}</span>` : ""}
                    </div>
                    <div class="task-meta-row">
                      <span>👤 Entregado por <strong>${escapeHtml(ent.created_by_name)}</strong></span>
                      <span>·</span>
                      <span>🕒 ${escapeHtml(ent.created_at)}</span>
                      ${ent.estado === "en_proceso" && ent.processed_by ? `<span>·</span><span class="badge badge-blue">🔵 Tomada por ${escapeHtml(ent.processed_by)}</span>` : ""}
                      ${ent.importe > 0 ? `<span>·</span><span>💰 Informado: <strong>${formatMoney(ent.importe)}</strong></span>` : ""}
                      ${fin && fin.vencimiento ? `<span class="badge badge-amber">⏰ ${escapeHtml(fin.vencimiento)}</span>` : ""}
                    </div>
                  </div>
                  ${fin ? `<button type="button" class="btn btn-xs btn-secondary task-open-fin-btn" data-fid="${escapeAttr(fin.id)}">🏥 Ver ficha completa</button>` : ""}
                </div>

                ${ent.observacion ? `<div class="task-note-box"><strong>💬 Nota del facturista:</strong> ${escapeHtml(ent.observacion)}</div>` : ""}
                ${ent.respuesta_exportacion && ent.estado === "observado" ? `<div class="task-obs-box"><strong>⚠️ Devuelto al facturista:</strong> ${escapeHtml(ent.respuesta_exportacion)}</div>` : ""}

                ${(ent.pdf_url || entFacturas.length > 0) ? `
                  <div class="pdf-preview-box" style="margin-top:8px;">
                    <div class="pdf-preview-head">
                      <div>
                        <strong>📄 Reporte PDF Geclisa:</strong> ${escapeHtml(ent.pdf_filename || "Detalle de facturación")}
                        ${entFacturas.length > 0 ? `<span class="badge badge-teal" style="margin-left:5px;">${entFacturas.length} comprobante${entFacturas.length !== 1 ? "s" : ""}</span>` : ""}
                      </div>
                      <div style="display:flex;gap:6px;">
                        ${entFacturas.length > 0 ? `<button type="button" class="btn btn-xs btn-secondary task-toggle-pdf-btn" data-tid="${ent.id}">🧾 ${showPdfTable ? "Ocultar Facturas" : `Ver ${entFacturas.length} Factura${entFacturas.length !== 1 ? "s" : ""}`}</button>` : ""}
                        ${ent.pdf_url ? `<a href="${escapeAttr(ent.pdf_url)}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary">📄 Abrir PDF</a>` : ""}
                      </div>
                    </div>
                    ${showPdfTable ? renderFacturasMiniTableHtml(entFacturas) : ""}
                  </div>
                ` : ""}

                ${ent.estado !== "enviado" ? `
                  <div class="task-checklist-box">
                    <div class="task-checklist-head">
                      <span class="task-checklist-title">📋 Documentación y requisitos a enviar (${ent.area === "ambulatorio" ? "Ambulatorio" : "Internado"})</span>
                      <div style="display:flex;gap:5px;flex-wrap:wrap;">
                        ${fin ? (fin.canales || []).map((c) => {
                          const m = CHANNEL_META[c];
                          return m ? `<span class="badge ${m.cls}">${m.icon} ${m.label}</span>` : "";
                        }).join("") : ""}
                      </div>
                    </div>

                    ${modalityText ? `<div class="task-modality-highlight"><strong>Normativa ${ent.area === "ambulatorio" ? "Ambulatorio" : "Internado"}:</strong> ${escapeHtml(modalityText)}</div>` : ""}
                    ${fin && fin.asuntoRegla ? `<div style="font-size:12px;color:var(--amber-text);margin:4px 0;"><strong>📌 Asunto / Formato:</strong> ${escapeHtml(fin.asuntoRegla)}</div>` : ""}

                    <div class="task-doc-checks">
                      ${docs.map((doc, idx) => `
                        <label class="doc-check-pill">
                          <input type="checkbox" class="task-doc-cb" data-tid="${ent.id}" data-idx="${idx}" ${taskChecks[String(idx)] ? "checked" : ""}>
                          <span>${escapeHtml(doc)}</span>
                        </label>
                      `).join("")}
                    </div>

                    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
                      ${hasPortal ? `<a href="${escapeAttr(fin.portales[0].url)}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary">🌐 Abrir Portal</a>` : ""}
                      ${emails.length > 0 ? `<button type="button" class="btn btn-xs btn-secondary task-copy-emails-btn" data-fid="${escapeAttr(fin.id)}">📋 Copiar ${emails.length} Mail${emails.length > 1 ? "s" : ""}</button>` : ""}
                      ${creds.length > 0 ? `<button type="button" class="btn btn-xs btn-secondary task-toggle-creds-btn" data-tid="${ent.id}">🔑 ${showCreds ? "Ocultar Claves" : "Ver Claves aquí"}</button>` : ""}
                    </div>

                    ${showCreds && creds.length > 0 ? `
                      <div class="task-quick-creds">
                        ${creds.map((c) => `
                          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
                            <strong>${escapeHtml(c.label || "Acceso")}:</strong>
                            ${c.usuario ? `<span>Usu: <code>${escapeHtml(c.usuario)}</code> <button type="button" class="btn-icon-sm copy-inline-btn" data-val="${escapeAttr(c.usuario)}" title="Copiar usuario">📋</button></span>` : ""}
                            ${c.clave ? `<span>Clave: <code>${escapeHtml(c.clave)}</code> <button type="button" class="btn-icon-sm copy-inline-btn" data-val="${escapeAttr(c.clave)}" title="Copiar clave">📋</button></span>` : ""}
                            ${c.extra ? `<span class="badge badge-neutral">${escapeHtml(c.extra)}</span>` : ""}
                          </div>
                        `).join("")}
                      </div>
                    ` : ""}
                  </div>
                ` : `
                  <div style="font-size:12.5px;color:var(--emerald-text);margin:8px 0;">
                    ✅ Enviado por <strong>${escapeHtml(ent.processed_by || "Exportaciones")}</strong> el ${escapeHtml(ent.processed_at || ent.updated_at)}
                    ${ent.importe > 0 ? ` · Importe: <strong>${formatMoney(ent.importe)}</strong>` : ""}
                    ${ent.respuesta_exportacion ? ` · <em>${escapeHtml(ent.respuesta_exportacion)}</em>` : ""}
                  </div>
                `}

                <div class="task-card-actions">
                  <div class="btn-row">
                    ${ent.estado === "pendiente" ? `<button type="button" class="btn btn-sm btn-secondary task-take-btn" data-tid="${ent.id}">🔵 Tomar / En Proceso</button>` : ""}
                    ${ent.estado !== "enviado" ? `<button type="button" class="btn btn-sm btn-secondary task-obs-btn" data-tid="${ent.id}">⚠️ Observar / Devolver</button>` : ""}
                    ${ent.estado === "enviado" && ent.envio_id ? `<button type="button" class="btn btn-sm btn-secondary task-goto-control-btn" data-period="${escapeAttr(ent.period)}">📊 Ver en Control Mensual (${escapeHtml(ent.period)})</button>` : ""}
                    ${isAdmin() ? `<button type="button" class="btn btn-xs btn-danger-outline task-del-btn" data-tid="${ent.id}" title="Eliminar entrega">🗑️</button>` : ""}
                  </div>
                  ${ent.estado !== "enviado" ? `
                    <button type="button" class="btn btn-primary task-complete-btn" data-tid="${ent.id}">
                      ✅ Marcar Enviado y Cargar al Control Mensual
                    </button>
                  ` : `<span class="badge badge-emerald">✓ Completado</span>`}
                </div>
              </article>
            `;
          }).join("")}
        </div>
      `}
    `;

    // Bind events
    container.querySelectorAll("[data-tjump]").forEach((card) => {
      card.addEventListener("click", () => {
        state.tareasFilter = card.dataset.tjump;
        renderTareasView();
      });
    });

    container.querySelectorAll(".tarea-f-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tareasFilter = btn.dataset.tf;
        renderTareasView();
      });
    });

    const tSearch = document.getElementById("tareas-search-input");
    if (tSearch) {
      tSearch.addEventListener("input", (e) => {
        state.tareasSearch = e.target.value;
        const pos = e.target.selectionStart;
        renderTareasView();
        const nextInp = document.getElementById("tareas-search-input");
        if (nextInp) {
          nextInp.focus();
          nextInp.setSelectionRange(pos, pos);
        }
      });
    }

    container.querySelectorAll(".task-doc-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        toggleTaskDocCheck(cb.dataset.tid, cb.dataset.idx, cb.checked);
      });
    });

    container.querySelectorAll(".task-open-fin-btn").forEach((btn) => {
      btn.addEventListener("click", () => openFinDetail(btn.dataset.fid));
    });

    container.querySelectorAll(".task-copy-emails-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fin = state.financiadoras.find((f) => f.id === btn.dataset.fid);
        if (fin) copyFinEmails(fin);
      });
    });

    container.querySelectorAll(".task-toggle-creds-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tid = btn.dataset.tid;
        state.expandedCredTaskIds[tid] = !state.expandedCredTaskIds[tid];
        renderTareasView();
      });
    });

    container.querySelectorAll(".task-toggle-pdf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tid = btn.dataset.tid;
        state.expandedPdfTaskIds[tid] = !state.expandedPdfTaskIds[tid];
        renderTareasView();
      });
    });

    container.querySelectorAll(".copy-inline-btn").forEach((btn) => {
      btn.addEventListener("click", () => copyText(btn.dataset.val, "Copiado al portapapeles"));
    });

    container.querySelectorAll(".task-take-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await apiFetch(`/api/entregas/${btn.dataset.tid}`, {
            method: "PUT",
            body: JSON.stringify({ estado: "en_proceso" })
          });
          replaceEntregaInState(res.entrega);
          showToast("Tarea tomada en proceso");
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    container.querySelectorAll(".task-obs-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ent = state.entregas.find((x) => x.id === Number(btn.dataset.tid));
        if (ent) openObservarEntregaModal(ent);
      });
    });

    container.querySelectorAll(".task-complete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ent = state.entregas.find((x) => x.id === Number(btn.dataset.tid));
        if (ent) openCompletarEntregaModal(ent);
      });
    });

    container.querySelectorAll(".task-goto-control-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.trackerPeriod = btn.dataset.period;
        const periodInput = document.getElementById("tracker-period");
        if (periodInput) periodInput.value = state.trackerPeriod;
        switchView("seguimiento");
      });
    });

    container.querySelectorAll(".task-del-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Eliminar esta entrega de la bandeja?")) return;
        try {
          await apiFetch(`/api/entregas/${btn.dataset.tid}`, { method: "DELETE" });
          state.entregas = state.entregas.filter((x) => x.id !== Number(btn.dataset.tid));
          updateNavBadges();
          renderTareasView();
          showToast("Entrega eliminada");
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  }

  function replaceEntregaInState(ent) {
    if (!ent) return;
    const idx = state.entregas.findIndex((x) => x.id === ent.id);
    if (idx >= 0) state.entregas[idx] = ent;
    else state.entregas.unshift(ent);
    state.knownPendingEntregaIds = new Set(
      state.entregas.filter((e) => e.estado === "pendiente").map((e) => e.id)
    );
    updateNavBadges();
    if (state.activeView === "tareas") renderTareasView();
    if (state.activeView === "entregar") renderEntregarView();
  }

  function openCompletarEntregaModal(ent) {
    document.getElementById("ce-id").value = ent.id;
    document.getElementById("modal-comp-title").textContent = `Confirmar Envío — ${ent.os_nombre}`;
    document.getElementById("ce-summary-callout").innerHTML = `
      <strong>${escapeHtml(ent.os_nombre)}</strong> · ${ent.area === "ambulatorio" ? "Ambulatorio" : "Internado"} · Período <strong>${escapeHtml(ent.period)}</strong>
      <p style="margin:4px 0 0;">Entregado por ${escapeHtml(ent.created_by_name)} (${escapeHtml(ent.created_at)})${ent.condicion ? ` · ${escapeHtml(ent.condicion)}` : ""}</p>
    `;
    document.getElementById("ce-fecha").value = getTodayISO();
    document.getElementById("ce-importe").value = ent.importe > 0 ? String(ent.importe).replace(".", ",") : "";
    document.getElementById("ce-tipo").value = ent.tipo || "normal";
    document.getElementById("ce-etiqueta").value = ent.condicion || "";
    document.getElementById("ce-obs").value = ent.observacion || "";
    document.getElementById("ce-respuesta").value = "";
    document.getElementById("ce-add-control").checked = true;
    openModal("modal-completar-entrega");
  }

  async function handleCompletarEntregaSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("ce-id").value;
    if (!id) return;
    const payload = {
      fecha_envio: document.getElementById("ce-fecha").value,
      importe: document.getElementById("ce-importe").value.trim(),
      tipo: document.getElementById("ce-tipo").value,
      etiqueta: document.getElementById("ce-etiqueta").value.trim(),
      observacion: document.getElementById("ce-obs").value.trim(),
      respuesta_exportacion: document.getElementById("ce-respuesta").value.trim(),
      registrar_en_control: document.getElementById("ce-add-control").checked
    };
    try {
      const res = await apiFetch(`/api/entregas/${id}/completar`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      if (res.envio) {
        state.envios.unshift(res.envio);
      }
      replaceEntregaInState(res.entrega);
      closeModal("modal-completar-entrega");
      renderSidebarList();
      showToast(res.envio
        ? `✅ ${res.entrega.os_nombre} enviada y sumada al Control Mensual (${res.entrega.period})`
        : `✅ ${res.entrega.os_nombre} marcada como enviada`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function openObservarEntregaModal(ent) {
    document.getElementById("oe-id").value = ent.id;
    document.getElementById("modal-obs-title").textContent = `Devolver / Observar — ${ent.os_nombre}`;
    document.getElementById("oe-motivo").value = ent.respuesta_exportacion || "";
    openModal("modal-observar-entrega");
  }

  async function handleObservarEntregaSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("oe-id").value;
    const motivo = document.getElementById("oe-motivo").value.trim();
    if (!id || !motivo) return;
    try {
      const res = await apiFetch(`/api/entregas/${id}`, {
        method: "PUT",
        body: JSON.stringify({ estado: "observado", respuesta_exportacion: motivo })
      });
      replaceEntregaInState(res.entrega);
      closeModal("modal-observar-entrega");
      showToast("Entrega devuelta con observación al facturista");
    } catch (err) {
      showToast(err.message);
    }
  }

  function openNewEntregaModal() {
    document.getElementById("form-nueva-entrega-modal").reset();
    document.getElementById("ne-period").value = getCurrentYYYYMM();
    state.modalEntregaPdf = null;
    renderPdfPreviewBox(null, document.getElementById("ne-pdf-preview"));
    openModal("modal-nueva-entrega");
  }

  async function handleNewEntregaModalSubmit(e) {
    e.preventDefault();
    const finName = document.getElementById("ne-fin").value.trim();
    const match = state.financiadoras.find((f) => normalizeStr(f.nombre) === normalizeStr(finName));
    const pdf = state.modalEntregaPdf;
    const payload = {
      financiadora_id: match ? match.id : (pdf ? pdf.financiadora_id || "" : ""),
      os_cod: match ? (match.codigo || "") : (pdf ? pdf.os_cod || "" : ""),
      os_nombre: finName.toUpperCase(),
      area: document.getElementById("ne-area").value,
      period: document.getElementById("ne-period").value,
      condicion: document.getElementById("ne-condicion").value.trim(),
      tipo: document.getElementById("ne-tipo").value,
      importe: document.getElementById("ne-importe").value.trim(),
      observacion: document.getElementById("ne-obs").value.trim(),
      pdf_filename: pdf ? (pdf.pdf_filename || pdf.filename || "") : "",
      pdf_url: pdf ? (pdf.pdf_url || "") : "",
      facturas: pdf ? (pdf.facturas || []) : []
    };
    try {
      const res = await apiFetch("/api/entregas", { method: "POST", body: JSON.stringify(payload) });
      state.modalEntregaPdf = null;
      replaceEntregaInState(res.entrega);
      closeModal("modal-nueva-entrega");
      showToast(`Entrega agregada a Bandeja: ${res.entrega.os_nombre}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===================== VIEW 0B: AREA EXCLUSIVA DE FACTURISTAS =====================
  function renderEntregarView() {
    const container = document.getElementById("entregar-content");
    if (!container) return;

    const editing = state.editingEntregaId
      ? state.entregas.find((e) => e.id === state.editingEntregaId)
      : null;
    if (editing) {
      state.facturistaArea = editing.area || "ambulatorio";
    }

    const sortedFins = getSortedFinanciadoras();
    const list = state.entregas || [];
    const pend = list.filter((e) => e.estado === "pendiente" || e.estado === "en_proceso").length;
    const obs = list.filter((e) => e.estado === "observado").length;
    const env = list.filter((e) => e.estado === "enviado").length;

    container.innerHTML = `
      <div class="facturista-layout">
        <div class="facturista-form-card">
          <h2>${editing ? `✏️ Corregir Entrega — ${escapeHtml(editing.os_nombre)}` : "📤 Nueva Entrega de Facturación"}</h2>
          <p class="subtitle">Subí el PDF de Geclisa para completar los datos automáticamente, o completalos manualmente.</p>

          ${!editing ? `
            <div class="pdf-upload-bar">
              <label class="pdf-upload-label" id="fe-pdf-drop">
                <input type="file" id="fe-pdf-input" accept=".pdf,application/pdf" hidden>
                <span>📄 <strong>Subir PDF de Geclisa</strong> (lee obra social, área, período, facturas y monto)</span>
              </label>
              <div id="fe-pdf-preview" class="hidden"></div>
            </div>
          ` : ""}

          <form id="form-facturista-entrega">
            <div class="form-group">
              <label for="fe-fin">1. Financiadora / Obra Social *</label>
              <select id="fe-fin" required ${editing ? "disabled" : ""}>
                <option value="">— Seleccioná una financiadora —</option>
                ${sortedFins.map((f) => `
                  <option value="${escapeAttr(f.id)}" ${editing && editing.financiadora_id === f.id ? "selected" : ""}>
                    ${escapeHtml(f.nombre)}${f.codigo ? ` (Cód. ${escapeHtml(f.codigo)})` : ""}
                  </option>
                `).join("")}
              </select>
            </div>

            <div class="form-group">
              <label>2. Área *</label>
              <div class="area-toggle-group">
                <button type="button" class="area-toggle-btn ${state.facturistaArea === "ambulatorio" ? "active" : ""}" data-area="ambulatorio">🩺 Ambulatorio</button>
                <button type="button" class="area-toggle-btn ${state.facturistaArea === "internado" ? "active" : ""}" data-area="internado">🏥 Internado</button>
              </div>
              <input type="hidden" id="fe-area" value="${escapeAttr(state.facturistaArea)}">
            </div>

            <div class="form-grid-2">
              <div class="form-group">
                <label for="fe-period">3. Período *</label>
                <input type="month" id="fe-period" required value="${escapeAttr(editing ? editing.period : getCurrentYYYYMM())}">
              </div>
              <div class="form-group">
                <label for="fe-tipo">Tipo</label>
                <select id="fe-tipo">
                  <option value="normal" ${!editing || editing.tipo === "normal" ? "selected" : ""}>Normal</option>
                  <option value="refacturacion" ${editing && editing.tipo === "refacturacion" ? "selected" : ""}>Refacturación</option>
                  <option value="diferencia_arancel" ${editing && editing.tipo === "diferencia_arancel" ? "selected" : ""}>Diferencia de Arancel</option>
                  <option value="preliquidacion" ${editing && editing.tipo === "preliquidacion" ? "selected" : ""}>Preliquidación</option>
                  <option value="otros" ${editing && editing.tipo === "otros" ? "selected" : ""}>Otros</option>
                </select>
              </div>
            </div>

            <div class="form-group">
              <label for="fe-condicion">Condición / Etiqueta (ej. Exento, Gravado, Quincena)</label>
              <input type="text" id="fe-condicion" list="dl-condiciones" value="${escapeAttr(editing ? editing.condicion : "")}" placeholder="Opcional: Exento, Gravado, 1ra Quincena...">
              <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">
                ${["Exento", "Gravado", "1ra Quincena", "2da Quincena"].map((tag) => `
                  <button type="button" class="chip-sm fe-cond-quick" data-tag="${tag}">${tag}</button>
                `).join("")}
              </div>
            </div>

            <div class="form-grid-2">
              <div class="form-group">
                <label for="fe-importe">Importe ($) (opcional)</label>
                <input type="text" id="fe-importe" value="${editing && editing.importe > 0 ? String(editing.importe).replace(".", ",") : ""}" placeholder="Ej: 1520400,50">
              </div>
              <div class="form-group">
                <label for="fe-obs">N° Factura / Nota (opcional)</label>
                <input type="text" id="fe-obs" value="${escapeAttr(editing ? editing.observacion : "")}" placeholder="Ej: Fact 10-50806 / Pres 161355">
              </div>
            </div>

            <div class="btn-row" style="margin-top:14px;">
              <button type="submit" class="btn btn-primary" style="flex:1;">
                ${editing ? "💾 Guardar Corrección y Reenviar" : "📤 Informar Entrega a Exportaciones"}
              </button>
              ${editing ? `<button type="button" class="btn btn-ghost" id="fe-cancel-edit">Cancelar</button>` : ""}
            </div>
          </form>
        </div>

        <div>
          <div class="kpi-grid" style="margin-bottom:14px;">
            <div class="kpi-card">
              <div class="kpi-icon" style="background:var(--amber-bg);color:var(--amber-text);">🕒</div>
              <div>
                <div class="kpi-value">${pend}</div>
                <div class="kpi-label">En cola / Proceso</div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="kpi-icon" style="background:var(--rose-bg);color:var(--rose-text);">⚠️</div>
              <div>
                <div class="kpi-value">${obs}</div>
                <div class="kpi-label">Con observación</div>
              </div>
            </div>
            <div class="kpi-card">
              <div class="kpi-icon" style="background:var(--emerald-bg);color:var(--emerald-text);">✅</div>
              <div>
                <div class="kpi-value">${env}</div>
                <div class="kpi-label">Enviadas</div>
              </div>
            </div>
          </div>

          <div class="tracker-table-wrap">
            <table class="tracker-table">
              <thead>
                <tr>
                  <th>Fecha Carga</th>
                  <th>Financiadora</th>
                  <th>Área / Período</th>
                  <th>Detalle</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                ${list.length === 0 ? `
                  <tr><td colspan="6" style="text-align:center;padding:28px;color:var(--text-muted);">Todavía no informaste ninguna entrega en esta empresa. Usá el formulario de la izquierda para cargar la primera.</td></tr>
                ` : list.map((ent) => {
                  const st = ENTREGA_ESTADO_META[ent.estado] || ENTREGA_ESTADO_META.pendiente;
                  const tMeta = ENVIO_TIPO_META[ent.tipo] || ENVIO_TIPO_META.normal;
                  return `
                    <tr>
                      <td style="font-size:12px;white-space:nowrap;">${escapeHtml(ent.created_at)}</td>
                      <td>
                        <strong>${escapeHtml(ent.os_nombre)}</strong>
                        ${ent.importe > 0 ? `<div style="font-size:11.5px;font-family:var(--font-mono);color:var(--text-secondary);">${formatMoney(ent.importe)}</div>` : ""}
                      </td>
                      <td>
                        <span class="badge ${ent.area === "ambulatorio" ? "badge-blue" : "badge-indigo"}">${ent.area === "ambulatorio" ? "Ambulatorio" : "Internado"}</span>
                        <span class="badge badge-teal">${escapeHtml(ent.period)}</span>
                      </td>
                      <td style="font-size:12px;">
                        ${ent.condicion ? `<span class="badge badge-purple">${escapeHtml(ent.condicion)}</span> ` : ""}
                        ${tMeta.short ? `<span class="badge ${tMeta.cls}">${tMeta.short}</span> ` : ""}
                        ${ent.pdf_url ? `<a href="${escapeAttr(ent.pdf_url)}" target="_blank" rel="noopener" class="badge badge-teal" style="text-decoration:none;">📄 PDF</a> ` : ""}
                        ${escapeHtml(ent.observacion || "")}
                        ${ent.respuesta_exportacion ? `<div style="margin-top:4px;color:${ent.estado === "observado" ? "var(--rose-text)" : "var(--emerald-text)"};font-weight:600;">${ent.estado === "observado" ? "⚠️ " : "💬 "}${escapeHtml(ent.respuesta_exportacion)}</div>` : ""}
                      </td>
                      <td>
                        <span class="badge ${st.cls}">${st.icon} ${st.label}</span>
                        ${ent.estado === "enviado" && ent.processed_at ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(ent.processed_at)}</div>` : ""}
                      </td>
                      <td>
                        <div class="btn-row">
                          ${(ent.estado === "pendiente" || ent.estado === "observado") ? `<button type="button" class="btn btn-xs btn-secondary fe-edit-btn" data-eid="${ent.id}">✏️ ${ent.estado === "observado" ? "Corregir" : "Editar"}</button>` : ""}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Bind form interactions
    if (!editing) {
      const fePreview = document.getElementById("fe-pdf-preview");
      if (state.facturistaPdf) {
        renderPdfPreviewBox(state.facturistaPdf, fePreview, () => {
          state.facturistaPdf = null;
          renderPdfPreviewBox(null, fePreview);
        });
      }
      bindPdfDropzone("fe-pdf-input", "fe-pdf-drop", async (file) => {
        await uploadAndParseGeclisaPdf(file, fePreview, (parsed) => {
          state.facturistaPdf = parsed;
          if (parsed.financiadora_id) {
            document.getElementById("fe-fin").value = parsed.financiadora_id;
          }
          if (parsed.area) {
            state.facturistaArea = parsed.area;
            document.getElementById("fe-area").value = parsed.area;
            container.querySelectorAll(".area-toggle-btn").forEach((b) => {
              b.classList.toggle("active", b.dataset.area === parsed.area);
            });
          }
          if (parsed.period) document.getElementById("fe-period").value = parsed.period;
          if (parsed.condicion_iva) document.getElementById("fe-condicion").value = parsed.condicion_iva;
          if (parsed.total_general > 0) document.getElementById("fe-importe").value = String(parsed.total_general).replace(".", ",");
          if (parsed.resumen_facturas) document.getElementById("fe-obs").value = parsed.resumen_facturas;
          renderPdfPreviewBox(parsed, fePreview, () => {
            state.facturistaPdf = null;
            renderPdfPreviewBox(null, fePreview);
          });
        });
      });
    }

    container.querySelectorAll(".area-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.facturistaArea = btn.dataset.area;
        document.getElementById("fe-area").value = state.facturistaArea;
        container.querySelectorAll(".area-toggle-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.area === state.facturistaArea);
        });
      });
    });

    container.querySelectorAll(".fe-cond-quick").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("fe-condicion").value = btn.dataset.tag;
      });
    });

    const cancelEditBtn = document.getElementById("fe-cancel-edit");
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener("click", () => {
        state.editingEntregaId = null;
        renderEntregarView();
      });
    }

    document.getElementById("form-facturista-entrega").addEventListener("submit", async (e) => {
      e.preventDefault();
      const finId = document.getElementById("fe-fin").value;
      const area = document.getElementById("fe-area").value;
      const period = document.getElementById("fe-period").value;
      const tipo = document.getElementById("fe-tipo").value;
      const condicion = document.getElementById("fe-condicion").value.trim();
      const importe = document.getElementById("fe-importe").value.trim();
      const observacion = document.getElementById("fe-obs").value.trim();

      if (!editing && !finId) {
        showToast("Seleccioná una financiadora de la lista");
        return;
      }

      try {
        if (editing) {
          const res = await apiFetch(`/api/entregas/${editing.id}`, {
            method: "PUT",
            body: JSON.stringify({ area, period, tipo, condicion, importe, observacion })
          });
          state.editingEntregaId = null;
          replaceEntregaInState(res.entrega);
          showToast("Entrega corregida y reenviada a Exportaciones");
        } else {
          const pdf = state.facturistaPdf;
          const res = await apiFetch("/api/entregas", {
            method: "POST",
            body: JSON.stringify({
              financiadora_id: finId,
              area,
              period,
              tipo,
              condicion,
              importe,
              observacion,
              pdf_filename: pdf ? (pdf.pdf_filename || pdf.filename || "") : "",
              pdf_url: pdf ? (pdf.pdf_url || "") : "",
              facturas: pdf ? (pdf.facturas || []) : []
            })
          });
          state.facturistaPdf = null;
          replaceEntregaInState(res.entrega);
          showToast(`✅ Entrega informada: ${res.entrega.os_nombre} (${area} ${period})`);
        }
      } catch (err) {
        showToast(err.message);
      }
    });

    container.querySelectorAll(".fe-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.editingEntregaId = Number(btn.dataset.eid);
        renderEntregarView();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    container.querySelectorAll(".fe-del-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Anular esta entrega pendiente?")) return;
        try {
          await apiFetch(`/api/entregas/${btn.dataset.eid}`, { method: "DELETE" });
          state.entregas = state.entregas.filter((x) => x.id !== Number(btn.dataset.eid));
          updateNavBadges();
          renderEntregarView();
          showToast("Entrega anulada");
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  }

  // ===================== SIDEBAR LIST =====================
  function renderSidebarList() {
    const container = document.getElementById("sidebar-fin-list");
    const q = normalizeStr(state.sidebarSearch);
    const sorted = getSortedFinanciadoras().filter((f) =>
      !q || normalizeStr(`${f.nombre} ${f.codigo || ""}`).includes(q)
    );

    document.getElementById("sidebar-list-count").textContent = sorted.length;

    container.innerHTML = sorted.map((f) => {
      const isFav = state.favorites.includes(f.id);
      const comp = getFinMonthlyCompletion(f);
      const dotCls = comp === "done" ? "done" : comp === "partial" ? "partial" : "";
      const isActive = state.activeView === "financiadoras" && state.selectedId === f.id;
      return `
        <button class="sidebar-fin-btn ${isActive ? "active" : ""}" data-id="${escapeAttr(f.id)}">
          <span class="sidebar-fin-name">${isFav ? "⭐ " : ""}${escapeHtml(f.nombre)}</span>
          <span class="sidebar-fin-dots">
            ${f.vencimiento ? '<span title="Tiene fecha tope">⏰</span>' : ""}
            <span class="dot-status ${dotCls}" title="Envíos en ${state.trackerPeriod}"></span>
          </span>
        </button>
      `;
    }).join("");

    container.querySelectorAll(".sidebar-fin-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openFinDetail(btn.dataset.id);
        closeMobileSidebar();
      });
    });
  }

  // ===================== VIEW 1: FINANCIADORAS =====================
  function renderFinanciadorasView() {
    const dirPanel = document.getElementById("fin-directory-panel");
    const detailPanel = document.getElementById("fin-detail-panel");

    if (state.selectedId) {
      const fin = state.financiadoras.find((f) => f.id === state.selectedId);
      if (fin) {
        dirPanel.classList.add("hidden");
        detailPanel.classList.remove("hidden");
        renderFinDetail(fin);
        return;
      } else {
        state.selectedId = null;
      }
    }

    dirPanel.classList.remove("hidden");
    detailPanel.classList.add("hidden");
    renderKpis();
    renderFinanciadorasGrid();
  }

  function renderKpis() {
    const all = state.financiadoras;
    const withPortal = all.filter((f) => (f.portales || []).length > 0).length;
    const withTxt = all.filter((f) => (f.canales || []).includes("txt")).length;
    const periodEnvs = getPeriodEnvios();
    const totalPer = periodEnvs.reduce((acc, e) => acc + Number(e.importe || 0), 0);
    const inTransit = state.postal.filter((p) => !p.fecha_entrega).length;

    document.getElementById("kpi-grid").innerHTML = `
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent-text);">🏥</div>
        <div>
          <div class="kpi-value">${all.length}</div>
          <div class="kpi-label">Financiadoras registradas</div>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--indigo-bg);color:var(--indigo-text);">🌐</div>
        <div>
          <div class="kpi-value">${withPortal}</div>
          <div class="kpi-label">Con portal web propio</div>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--amber-bg);color:var(--amber-text);">📄</div>
        <div>
          <div class="kpi-value">${withTxt}</div>
          <div class="kpi-label">Requieren Exp. Fact. (.TXT)</div>
        </div>
      </div>
      <div class="kpi-card" style="cursor:pointer;" id="kpi-go-seguimiento">
        <div class="kpi-icon" style="background:var(--emerald-bg);color:var(--emerald-text);">💰</div>
        <div>
          <div class="kpi-value" style="font-size:15.5px;">${formatMoney(totalPer)}</div>
          <div class="kpi-label">Enviado período ${escapeHtml(state.trackerPeriod)} (${periodEnvs.length} reg.)</div>
        </div>
      </div>
      <div class="kpi-card" style="cursor:pointer;" id="kpi-go-postal">
        <div class="kpi-icon" style="background:var(--rose-bg);color:var(--rose-text);">📦</div>
        <div>
          <div class="kpi-value">${inTransit}</div>
          <div class="kpi-label">Andreani en tránsito (${state.postal.length} tot.)</div>
        </div>
      </div>
    `;

    document.getElementById("kpi-go-seguimiento").addEventListener("click", () => switchView("seguimiento"));
    document.getElementById("kpi-go-postal").addEventListener("click", () => switchView("postal"));
  }

  function getFilteredFinanciadoras() {
    const q = normalizeStr(state.searchQuery);
    return getSortedFinanciadoras().filter((f) => {
      if (state.categoryFilter !== "all" && f.categoria !== state.categoryFilter) return false;

      if (state.channelFilter) {
        if (state.channelFilter === "favoritos") {
          if (!state.favorites.includes(f.id)) return false;
        } else if (state.channelFilter === "vencimiento") {
          if (!f.vencimiento || !f.vencimiento.trim()) return false;
        } else {
          if (!(f.canales || []).includes(state.channelFilter)) return false;
        }
      }

      if (q) {
        const haystack = [
          f.codigo || "",
          f.nombre,
          CATEGORY_LABELS[f.categoria] || "",
          f.ambulatorio,
          f.internado,
          f.vencimiento,
          f.asuntoRegla,
          f.instrucciones,
          f.notasInternas,
          ...(f.archivos || []),
          ...(f.canales || []),
          ...(f.portales || []).map((p) => `${p.label} ${p.url}`),
          ...(f.credenciales || []).map((c) => `${c.label} ${c.usuario} ${c.extra}`),
          ...(f.emails || []).map((e) => `${e.address} ${e.label}`)
        ].join(" ");
        if (!normalizeStr(haystack).includes(q)) return false;
      }

      return true;
    }).sort((a, b) => {
      const aFav = state.favorites.includes(a.id) ? 0 : 1;
      const bFav = state.favorites.includes(b.id) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      return a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" });
    });
  }

  function renderFinanciadorasGrid() {
    const list = getFilteredFinanciadoras();
    const grid = document.getElementById("fin-grid");
    document.getElementById("results-count-label").textContent =
      `Mostrando ${list.length} de ${state.financiadoras.length} financiadoras`;

    if (list.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <h3>No se encontraron financiadoras</h3>
          <p>Probá ajustando los filtros de búsqueda.</p>
          ${canEditFinanciadoras() ? `<button class="btn btn-primary" id="btn-empty-new" style="margin-top:10px;">＋ Nueva Financiadora</button>` : ""}
        </div>
      `;
      const btnNew = document.getElementById("btn-empty-new");
      if (btnNew) btnNew.addEventListener("click", () => openFinModal(null));
      return;
    }

    grid.innerHTML = list.map((f) => {
      const isFav = state.favorites.includes(f.id);
      const emailsCount = (f.emails || []).length;
      const hasPortal = (f.portales || []).length > 0;
      const hasCreds = (f.credenciales || []).length > 0;
      const finEnvs = getFinPeriodEnvios(f);

      return `
        <article class="fin-card" data-id="${escapeAttr(f.id)}">
          <div class="fin-card-top">
            <div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${f.codigo ? `<span class="code-pill">#${escapeHtml(f.codigo)}</span>` : ""}
                <h3 class="fin-card-title">${escapeHtml(f.nombre)}</h3>
              </div>
              <div class="fin-card-cat">${escapeHtml(CATEGORY_LABELS[f.categoria] || f.categoria)}</div>
            </div>
            <button class="fav-btn ${isFav ? "active" : ""}" data-fav="${escapeAttr(f.id)}" title="${isFav ? "Quitar de favoritas" : "Marcar como favorita"}">
              ${isFav ? "⭐" : "☆"}
            </button>
          </div>

          <div class="fin-card-badges">
            ${(f.canales || []).map((c) => {
              const m = CHANNEL_META[c];
              return m ? `<span class="badge ${m.cls}">${m.icon} ${m.label}</span>` : "";
            }).join("")}
            ${hasCreds ? `<span class="badge badge-purple">🔑 Claves</span>` : ""}
            ${finEnvs.length > 0 ? `<span class="badge badge-emerald">✓ ${finEnvs.length} envío${finEnvs.length > 1 ? "s" : ""} (${state.trackerPeriod})</span>` : ""}
          </div>

          ${f.vencimiento ? `<div class="fin-card-deadline">⏰ ${escapeHtml(f.vencimiento)}</div>` : ""}

          <div class="fin-card-summary">${escapeHtml(f.instrucciones || "Sin instrucciones cargadas.")}</div>

          <div class="fin-card-footer">
            <div class="fin-card-quick-actions">
              ${hasPortal ? `<a href="${escapeAttr(f.portales[0].url)}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary stop-prop" title="Abrir portal web">🌐 Portal</a>` : ""}
              ${emailsCount > 0 ? `<button type="button" class="btn btn-xs btn-secondary copy-all-emails-btn stop-prop" data-id="${escapeAttr(f.id)}" title="Copiar todos los correos (${emailsCount})">📋 ${emailsCount} Mail${emailsCount > 1 ? "s" : ""}</button>` : ""}
            </div>
            <span class="badge badge-teal">Ver ficha →</span>
          </div>
        </article>
      `;
    }).join("");

    grid.querySelectorAll(".fin-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".stop-prop") || e.target.closest(".fav-btn")) return;
        openFinDetail(card.dataset.id);
      });
    });

    grid.querySelectorAll(".fav-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(btn.dataset.fav);
      });
    });

    grid.querySelectorAll(".copy-all-emails-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const fin = state.financiadoras.find((x) => x.id === btn.dataset.id);
        if (fin) copyFinEmails(fin);
      });
    });
  }

  async function toggleFavorite(id) {
    if (state.favorites.includes(id)) {
      state.favorites = state.favorites.filter((x) => x !== id);
    } else {
      state.favorites.push(id);
    }
    renderSidebarList();
    renderFinanciadorasView();
    try {
      await apiFetch(`/api/favorites/${encodeURIComponent(id)}`, { method: "POST" });
    } catch (err) {
      showToast(err.message);
    }
  }

  function openFinDetail(id) {
    state.selectedId = id;
    if (state.activeView !== "financiadoras") {
      state.activeView = "financiadoras";
      document.querySelectorAll(".nav-item").forEach((n) => {
        n.classList.toggle("active", n.dataset.view === "financiadoras");
      });
      document.querySelectorAll(".view").forEach((v) => {
        v.classList.toggle("active", v.id === "view-financiadoras");
      });
    }
    renderFinanciadorasView();
    renderSidebarList();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ===================== FINANCIADORA DETAIL SHEET =====================
  function renderFinDetail(f) {
    const panel = document.getElementById("fin-detail-panel");
    const admin = isAdmin();
    const canEdit = canEditFinanciadoras();
    const isFav = state.favorites.includes(f.id);
    const finEnvs = getFinPeriodEnvios(f);
    const finTotal = finEnvs.reduce((acc, e) => acc + Number(e.importe || 0), 0);
    const emails = f.emails || [];
    const portales = f.portales || [];
    const creds = f.credenciales || [];
    const imagenes = f.imagenes || [];

    const instName = (state.institution && state.institution.nombre) || (state.company && state.company.nombre) || "Facturación";
    const mailtoHref = emails.length > 0
      ? `mailto:${emails.map((e) => e.address).join(",")}?subject=${encodeURIComponent(f.asuntoRegla || `Facturación ${f.nombre} - ${instName}`)}`
      : "";

    panel.innerHTML = `
      <div class="detail-topbar">
        <button class="btn btn-secondary" id="btn-back-list">← Volver al directorio</button>
        <div class="btn-row">
          <button class="btn btn-primary" id="btn-detail-add-envio">＋ Registrar Envío (${state.trackerPeriod})</button>
          <button class="btn btn-secondary" id="btn-detail-fav">${isFav ? "⭐ Favorita" : "☆ Favorita"}</button>
          <button class="btn btn-secondary" id="btn-detail-print">🖨️ Imprimir</button>
          ${canEdit ? `
            <button class="btn btn-secondary" id="btn-detail-dup">📄 Duplicar</button>
            <button class="btn btn-secondary" id="btn-detail-edit">✏️ Editar</button>
            ${admin ? `<button class="btn btn-danger-outline" id="btn-detail-delete" title="Eliminar financiadora">🗑️</button>` : ""}
          ` : `<span class="badge badge-blue" style="padding:7px 12px;">👁️ Modo Consulta</span>`}
        </div>
      </div>

      <div class="detail-header-card">
        <div class="detail-title-row">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
              ${f.codigo ? `<span class="code-pill" style="font-size:12px;">Cód. Geclisa: ${escapeHtml(f.codigo)}</span>` : ""}
              <span class="badge badge-teal">${escapeHtml(CATEGORY_LABELS[f.categoria] || f.categoria)}</span>
              ${(f.canales || []).map((c) => {
                const m = CHANNEL_META[c];
                return m ? `<span class="badge ${m.cls}">${m.icon} ${m.label}</span>` : "";
              }).join("")}
            </div>
            <h1>${escapeHtml(f.nombre)}</h1>
            ${f._updated_by ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">🕒 Última modificación por <strong>${escapeHtml(f._updated_by)}</strong>${f._updated_at ? ` · ${escapeHtml(f._updated_at)}` : ""}</div>` : ""}
          </div>
          ${f.vencimiento ? `<div class="fin-card-deadline" style="font-size:13px;padding:8px 13px;">⏰ Vencimiento: ${escapeHtml(f.vencimiento)}</div>` : ""}
        </div>

        ${(f.archivos || []).length > 0 ? `
          <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span style="font-size:12px;font-weight:600;color:var(--text-muted);margin-right:4px;">Archivos requeridos:</span>
            ${f.archivos.map((a) => `<span class="badge badge-neutral">📎 ${escapeHtml(a)}</span>`).join("")}
          </div>
        ` : ""}

        <div class="detail-modalities">
          <div class="modality-box">
            <div class="modality-label">Ambulatorio</div>
            <div class="modality-val">${escapeHtml(f.ambulatorio || "No especificado")}</div>
          </div>
          <div class="modality-box">
            <div class="modality-label">Internado</div>
            <div class="modality-val">${escapeHtml(f.internado || "No especificado")}</div>
          </div>
          <div class="modality-box">
            <div class="modality-label">Enviado en ${escapeHtml(state.trackerPeriod)} (${finEnvs.length} reg.)</div>
            <div class="modality-val" style="color:var(--accent-text);font-family:var(--font-mono);">${formatMoney(finTotal)}</div>
          </div>
        </div>
      </div>

      <div class="detail-grid">
        <div>
          ${finEnvs.length > 0 ? `
            <div class="detail-card">
              <div class="detail-card-title">
                <span>📊 Envíos registrados en ${escapeHtml(state.trackerPeriod)}</span>
                <button class="btn btn-xs btn-secondary" id="btn-detail-add-envio-2">＋ Agregar otro</button>
              </div>
              <div class="envio-chip-list">
                ${finEnvs.map((ev) => renderEnvioChipHtml(ev, true)).join("")}
              </div>
            </div>
          ` : ""}

          ${f.asuntoRegla ? `
            <div class="rule-alert">
              <strong>📌 Regla de Asunto / Nomenclatura de Archivos</strong>
              <span>${escapeHtml(f.asuntoRegla)}</span>
            </div>
          ` : ""}

          ${f.nomenclaturaTipo ? `<div id="detail-inline-generator" style="margin-bottom:16px;"></div>` : ""}

          <div class="detail-card">
            <div class="detail-card-title">
              <span>📋 Instrucciones de Exportación y Presentación</span>
            </div>
            <div class="instructions-body">${escapeHtml(f.instrucciones || "Sin instrucciones detalladas.")}</div>
          </div>

          ${imagenes.length > 0 ? `
            <div class="detail-card">
              <div class="detail-card-title">
                <span>🖼️ Capturas de Pantalla y Guía Visual (${imagenes.length})</span>
                <span style="font-size:11.5px;font-weight:400;color:var(--text-muted);">Clic para ampliar</span>
              </div>
              <div class="img-gallery">
                ${imagenes.map((img, idx) => `
                  <div class="gallery-thumb" data-img-idx="${idx}">
                    <img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.caption || f.nombre)}" loading="lazy">
                    ${img.caption ? `<div class="gallery-caption">${escapeHtml(img.caption)}</div>` : ""}
                  </div>
                `).join("")}
              </div>
            </div>
          ` : ""}

          <div class="detail-card">
            <div class="detail-card-title">
              <span>📝 Notas Internas del Sector</span>
              <span style="font-size:11px;font-weight:500;color:var(--text-muted);">${canEdit ? "Guardado automático con auditoría" : "Solo lectura"}</span>
            </div>
            ${canEdit
              ? `<textarea class="notes-textarea" id="detail-notes-input" placeholder="Anotá contactos actualizados, particularidades de auditoría, débitos frecuentes o recordatorios...">${escapeHtml(f.notasInternas || "")}</textarea>`
              : `<div class="instructions-body" style="color:var(--text-secondary);">${escapeHtml(f.notasInternas || "Sin notas internas registradas.")}</div>`
            }
          </div>
        </div>

        <div>
          ${portales.length > 0 ? `
            <div class="detail-card">
              <div class="detail-card-title"><span>🌐 Portales Web</span></div>
              ${portales.map((p) => `
                <a class="portal-link-row" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">
                  <div style="min-width:0;">
                    <div style="font-weight:600;font-size:13px;">${escapeHtml(p.label || "Abrir Portal")}</div>
                    <div class="portal-link-url">${escapeHtml(p.url)}</div>
                  </div>
                  <span style="font-size:15px;">↗</span>
                </a>
              `).join("")}
            </div>
          ` : ""}

          ${creds.length > 0 ? `
            <div class="detail-card">
              <div class="detail-card-title">
                <span>🔑 Credenciales de Acceso</span>
                <span style="font-size:11px;color:var(--text-muted);">1 clic para copiar</span>
              </div>
              ${creds.map((c, idx) => `
                <div class="cred-item">
                  <div class="cred-label">${escapeHtml(c.label || `Cuenta ${idx + 1}`)}</div>
                  ${c.usuario ? `
                    <div class="cred-row">
                      <span class="cred-key">Usuario</span>
                      <div class="cred-val-group">
                        <code class="cred-code">${escapeHtml(c.usuario)}</code>
                        <button class="btn-icon-sm copy-val-btn" data-val="${escapeAttr(c.usuario)}" title="Copiar usuario">📋</button>
                      </div>
                    </div>
                  ` : ""}
                  ${c.clave ? `
                    <div class="cred-row">
                      <span class="cred-key">Contraseña</span>
                      <div class="cred-val-group">
                        <code class="cred-code pwd-mask" data-real="${escapeAttr(c.clave)}" data-shown="false">••••••••</code>
                        <button class="btn-icon-sm toggle-pwd-btn" title="Mostrar / Ocultar clave">👁️</button>
                        <button class="btn-icon-sm copy-val-btn" data-val="${escapeAttr(c.clave)}" title="Copiar contraseña">📋</button>
                      </div>
                    </div>
                  ` : ""}
                  ${c.extra ? `
                    <div class="cred-row">
                      <span class="cred-key">Dato extra</span>
                      <div class="cred-val-group">
                        <span style="font-size:12px;font-weight:500;">${escapeHtml(c.extra)}</span>
                        <button class="btn-icon-sm copy-val-btn" data-val="${escapeAttr(c.extra)}" title="Copiar dato">📋</button>
                      </div>
                    </div>
                  ` : ""}
                </div>
              `).join("")}
            </div>
          ` : ""}

          <div class="detail-card">
            <div class="detail-card-title">
              <span>✉️ Casillas de Correo (${emails.length})</span>
            </div>
            ${emails.length > 0 ? `
              <div class="email-toolbar">
                <button class="btn btn-sm btn-primary" id="btn-copy-all-detail-emails">
                  📋 Copiar todos (${state.emailSeparator.trim()})
                </button>
                <a class="btn btn-sm btn-secondary" href="${mailtoHref}">
                  ✉️ Redactar Correo
                </a>
              </div>
              ${emails.map((em) => `
                <div class="email-row">
                  <div style="min-width:0;">
                    <span class="email-address">${escapeHtml(em.address)}</span>
                    ${em.label ? `<span class="email-tag">${escapeHtml(em.label)}</span>` : ""}
                  </div>
                  <button class="btn-icon-sm copy-val-btn" data-val="${escapeAttr(em.address)}" title="Copiar correo">📋</button>
                </div>
              `).join("")}
            ` : `<p style="margin:0;color:var(--text-muted);font-size:13px;">No tiene casillas de correo registradas.</p>`}
          </div>
        </div>
      </div>
    `;

    document.getElementById("btn-back-list").addEventListener("click", () => {
      state.selectedId = null;
      renderFinanciadorasView();
      renderSidebarList();
    });
    const openAddForFin = () => openEnvioModal(null, f);
    document.getElementById("btn-detail-add-envio").addEventListener("click", openAddForFin);
    const btnAdd2 = document.getElementById("btn-detail-add-envio-2");
    if (btnAdd2) btnAdd2.addEventListener("click", openAddForFin);

    panel.querySelectorAll(".envio-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const ev = state.envios.find((x) => x.id === Number(chip.dataset.eid));
        if (ev) openEnvioModal(ev);
      });
    });

    document.getElementById("btn-detail-fav").addEventListener("click", () => toggleFavorite(f.id));
    document.getElementById("btn-detail-print").addEventListener("click", () => window.print());

    if (canEdit) {
      document.getElementById("btn-detail-edit").addEventListener("click", () => openFinModal(f));
      document.getElementById("btn-detail-dup").addEventListener("click", () => duplicateFinanciadora(f));
      if (admin) {
        document.getElementById("btn-detail-delete").addEventListener("click", () => deleteFinanciadora(f));
      }

      let noteTimer = null;
      document.getElementById("detail-notes-input").addEventListener("input", (e) => {
        f.notasInternas = e.target.value;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(async () => {
          try {
            await apiFetch(`/api/financiadoras/${encodeURIComponent(f.id)}/notes`, {
              method: "PATCH",
              body: JSON.stringify({ notasInternas: f.notasInternas })
            });
          } catch (err) {
            showToast(err.message);
          }
        }, 600);
      });
    }

    if (f.nomenclaturaTipo && window.ExportTools) {
      const genContainer = document.getElementById("detail-inline-generator");
      window.ExportTools.renderGeneratorWidget(genContainer, f.nomenclaturaTipo, copyText, state.institution);
    }

    panel.querySelectorAll(".copy-val-btn").forEach((btn) => {
      btn.addEventListener("click", () => copyText(btn.dataset.val, "Copiado al portapapeles"));
    });

    panel.querySelectorAll(".toggle-pwd-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const codeEl = btn.parentElement.querySelector(".pwd-mask");
        const shown = codeEl.dataset.shown === "true";
        codeEl.dataset.shown = String(!shown);
        codeEl.textContent = shown ? "••••••••" : codeEl.dataset.real;
        btn.textContent = shown ? "👁️" : "🙈";
      });
    });

    const copyAllBtn = document.getElementById("btn-copy-all-detail-emails");
    if (copyAllBtn) copyAllBtn.addEventListener("click", () => copyFinEmails(f));

    panel.querySelectorAll(".gallery-thumb").forEach((thumb) => {
      thumb.addEventListener("click", () => openLightbox(imagenes, Number(thumb.dataset.imgIdx)));
    });
  }

  function copyFinEmails(fin) {
    const list = (fin.emails || []).map((e) => e.address).filter(Boolean);
    if (list.length === 0) return;
    copyText(list.join(state.emailSeparator), `${list.length} email(s) de ${fin.nombre} copiados`);
  }

  // ===================== VIEW 3: CONTROL MENSUAL (PLANILLA DE ENVIOS Y MONTOS) =====================
  function renderEnvioChipHtml(ev, showArea = false) {
    const tMeta = ENVIO_TIPO_META[ev.tipo] || ENVIO_TIPO_META.normal;
    const areaBadge = showArea
      ? `<span class="badge ${ev.area === "ambulatorio" ? "badge-blue" : "badge-indigo"}">${ev.area === "ambulatorio" ? "Amb" : "Int"}</span>`
      : "";
    const tipoBadge = tMeta.short ? `<span class="badge ${tMeta.cls}">${tMeta.short}</span>` : "";
    const tagBadge = ev.etiqueta ? `<span class="badge badge-neutral">${escapeHtml(ev.etiqueta)}</span>` : "";
    const pdfIcon = ev.pdf_url ? `<span title="Tiene PDF Geclisa adjunto">📄</span>` : "";
    return `
      <div class="envio-chip" data-eid="${ev.id}" title="Clic para editar envío${ev.observacion ? ` · ${escapeAttr(ev.observacion)}` : ""}">
        <div class="envio-chip-left">
          ${areaBadge}
          ${pdfIcon}
          <span class="envio-date">${formatDateAR(ev.fecha_envio)}</span>
          ${tipoBadge}
          ${tagBadge}
        </div>
        <span class="envio-amount">${ev.importe > 0 ? formatMoney(ev.importe) : (ev.etiqueta ? "—" : "$ 0,00")}</span>
      </div>
    `;
  }

  function renderSeguimientoView() {
    const container = document.getElementById("seguimiento-content");
    const period = state.trackerPeriod;
    const periodEnvs = getPeriodEnvios(period);

    const totalAmb = periodEnvs.filter((e) => e.area === "ambulatorio").reduce((a, b) => a + Number(b.importe || 0), 0);
    const totalInt = periodEnvs.filter((e) => e.area === "internado").reduce((a, b) => a + Number(b.importe || 0), 0);
    const totalGen = totalAmb + totalInt;
    const especiales = periodEnvs.filter((e) => e.tipo === "refacturacion" || e.tipo === "diferencia_arancel");
    const totalEsp = especiales.reduce((a, b) => a + Number(b.importe || 0), 0);

    // Períodos disponibles para salto rápido
    const allPeriods = [...new Set([getCurrentYYYYMM(), period, ...state.envios.map((e) => e.period)])].sort().reverse();

    // Agrupar filas consolidadas (todas las financiadoras + cualquier envío extra del período)
    const rowMap = new Map();
    getSortedFinanciadoras().forEach((f) => {
      const grp = f.categoria === "art" ? "art" : "directas";
      rowMap.set(f.id, {
        key: f.id,
        fin: f,
        os_cod: f.codigo || "",
        os_nombre: f.nombre,
        grupo: grp,
        amb: [],
        int: [],
        total: 0
      });
    });

    periodEnvs.forEach((ev) => {
      let targetKey = ev.financiadora_id && rowMap.has(ev.financiadora_id) ? ev.financiadora_id : null;
      if (!targetKey) {
        const match = state.financiadoras.find((f) => normalizeStr(f.nombre) === normalizeStr(ev.os_nombre));
        if (match && rowMap.has(match.id)) targetKey = match.id;
      }
      if (!targetKey) {
        targetKey = `custom_${ev.grupo}_${normalizeStr(ev.os_nombre)}`;
        if (!rowMap.has(targetKey)) {
          rowMap.set(targetKey, {
            key: targetKey,
            fin: null,
            os_cod: ev.os_cod || "",
            os_nombre: ev.os_nombre,
            grupo: ev.grupo || "directas",
            amb: [],
            int: [],
            total: 0
          });
        }
      }
      const row = rowMap.get(targetKey);
      if (ev.area === "internado") row.int.push(ev);
      else row.amb.push(ev);
      row.total += Number(ev.importe || 0);
    });

    const allRows = [...rowMap.values()];
    const conEnviosCount = allRows.filter((r) => r.amb.length + r.int.length > 0).length;
    const q = normalizeStr(state.envioSearch);

    // Filtrado para vista consolidada
    const filteredRows = allRows.filter((r) => {
      const hasAny = r.amb.length + r.int.length > 0;
      const hasEsp = [...r.amb, ...r.int].some((e) => e.tipo === "refacturacion" || e.tipo === "diferencia_arancel");
      if (state.envioFilter === "enviados" && !hasAny) return false;
      if (state.envioFilter === "pendientes" && hasAny) return false;
      if (state.envioFilter === "especiales" && !hasEsp) return false;
      if (q) {
        const hay = normalizeStr(`${r.os_cod} ${r.os_nombre} ${[...r.amb, ...r.int].map((e) => `${e.etiqueta} ${e.observacion}`).join(" ")}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const directasRows = filteredRows.filter((r) => r.grupo !== "art").sort((a, b) => a.os_nombre.localeCompare(b.os_nombre, "es"));
    const artRows = filteredRows.filter((r) => r.grupo === "art").sort((a, b) => a.os_nombre.localeCompare(b.os_nombre, "es"));

    const sumGroup = (rows) => ({
      amb: rows.reduce((s, r) => s + r.amb.reduce((a, e) => a + Number(e.importe || 0), 0), 0),
      int: rows.reduce((s, r) => s + r.int.reduce((a, e) => a + Number(e.importe || 0), 0), 0),
      tot: rows.reduce((s, r) => s + r.total, 0)
    });
    const dirSum = sumGroup(directasRows);
    const artSum = sumGroup(artRows);

    // Filtrado para vista detalle cronológico
    const detalleEnvs = periodEnvs.filter((e) => {
      if (state.envioAreaFilter !== "all" && e.area !== state.envioAreaFilter) return false;
      if (state.envioFilter === "especiales" && e.tipo !== "refacturacion" && e.tipo !== "diferencia_arancel") return false;
      if (q) {
        const hay = normalizeStr(`${e.os_cod} ${e.os_nombre} ${e.etiqueta} ${e.observacion} ${e.tipo}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const renderConsolidatedRows = (rows) => rows.map((r) => `
      <tr>
        <td style="width:80px;">${r.os_cod ? `<span class="code-pill">${escapeHtml(r.os_cod)}</span>` : "—"}</td>
        <td>
          ${r.fin
            ? `<strong style="cursor:pointer;color:var(--accent-text);" class="tracker-open-fin" data-id="${escapeAttr(r.fin.id)}">${escapeHtml(r.os_nombre)}</strong>`
            : `<strong>${escapeHtml(r.os_nombre)}</strong>`}
          ${r.fin && r.fin.vencimiento ? `<div style="font-size:11px;color:var(--amber-text);">⏰ ${escapeHtml(r.fin.vencimiento)}</div>` : ""}
        </td>
        <td style="min-width:225px;">
          ${r.amb.length > 0
            ? `<div class="envio-chip-list">${r.amb.map((ev) => renderEnvioChipHtml(ev, false)).join("")}</div>`
            : `<span style="color:var(--text-muted);font-size:12px;">—</span>`}
        </td>
        <td style="min-width:225px;">
          ${r.int.length > 0
            ? `<div class="envio-chip-list">${r.int.map((ev) => renderEnvioChipHtml(ev, false)).join("")}</div>`
            : `<span style="color:var(--text-muted);font-size:12px;">—</span>`}
        </td>
        <td style="text-align:right;">
          <span class="money-total">${r.total > 0 ? formatMoney(r.total) : "—"}</span>
        </td>
        <td style="width:46px;text-align:center;">
          <button class="btn-icon-sm quick-add-envio-btn" data-fid="${escapeAttr(r.fin ? r.fin.id : "")}" data-name="${escapeAttr(r.os_nombre)}" data-cod="${escapeAttr(r.os_cod)}" data-grp="${escapeAttr(r.grupo)}" title="Registrar envío para ${escapeAttr(r.os_nombre)}">＋</button>
        </td>
      </tr>
    `).join("");

    container.innerHTML = `
      <div class="period-pills-bar">
        <span>Períodos cargados:</span>
        ${allPeriods.map((p) => `
          <button class="chip-sm period-jump-btn ${p === period ? "active" : ""}" data-period="${p}">
            ${p} (${state.envios.filter((e) => e.period === p).length})
          </button>
        `).join("")}
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent-text);">💰</div>
          <div>
            <div class="kpi-value" style="font-size:17px;">${formatMoney(totalGen)}</div>
            <div class="kpi-label">Total Período ${escapeHtml(period)}</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--blue-bg);color:var(--blue-text);">🩺</div>
          <div>
            <div class="kpi-value" style="font-size:16px;">${formatMoney(totalAmb)}</div>
            <div class="kpi-label">Total Ambulatorio</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--indigo-bg);color:var(--indigo-text);">🏥</div>
          <div>
            <div class="kpi-value" style="font-size:16px;">${formatMoney(totalInt)}</div>
            <div class="kpi-label">Total Internado</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--amber-bg);color:var(--amber-text);">🔁</div>
          <div>
            <div class="kpi-value" style="font-size:16px;">${especiales.length} <span style="font-size:12px;font-weight:600;color:var(--text-muted);">(${formatMoney(totalEsp)})</span></div>
            <div class="kpi-label">Refact. / Dif. Arancel</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--emerald-bg);color:var(--emerald-text);">✅</div>
          <div>
            <div class="kpi-value">${conEnviosCount}/${allRows.length}</div>
            <div class="kpi-label">Financiadoras con envíos</div>
          </div>
        </div>
      </div>

      <div class="subtabs-bar">
        <div class="subtabs-group">
          <button class="subtab-btn ${state.envioSubtab === "consolidado" ? "active" : ""}" data-subtab="consolidado">📊 Planilla Consolidada</button>
          <button class="subtab-btn ${state.envioSubtab === "detalle" ? "active" : ""}" data-subtab="detalle">🧾 Detalle de Envíos (${periodEnvs.length})</button>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="text" class="inline-search-input" id="envio-search-input" value="${escapeAttr(state.envioSearch)}" placeholder="Filtrar por código, obra social o tag...">
          <div class="filter-group">
            <button class="chip-sm env-f-btn ${state.envioFilter === "all" ? "active" : ""}" data-ef="all">Todas</button>
            ${state.envioSubtab === "consolidado" ? `
              <button class="chip-sm env-f-btn ${state.envioFilter === "enviados" ? "active" : ""}" data-ef="enviados">Con envíos</button>
              <button class="chip-sm env-f-btn ${state.envioFilter === "pendientes" ? "active" : ""}" data-ef="pendientes">Sin envíos</button>
            ` : `
              <button class="chip-sm env-area-btn ${state.envioAreaFilter === "ambulatorio" ? "active" : ""}" data-ea="ambulatorio">Ambulatorio</button>
              <button class="chip-sm env-area-btn ${state.envioAreaFilter === "internado" ? "active" : ""}" data-ea="internado">Internado</button>
            `}
            <button class="chip-sm env-f-btn ${state.envioFilter === "especiales" ? "active" : ""}" data-ef="especiales">🔁 Refact. / Dif. Arancel</button>
          </div>
        </div>
      </div>

      ${state.envioSubtab === "consolidado" ? `
        <div class="tracker-table-wrap">
          <table class="tracker-table">
            <thead>
              <tr>
                <th>Cód.</th>
                <th>Financiadora</th>
                <th>Ambulatorio (Fecha · Monto)</th>
                <th>Internado (Fecha · Monto)</th>
                <th style="text-align:right;">Total Período</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${directasRows.length > 0 ? `
                <tr class="group-header-row"><td colspan="6">DIRECTAS / OBRAS SOCIALES Y PREPAGAS (${directasRows.length})</td></tr>
                ${renderConsolidatedRows(directasRows)}
                <tr class="subtotal-row">
                  <td colspan="2">SUBTOTAL DIRECTAS</td>
                  <td style="font-family:var(--font-mono);">${formatMoney(dirSum.amb)}</td>
                  <td style="font-family:var(--font-mono);">${formatMoney(dirSum.int)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${formatMoney(dirSum.tot)}</td>
                  <td></td>
                </tr>
              ` : ""}

              ${artRows.length > 0 ? `
                <tr class="group-header-row"><td colspan="6">ART Y SEGUROS (${artRows.length})</td></tr>
                ${renderConsolidatedRows(artRows)}
                <tr class="subtotal-row">
                  <td colspan="2">SUBTOTAL ART Y SEGUROS</td>
                  <td style="font-family:var(--font-mono);">${formatMoney(artSum.amb)}</td>
                  <td style="font-family:var(--font-mono);">${formatMoney(artSum.int)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${formatMoney(artSum.tot)}</td>
                  <td></td>
                </tr>
              ` : ""}

              <tr class="grand-total-row">
                <td colspan="2">TOTAL GENERAL PERÍODO ${escapeHtml(period)}</td>
                <td style="font-family:var(--font-mono);">${formatMoney(dirSum.amb + artSum.amb)}</td>
                <td style="font-family:var(--font-mono);">${formatMoney(dirSum.int + artSum.int)}</td>
                <td style="text-align:right;font-family:var(--font-mono);">${formatMoney(dirSum.tot + artSum.tot)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      ` : `
        <div class="tracker-table-wrap">
          <table class="tracker-table">
            <thead>
              <tr>
                <th>Fecha Envío</th>
                <th>Cód.</th>
                <th>Financiadora</th>
                <th>Área</th>
                <th>Tipo</th>
                <th>Etiqueta / Nota</th>
                <th>Usuario</th>
                <th style="text-align:right;">Importe</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${detalleEnvs.length === 0 ? `
                <tr><td colspan="9" style="text-align:center;padding:28px;color:var(--text-muted);">No hay envíos registrados con estos filtros para el período ${escapeHtml(period)}.</td></tr>
              ` : detalleEnvs.map((ev) => {
                const tMeta = ENVIO_TIPO_META[ev.tipo] || ENVIO_TIPO_META.normal;
                return `
                  <tr>
                    <td style="font-family:var(--font-mono);font-size:12px;">${formatDateAR(ev.fecha_envio)}</td>
                    <td>${ev.os_cod ? `<span class="code-pill">${escapeHtml(ev.os_cod)}</span>` : "—"}</td>
                    <td><strong>${escapeHtml(ev.os_nombre)}</strong></td>
                    <td><span class="badge ${ev.area === "ambulatorio" ? "badge-blue" : "badge-indigo"}">${ev.area === "ambulatorio" ? "Ambulatorio" : "Internado"}</span></td>
                    <td><span class="badge ${tMeta.cls}">${tMeta.label}</span></td>
                    <td style="font-size:12px;color:var(--text-secondary);">
                      ${ev.etiqueta ? `<span class="badge badge-neutral">${escapeHtml(ev.etiqueta)}</span> ` : ""}
                      ${ev.pdf_url ? `<a href="${escapeAttr(ev.pdf_url)}" target="_blank" rel="noopener" class="badge badge-teal" style="text-decoration:none;">📄 PDF</a> ` : ""}
                      ${escapeHtml(ev.observacion || "")}
                    </td>
                    <td style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(ev.created_by || "—")}</td>
                    <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${formatMoney(ev.importe)}</td>
                    <td>
                      <button class="btn btn-xs btn-secondary edit-envio-btn" data-eid="${ev.id}">✏️ Editar</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    `;

    // Bind events
    container.querySelectorAll(".period-jump-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.trackerPeriod = btn.dataset.period;
        document.getElementById("tracker-period").value = state.trackerPeriod;
        renderSeguimientoView();
        renderSidebarList();
        updateNavBadges();
      });
    });

    container.querySelectorAll(".subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.envioSubtab = btn.dataset.subtab;
        renderSeguimientoView();
      });
    });

    const searchInp = document.getElementById("envio-search-input");
    if (searchInp) {
      searchInp.addEventListener("input", (e) => {
        state.envioSearch = e.target.value;
        const pos = e.target.selectionStart;
        renderSeguimientoView();
        const nextInp = document.getElementById("envio-search-input");
        if (nextInp) {
          nextInp.focus();
          nextInp.setSelectionRange(pos, pos);
        }
      });
    }

    container.querySelectorAll(".env-f-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.envioFilter = btn.dataset.ef;
        renderSeguimientoView();
      });
    });

    container.querySelectorAll(".env-area-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.envioAreaFilter = state.envioAreaFilter === btn.dataset.ea ? "all" : btn.dataset.ea;
        renderSeguimientoView();
      });
    });

    container.querySelectorAll(".envio-chip, .edit-envio-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const ev = state.envios.find((x) => x.id === Number(el.dataset.eid));
        if (ev) openEnvioModal(ev);
      });
    });

    container.querySelectorAll(".quick-add-envio-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openEnvioModal(null, {
          id: btn.dataset.fid,
          nombre: btn.dataset.name,
          codigo: btn.dataset.cod,
          categoria: btn.dataset.grp === "art" ? "art" : "obra_social"
        });
      });
    });

    container.querySelectorAll(".tracker-open-fin").forEach((el) => {
      el.addEventListener("click", () => openFinDetail(el.dataset.id));
    });
  }

  function openEnvioModal(envio, prefillFin = null) {
    const isEdit = Boolean(envio);
    document.getElementById("modal-envio-title").textContent = isEdit
      ? `Editar Envío — ${envio.os_nombre}`
      : "Registrar Envío de Facturación";

    document.getElementById("ev-id").value = isEdit ? envio.id : "";
    document.getElementById("ev-fin-id").value = isEdit ? (envio.financiadora_id || "") : (prefillFin ? prefillFin.id : "");
    document.getElementById("ev-period").value = isEdit ? envio.period : state.trackerPeriod;
    document.getElementById("ev-grupo").value = isEdit
      ? (envio.grupo || "directas")
      : (prefillFin && prefillFin.categoria === "art" ? "art" : "directas");
    document.getElementById("ev-nombre").value = isEdit ? envio.os_nombre : (prefillFin ? prefillFin.nombre : "");
    document.getElementById("ev-cod").value = isEdit ? (envio.os_cod || "") : (prefillFin ? (prefillFin.codigo || "") : "");
    document.getElementById("ev-area").value = isEdit ? envio.area : "ambulatorio";
    document.getElementById("ev-tipo").value = isEdit ? (envio.tipo || "normal") : "normal";
    document.getElementById("ev-fecha").value = isEdit ? (envio.fecha_envio || "") : getTodayISO();
    document.getElementById("ev-importe").value = isEdit && envio.importe ? String(envio.importe).replace(".", ",") : "";
    document.getElementById("ev-etiqueta").value = isEdit ? (envio.etiqueta || "") : "";
    document.getElementById("ev-obs").value = isEdit ? (envio.observacion || "") : "";

    const evPreview = document.getElementById("ev-pdf-preview");
    if (isEdit && (envio.pdf_url || parseFacturasJson(envio.facturas_json).length > 0)) {
      const existingFacts = parseFacturasJson(envio.facturas_json);
      state.modalEnvioPdf = {
        pdf_filename: envio.pdf_filename || "Detalle Geclisa.pdf",
        pdf_url: envio.pdf_url || "",
        facturas: existingFacts,
        total_general: Number(envio.importe || 0)
      };
      renderPdfPreviewBox(state.modalEnvioPdf, evPreview, null);
    } else {
      state.modalEnvioPdf = null;
      renderPdfPreviewBox(null, evPreview);
    }

    document.getElementById("btn-delete-envio").classList.toggle("hidden", !(isEdit && isAdmin()));
    openModal("modal-envio");
  }

  async function handleSaveEnvio(e) {
    e.preventDefault();
    const id = document.getElementById("ev-id").value;
    const pdf = state.modalEnvioPdf;
    const payload = {
      period: document.getElementById("ev-period").value,
      financiadora_id: document.getElementById("ev-fin-id").value,
      os_cod: document.getElementById("ev-cod").value.trim(),
      os_nombre: document.getElementById("ev-nombre").value.trim().toUpperCase(),
      grupo: document.getElementById("ev-grupo").value,
      area: document.getElementById("ev-area").value,
      tipo: document.getElementById("ev-tipo").value,
      fecha_envio: document.getElementById("ev-fecha").value,
      importe: document.getElementById("ev-importe").value.trim(),
      etiqueta: document.getElementById("ev-etiqueta").value.trim(),
      observacion: document.getElementById("ev-obs").value.trim(),
      pdf_filename: pdf ? (pdf.pdf_filename || pdf.filename || "") : "",
      pdf_url: pdf ? (pdf.pdf_url || "") : "",
      facturas: pdf ? (pdf.facturas || []) : []
    };

    try {
      if (id) {
        const res = await apiFetch(`/api/envios/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        const idx = state.envios.findIndex((x) => x.id === Number(id));
        if (idx >= 0) state.envios[idx] = res.envio;
        showToast("Envío actualizado correctamente");
      } else {
        const res = await apiFetch("/api/envios", { method: "POST", body: JSON.stringify(payload) });
        state.envios.unshift(res.envio);
        state.trackerPeriod = res.envio.period;
        document.getElementById("tracker-period").value = state.trackerPeriod;
        showToast(`Envío registrado para ${res.envio.os_nombre}`);
      }
      closeModal("modal-envio");
      updateNavBadges();
      renderSidebarList();
      if (state.activeView === "seguimiento") renderSeguimientoView();
      if (state.activeView === "financiadoras") renderFinanciadorasView();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function handleDeleteEnvioFromModal() {
    if (!isAdmin()) return;
    const id = document.getElementById("ev-id").value;
    if (!id || !confirm("¿Eliminar este registro de envío?")) return;
    try {
      await apiFetch(`/api/envios/${id}`, { method: "DELETE" });
      state.envios = state.envios.filter((x) => x.id !== Number(id));
      closeModal("modal-envio");
      updateNavBadges();
      renderSidebarList();
      if (state.activeView === "seguimiento") renderSeguimientoView();
      if (state.activeView === "financiadoras") renderFinanciadorasView();
      showToast("Envío eliminado");
    } catch (err) {
      showToast(err.message);
    }
  }

  function exportEnviosCsv() {
    const period = state.trackerPeriod;
    const envs = getPeriodEnvios(period);
    const rows = [
      ["Período", "Grupo", "Cód. Geclisa", "Financiadora", "Área", "Tipo", "Fecha Envío", "Importe", "Etiqueta", "Observación", "Registrado por"]
    ];
    envs.forEach((e) => {
      rows.push([
        e.period,
        e.grupo.toUpperCase(),
        e.os_cod || "",
        e.os_nombre,
        e.area === "ambulatorio" ? "Ambulatorio" : "Internado",
        (ENVIO_TIPO_META[e.tipo] || ENVIO_TIPO_META.normal).label,
        e.fecha_envio || "",
        String(Number(e.importe || 0).toFixed(2)).replace(".", ","),
        e.etiqueta || "",
        e.observacion || "",
        e.created_by || ""
      ]);
    });
    const sigla = (state.company && state.company.sigla) || "EMPRESA";
    const csv = "\uFEFF" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    downloadFile(`Planilla_Envios_${sigla}_${period}.csv`, csv, "text/csv;charset=utf-8;");
    showToast(`Exportada Planilla_Envios_${sigla}_${period}.csv`);
  }

  // ===================== VIEW 3B: ENVIOS ANDREANI (CORREO POSTAL) =====================
  function renderPostalView() {
    const container = document.getElementById("postal-content");
    const periodSelect = document.getElementById("postal-period-filter");

    const periods = [...new Set([getCurrentYYYYMM(), ...state.postal.map((p) => p.period)])].sort().reverse();
    if (periodSelect) {
      periodSelect.innerHTML = `<option value="all" ${state.postalPeriod === "all" ? "selected" : ""}>Todos los meses (${state.postal.length})</option>` +
        periods.map((p) => {
          const cnt = state.postal.filter((x) => x.period === p).length;
          return `<option value="${p}" ${state.postalPeriod === p ? "selected" : ""}>Mes ${p} (${cnt})</option>`;
        }).join("");
    }

    const baseList = state.postalPeriod === "all"
      ? state.postal
      : state.postal.filter((p) => p.period === state.postalPeriod);

    const entregados = baseList.filter((p) => Boolean(p.fecha_entrega));
    const transito = baseList.filter((p) => !p.fecha_entrega);
    const delays = entregados.map((p) => daysBetween(p.fecha_envio, p.fecha_entrega)).filter((d) => d !== null);
    const avgDays = delays.length ? (delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1).replace(".", ",") : "—";

    const q = normalizeStr(state.postalSearch);
    const filtered = baseList.filter((p) => {
      if (state.postalStatusFilter === "transito" && p.fecha_entrega) return false;
      if (state.postalStatusFilter === "entregado" && !p.fecha_entrega) return false;
      if (q) {
        const hay = normalizeStr(`${p.obra_social} ${p.seguimiento} ${p.medio} ${p.observacion}`);
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--accent-soft);color:var(--accent-text);">📦</div>
          <div>
            <div class="kpi-value">${baseList.length}</div>
            <div class="kpi-label">Envíos postales (${state.postalPeriod === "all" ? "Total" : state.postalPeriod})</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--emerald-bg);color:var(--emerald-text);">✅</div>
          <div>
            <div class="kpi-value">${entregados.length}</div>
            <div class="kpi-label">Entregados</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--amber-bg);color:var(--amber-text);">🚚</div>
          <div>
            <div class="kpi-value">${transito.length}</div>
            <div class="kpi-label">En tránsito / Sin entregar</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-icon" style="background:var(--blue-bg);color:var(--blue-text);">⏱️</div>
          <div>
            <div class="kpi-value">${avgDays} <span style="font-size:12px;font-weight:500;">días</span></div>
            <div class="kpi-label">Demora promedio entrega</div>
          </div>
        </div>
      </div>

      <div class="subtabs-bar">
        <div class="filter-group">
          <button class="chip-sm pos-f-btn ${state.postalStatusFilter === "all" ? "active" : ""}" data-pf="all">Todos (${baseList.length})</button>
          <button class="chip-sm pos-f-btn ${state.postalStatusFilter === "transito" ? "active" : ""}" data-pf="transito">🚚 En tránsito (${transito.length})</button>
          <button class="chip-sm pos-f-btn ${state.postalStatusFilter === "entregado" ? "active" : ""}" data-pf="entregado">✅ Entregados (${entregados.length})</button>
        </div>
        <input type="text" class="inline-search-input" id="postal-search-input" value="${escapeAttr(state.postalSearch)}" placeholder="Buscar obra social o N° seguimiento...">
      </div>

      <div class="tracker-table-wrap">
        <table class="tracker-table">
          <thead>
            <tr>
              <th>Fecha Envío</th>
              <th>Obra Social</th>
              <th>Medio</th>
              <th>N° Seguimiento</th>
              <th>Estado / Fecha Entrega</th>
              <th>Observaciones</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0 ? `
              <tr><td colspan="7" style="text-align:center;padding:28px;color:var(--text-muted);">No hay envíos postales para los filtros seleccionados.</td></tr>
            ` : filtered.map((p) => {
              const days = daysBetween(p.fecha_envio, p.fecha_entrega);
              const isAndreani = (p.medio || "").toUpperCase().includes("ANDREANI");
              const trackUrl = `https://www.andreani.com/#!/informacionEnvio/${encodeURIComponent(p.seguimiento)}`;
              return `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:12px;white-space:nowrap;">${formatDateAR(p.fecha_envio)}</td>
                  <td><strong>${escapeHtml(p.obra_social)}</strong></td>
                  <td><span class="badge badge-neutral">${escapeHtml(p.medio)}</span></td>
                  <td>
                    ${p.seguimiento ? `
                      <div class="tracking-cell">
                        <span class="tracking-code copy-track-btn" data-val="${escapeAttr(p.seguimiento)}" title="Clic para copiar N° seguimiento">${escapeHtml(p.seguimiento)}</span>
                        ${isAndreani ? `<a href="${trackUrl}" target="_blank" rel="noopener" class="btn btn-xs btn-secondary" title="Rastrear en Andreani Online">🔍 Rastrear</a>` : ""}
                      </div>
                    ` : "—"}
                  </td>
                  <td>
                    ${p.fecha_entrega
                      ? `<span class="badge badge-emerald">✅ ${formatDateAR(p.fecha_entrega)}${days !== null ? ` (${days}d)` : ""}</span>`
                      : `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                           <span class="badge badge-amber">🚚 En tránsito</span>
                           <button class="btn btn-xs btn-primary mark-delivered-btn" data-pid="${p.id}" title="Marcar entregado con fecha de hoy">✓ Hoy</button>
                         </div>`}
                  </td>
                  <td style="font-size:12px;color:var(--text-secondary);max-width:240px;">${escapeHtml(p.observacion || "")}</td>
                  <td>
                    <button class="btn btn-xs btn-secondary edit-postal-btn" data-pid="${p.id}">✏️ Editar</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll(".pos-f-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.postalStatusFilter = btn.dataset.pf;
        renderPostalView();
      });
    });

    const pSearch = document.getElementById("postal-search-input");
    if (pSearch) {
      pSearch.addEventListener("input", (e) => {
        state.postalSearch = e.target.value;
        const pos = e.target.selectionStart;
        renderPostalView();
        const nextInp = document.getElementById("postal-search-input");
        if (nextInp) {
          nextInp.focus();
          nextInp.setSelectionRange(pos, pos);
        }
      });
    }

    container.querySelectorAll(".copy-track-btn").forEach((el) => {
      el.addEventListener("click", () => copyText(el.dataset.val, `Seguimiento ${el.dataset.val} copiado`));
    });

    container.querySelectorAll(".mark-delivered-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const p = state.postal.find((x) => x.id === Number(btn.dataset.pid));
        if (!p) return;
        const updated = { ...p, fecha_entrega: getTodayISO() };
        try {
          const res = await apiFetch(`/api/postal/${p.id}`, { method: "PUT", body: JSON.stringify(updated) });
          const idx = state.postal.findIndex((x) => x.id === p.id);
          if (idx >= 0) state.postal[idx] = res.postal;
          updateNavBadges();
          renderPostalView();
          showToast(`${p.obra_social} marcada como entregada hoy`);
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    container.querySelectorAll(".edit-postal-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = state.postal.find((x) => x.id === Number(btn.dataset.pid));
        if (p) openPostalModal(p);
      });
    });
  }

  function openPostalModal(postalObj) {
    const isEdit = Boolean(postalObj);
    document.getElementById("modal-postal-title").textContent = isEdit
      ? `Editar Envío Postal — ${postalObj.obra_social}`
      : "Nuevo Envío Postal (Andreani)";

    const today = getTodayISO();
    document.getElementById("pos-id").value = isEdit ? postalObj.id : "";
    document.getElementById("pos-period").value = isEdit
      ? postalObj.period
      : (state.postalPeriod !== "all" ? state.postalPeriod : today.slice(0, 7));
    document.getElementById("pos-fecha").value = isEdit ? (postalObj.fecha_envio || "") : today;
    document.getElementById("pos-obra").value = isEdit ? postalObj.obra_social : "";
    document.getElementById("pos-medio").value = isEdit ? (postalObj.medio || "ANDREANI") : "ANDREANI";
    document.getElementById("pos-seg").value = isEdit ? (postalObj.seguimiento || "") : "";
    document.getElementById("pos-entrega").value = isEdit ? (postalObj.fecha_entrega || "") : "";
    document.getElementById("pos-obs").value = isEdit ? (postalObj.observacion || "") : "";

    document.getElementById("btn-delete-postal").classList.toggle("hidden", !(isEdit && isAdmin()));
    openModal("modal-postal");
  }

  async function handleSavePostal(e) {
    e.preventDefault();
    const id = document.getElementById("pos-id").value;
    const payload = {
      period: document.getElementById("pos-period").value,
      fecha_envio: document.getElementById("pos-fecha").value,
      obra_social: document.getElementById("pos-obra").value.trim().toUpperCase(),
      medio: document.getElementById("pos-medio").value.trim() || "ANDREANI",
      seguimiento: document.getElementById("pos-seg").value.trim().toUpperCase(),
      fecha_entrega: document.getElementById("pos-entrega").value,
      observacion: document.getElementById("pos-obs").value.trim()
    };

    try {
      if (id) {
        const res = await apiFetch(`/api/postal/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        const idx = state.postal.findIndex((x) => x.id === Number(id));
        if (idx >= 0) state.postal[idx] = res.postal;
        showToast("Envío postal actualizado");
      } else {
        const res = await apiFetch("/api/postal", { method: "POST", body: JSON.stringify(payload) });
        state.postal.unshift(res.postal);
        populateDatalists();
        showToast(`Envío postal registrado (${res.postal.obra_social})`);
      }
      closeModal("modal-postal");
      updateNavBadges();
      renderPostalView();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function handleDeletePostalFromModal() {
    if (!isAdmin()) return;
    const id = document.getElementById("pos-id").value;
    if (!id || !confirm("¿Eliminar este envío postal?")) return;
    try {
      await apiFetch(`/api/postal/${id}`, { method: "DELETE" });
      state.postal = state.postal.filter((x) => x.id !== Number(id));
      closeModal("modal-postal");
      updateNavBadges();
      renderPostalView();
      showToast("Envío postal eliminado");
    } catch (err) {
      showToast(err.message);
    }
  }

  function exportPostalCsv() {
    const list = state.postalPeriod === "all"
      ? state.postal
      : state.postal.filter((p) => p.period === state.postalPeriod);
    const rows = [
      ["Período", "Fecha Envío", "Obra Social", "Medio", "Seguimiento", "Fecha de Entrega", "Observaciones"]
    ];
    list.forEach((p) => {
      rows.push([
        p.period,
        p.fecha_envio || "",
        p.obra_social,
        p.medio,
        p.seguimiento || "",
        p.fecha_entrega || "",
        p.observacion || ""
      ]);
    });
    const sigla = (state.company && state.company.sigla) || "EMPRESA";
    const csv = "\uFEFF" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    downloadFile(`Seguimiento_Andreani_${sigla}_${state.postalPeriod}.csv`, csv, "text/csv;charset=utf-8;");
    showToast(`Exportado Seguimiento_Andreani_${sigla}_${state.postalPeriod}.csv`);
  }

  // ===================== IMPORTADOR EXCEL (.XLS / .XLSX) =====================
  function openImportExcelModal(mode) {
    state.importMode = mode;
    state.importFilesPayload = [];
    state.importSummaries = [];

    document.getElementById("excel-file-input").value = "";
    document.getElementById("import-excel-preview").innerHTML = "";
    document.getElementById("import-excel-options").classList.add("hidden");
    document.getElementById("btn-confirm-import-excel").classList.add("hidden");

    const titleEl = document.getElementById("modal-import-title");
    const hintEl = document.getElementById("import-excel-hint");
    const sigla = (state.company && state.company.sigla) || "";
    if (mode === "envios") {
      titleEl.textContent = `Importar Planillas Mensuales — ${sigla} (.xls / .xlsx)`;
      hintEl.innerHTML = `
        <strong>Importación múltiple para ${escapeHtml(sigla)}</strong>
        <p>Seleccioná una o varias planillas mensuales (<code>.xls</code> o <code>.xlsx</code>). Los envíos se importarán exclusivamente en <strong>${escapeHtml((state.company && state.company.nombre) || sigla)}</strong> sin afectar a las demás empresas.</p>
      `;
    } else {
      titleEl.textContent = `Importar Seguimiento Andreani — ${sigla} (.xls / .xlsx)`;
      hintEl.innerHTML = `
        <strong>Importación automática para ${escapeHtml(sigla)}</strong>
        <p>Subí tu planilla de Andreani (<code>.xls</code> o <code>.xlsx</code>). El sistema lee todas las hojas (<code>ENERO</code>, <code>FEBRERO</code>, etc.) y omite duplicados dentro de <strong>${escapeHtml(sigla)}</strong>.</p>
      `;
    }

    openModal("modal-import-excel");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function handleExcelFilesSelected(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (files.length === 0) {
      showToast("Seleccioná archivos con extensión .xls o .xlsx");
      return;
    }

    const previewEl = document.getElementById("import-excel-preview");
    previewEl.innerHTML = `<p style="color:var(--text-muted);text-align:center;">Analizando ${files.length} planilla(s)...</p>`;
    document.getElementById("btn-confirm-import-excel").classList.add("hidden");

    try {
      const payloadFiles = [];
      for (const f of files) {
        const b64 = await readFileAsDataUrl(f);
        payloadFiles.push({ filename: f.name, content_base64: b64, period_override: "" });
      }
      state.importFilesPayload = payloadFiles;

      const endpoint = state.importMode === "envios" ? "/api/envios/import-excel" : "/api/postal/import-excel";
      const res = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ files: payloadFiles, dry_run: true })
      });
      state.importSummaries = res.summaries || [];
      renderImportExcelPreview();
    } catch (err) {
      previewEl.innerHTML = `<div class="auth-alert">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderImportExcelPreview() {
    const previewEl = document.getElementById("import-excel-preview");
    const optEl = document.getElementById("import-excel-options");
    const confirmBtn = document.getElementById("btn-confirm-import-excel");

    if (state.importSummaries.length === 0) {
      previewEl.innerHTML = `<div class="auth-alert">No se detectaron registros válidos en los archivos seleccionados.</div>`;
      return;
    }

    if (state.importMode === "envios") {
      optEl.classList.remove("hidden");
      document.getElementById("import-replace-wrap").classList.remove("hidden");
      const repCb = document.getElementById("import-replace-existing");
      if (repCb) {
        if (!isAdmin()) {
          repCb.checked = false;
          repCb.disabled = true;
        } else {
          repCb.disabled = false;
        }
      }

      const totalRegs = state.importSummaries.reduce((a, s) => a + s.count, 0);
      const totalMonto = state.importSummaries.reduce((a, s) => a + Number(s.total_general || 0), 0);

      previewEl.innerHTML = `
        <div style="margin-bottom:8px;font-size:13px;">
          <strong>Vista previa:</strong> ${state.importSummaries.length} planilla(s) · <strong>${totalRegs}</strong> envíos · Total: <strong style="color:var(--accent-text);">${formatMoney(totalMonto)}</strong>
        </div>
        <div class="tracker-table-wrap">
          <table class="tracker-table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Período (editable)</th>
                <th>Envíos</th>
                <th style="text-align:right;">Directas</th>
                <th style="text-align:right;">ART</th>
                <th style="text-align:right;">Total Período</th>
              </tr>
            </thead>
            <tbody>
              ${state.importSummaries.map((s, idx) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(s.filename)}</strong>
                    ${s.existing_in_db > 0 ? `<div style="font-size:11px;color:var(--amber-text);">⚠️ Ya existen ${s.existing_in_db} registros en ${escapeHtml(s.period)}</div>` : ""}
                  </td>
                  <td>
                    <input type="month" class="import-period-input" data-idx="${idx}" value="${escapeAttr(s.period)}" style="padding:5px 7px;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-family:inherit;font-weight:600;">
                  </td>
                  <td><span class="badge ${s.count > 0 ? "badge-emerald" : "badge-rose"}">${s.count} reg.</span></td>
                  <td style="text-align:right;font-family:var(--font-mono);font-size:12px;">${formatMoney(s.total_directas)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-size:12px;">${formatMoney(s.total_art)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${formatMoney(s.total_general)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      previewEl.querySelectorAll(".import-period-input").forEach((inp) => {
        inp.addEventListener("change", () => {
          const i = Number(inp.dataset.idx);
          state.importFilesPayload[i].period_override = inp.value;
          state.importSummaries[i].period = inp.value;
        });
      });

      confirmBtn.classList.toggle("hidden", totalRegs === 0);
      confirmBtn.textContent = `✓ Confirmar e Importar (${totalRegs} envíos)`;
    } else {
      optEl.classList.add("hidden");
      const totalRegs = state.importSummaries.reduce((a, s) => a + s.count, 0);
      previewEl.innerHTML = `
        <div style="margin-bottom:8px;font-size:13px;">
          <strong>Vista previa:</strong> ${totalRegs} envíos postales detectados.
        </div>
        <div class="tracker-table-wrap">
          <table class="tracker-table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Hojas / Meses detectados</th>
                <th>Total registros</th>
              </tr>
            </thead>
            <tbody>
              ${state.importSummaries.map((s) => `
                <tr>
                  <td><strong>${escapeHtml(s.filename)}</strong></td>
                  <td>
                    ${(s.sheets || []).map((sh) => `<span class="badge badge-blue" style="margin:2px;">${escapeHtml(sh.sheet)} → ${escapeHtml(sh.period)} (${sh.count})</span>`).join("")}
                  </td>
                  <td><span class="badge badge-emerald">${s.count} reg.</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
      confirmBtn.classList.toggle("hidden", totalRegs === 0);
      confirmBtn.textContent = `✓ Confirmar e Importar (${totalRegs} envíos)`;
    }
  }

  async function confirmImportExcel() {
    const btn = document.getElementById("btn-confirm-import-excel");
    btn.disabled = true;
    btn.textContent = "Importando...";
    try {
      if (state.importMode === "envios") {
        const replace_existing = document.getElementById("import-replace-existing").checked;
        const res = await apiFetch("/api/envios/import-excel", {
          method: "POST",
          body: JSON.stringify({
            files: state.importFilesPayload,
            replace_existing,
            dry_run: false
          })
        });
        state.envios = res.envios || [];
        if (res.periods && res.periods.length > 0) {
          state.trackerPeriod = res.periods[0];
          document.getElementById("tracker-period").value = state.trackerPeriod;
        }
        closeModal("modal-import-excel");
        updateNavBadges();
        renderSidebarList();
        renderSeguimientoView();
        showToast(`Importados ${res.imported} envíos (${(res.periods || []).join(", ")})`);
      } else {
        const res = await apiFetch("/api/postal/import-excel", {
          method: "POST",
          body: JSON.stringify({
            files: state.importFilesPayload,
            dry_run: false
          })
        });
        state.postal = res.postal || [];
        populateDatalists();
        closeModal("modal-import-excel");
        updateNavBadges();
        renderPostalView();
        showToast(`Importados ${res.imported} envíos Andreani${res.skipped ? ` (${res.skipped} duplicados omitidos)` : ""}`);
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ===================== VIEW 2: GUIA GENERAL =====================
  function renderGuiaView() {
    const container = document.getElementById("guia-content");
    const rutas = (state.institution && state.institution.rutas) || [];
    const steps = state.generalGuide || [];

    container.innerHTML = `
      ${rutas.length > 0 ? `
        <div class="paths-banner-grid">
          ${rutas.map((r) => `
            <div class="path-card">
              <div class="path-card-header">
                <strong>📁 ${escapeHtml(r.label)}</strong>
                <button class="btn btn-xs btn-secondary copy-guide-path" data-val="${escapeAttr(r.path)}">Copiar ruta</button>
              </div>
              <code>${escapeHtml(r.path)}</code>
              <p style="margin:0;font-size:12px;color:var(--text-muted);">${escapeHtml(r.desc)}</p>
            </div>
          `).join("")}
        </div>
      ` : ""}

      ${steps.map((s, sIdx) => `
        <div class="guide-step-card">
          <div class="guide-step-head">
            <div class="guide-step-num">${s.numero}</div>
            <div>
              <h3>${escapeHtml(s.titulo)}</h3>
              <p>${escapeHtml(s.subtitulo)} · <code>${escapeHtml(s.ruta)}</code></p>
            </div>
          </div>
          <ol class="guide-steps-ol">
            ${s.pasos.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}
          </ol>
          ${(s.imagenes && s.imagenes.length > 0) ? `
            <div class="img-gallery">
              ${s.imagenes.map((img, iIdx) => `
                <div class="gallery-thumb guide-thumb" data-step="${sIdx}" data-img="${iIdx}">
                  <img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.caption)}" loading="lazy">
                  <div class="gallery-caption">${escapeHtml(img.caption)}</div>
                </div>
              `).join("")}
            </div>
          ` : ""}
        </div>
      `).join("")}
    `;

    container.querySelectorAll(".copy-guide-path").forEach((btn) => {
      btn.addEventListener("click", () => copyText(btn.dataset.val, `Ruta copiada: ${btn.dataset.val}`));
    });

    container.querySelectorAll(".guide-thumb").forEach((thumb) => {
      thumb.addEventListener("click", () => {
        const s = steps[Number(thumb.dataset.step)];
        if (s) openLightbox(s.imagenes, Number(thumb.dataset.img));
      });
    });
  }

  // ===================== VIEW 4: HERRAMIENTAS =====================
  function renderHerramientasView() {
    const inst = state.institution || {};
    const sigla = (state.company && state.company.sigla) || inst.sigla || "";
    const rutas = inst.rutas || [];
    const quickGrid = document.getElementById("institution-quick-grid");
    const items = [
      { label: "Razón Social", val: inst.nombre || "" },
      { label: `CUIT ${sigla} (sin guiones)`, val: inst.cuit || "" },
      { label: `CUIT ${sigla} (con guiones)`, val: inst.cuitGuiones || "" },
      { label: "CUIT Urológico", val: inst.cuitUrologico || "" },
      { label: "Email Principal Facturación", val: inst.emailPrincipal || "" },
      { label: "Clave Email Principal", val: inst.emailPrincipalClave || "", secret: true },
      { label: "Email Auditoría Médica", val: inst.emailAuditoria || "" },
      { label: "Email Contrataciones", val: inst.emailContrataciones || "" },
      { label: "Email Cobranzas", val: inst.emailCobranzas || "" },
      { label: "Email ART", val: inst.emailArt || "" },
      { label: "Email Facturación Institucional", val: inst.emailFacturacion || "" },
      { label: "N° Prestador Swiss Medical", val: inst.prestadorSwiss || "" },
      ...rutas.map((r) => ({ label: r.label, val: r.path }))
    ].filter((x) => x.val);

    quickGrid.innerHTML = items.map((it) => `
      <button type="button" class="quick-data-card" data-copy="${escapeAttr(it.val)}" data-secret="${it.secret ? "1" : "0"}" title="Clic para copiar">
        <div class="quick-data-label">${escapeHtml(it.label)}</div>
        <div class="quick-data-val">${it.secret ? "•••••••• (clic para copiar)" : escapeHtml(it.val)}</div>
      </button>
    `).join("");

    quickGrid.querySelectorAll(".quick-data-card").forEach((card) => {
      card.addEventListener("click", () => {
        const msg = card.dataset.secret === "1" ? "Clave copiada al portapapeles" : `Copiado: ${card.dataset.copy}`;
        copyText(card.dataset.copy, msg);
      });
    });

    const sel = document.getElementById("tool-generator-select");
    const genContainer = document.getElementById("tool-generator-container");
    if (window.ExportTools && sel && sel.options.length === 0) {
      Object.entries(window.ExportTools.GENERATORS).forEach(([key, g]) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = g.title;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => {
        window.ExportTools.renderGeneratorWidget(genContainer, sel.value, copyText, state.institution);
      });
    }
    if (window.ExportTools && sel) {
      window.ExportTools.renderGeneratorWidget(genContainer, sel.value || "omint", copyText, state.institution);
    }

    const txtContainer = document.getElementById("tool-txt-merger");
    if (window.ExportTools && txtContainer && !txtContainer.dataset.initialized) {
      txtContainer.dataset.initialized = "true";
      window.ExportTools.initTxtMerger(txtContainer, (msg, textToCopy) => {
        if (textToCopy) copyText(textToCopy, msg);
        else showToast(msg);
      });
    }
  }

  // ===================== VIEW 5: USUARIOS Y AUDITORIA (ADMIN) =====================
  async function loadAndRenderUsuariosView() {
    if (!isAdmin()) return;
    const container = document.getElementById("usuarios-content");
    container.innerHTML = `<p style="color:var(--text-muted);">Cargando usuarios y auditoría...</p>`;
    try {
      const data = await apiFetch("/api/users", { method: "GET" });
      state.usersList = data.users || [];
      state.adminCompanies = data.companies || state.companies || [];
      state.auditLogs = data.audit || [];
      renderUsuariosView();
    } catch (err) {
      container.innerHTML = `<div class="auth-alert">${escapeHtml(err.message)}</div>`;
    }
  }

  function formatUserRoleBadge(role) {
    if (role === "admin") return `<span class="badge badge-teal">🛡️ Administrador</span>`;
    if (role === "exportacion") return `<span class="badge badge-emerald">🚀 Sector Exportaciones</span>`;
    if (role === "facturista") return `<span class="badge badge-amber">📤 Facturista</span>`;
    return `<span class="badge badge-blue">👁️ Consulta</span>`;
  }

  function formatAllowedCompaniesBadges(u) {
    if (u.role === "admin" || !u.allowed_companies || u.allowed_companies === "*") {
      return `<span class="badge badge-neutral">Todas</span>`;
    }
    const ids = u.allowed_companies.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return ids.map((cid) => {
      const c = (state.adminCompanies || []).find((x) => x.id === cid);
      const cls = cid === "ppsl" ? "badge-indigo" : "badge-teal";
      return `<span class="badge ${cls}">${escapeHtml(c ? c.sigla : cid.toUpperCase())}</span>`;
    }).join(" ");
  }

  function renderUsuariosView() {
    const container = document.getElementById("usuarios-content");
    container.innerHTML = `
      <div class="tracker-table-wrap">
        <table class="tracker-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Nombre Completo</th>
              <th>Rol</th>
              <th>Empresas</th>
              <th>Estado</th>
              <th>Último Acceso</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${state.usersList.map((u) => `
              <tr>
                <td><code>${escapeHtml(u.username)}</code></td>
                <td><strong>${escapeHtml(u.full_name)}</strong></td>
                <td>${formatUserRoleBadge(u.role)}</td>
                <td>${formatAllowedCompaniesBadges(u)}</td>
                <td>
                  <span class="badge ${u.active ? "badge-emerald" : "badge-rose"}">
                    ${u.active ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(u.last_login || "Nunca")}</td>
                <td>
                  <div class="btn-row">
                    <button class="btn btn-xs btn-secondary edit-user-btn" data-uid="${u.id}">✏️ Editar / Clave</button>
                    ${u.id !== state.user.id ? `<button class="btn btn-xs btn-danger-outline del-user-btn" data-uid="${u.id}">🗑️</button>` : ""}
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <h3 class="admin-section-title">📜 Registro de Actividad Reciente (Auditoría)</h3>
      <div class="tracker-table-wrap">
        <table class="tracker-table">
          <thead>
            <tr>
              <th>Fecha y Hora</th>
              <th>Empresa</th>
              <th>Usuario</th>
              <th>Acción</th>
              <th>Objetivo</th>
              <th>Detalle</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            ${state.auditLogs.map((log) => `
              <tr>
                <td style="font-size:12px;white-space:nowrap;">${escapeHtml(log.timestamp)}</td>
                <td>
                  ${log.company_id
                    ? `<span class="badge ${log.company_id === "ppsl" ? "badge-indigo" : "badge-teal"}">${escapeHtml(log.company_id.toUpperCase())}</span>`
                    : `<span class="badge badge-neutral">Sistema</span>`}
                </td>
                <td><strong>${escapeHtml(log.username)}</strong></td>
                <td><span class="audit-action-badge">${escapeHtml(log.action)}</span></td>
                <td>${escapeHtml(log.target)}</td>
                <td style="font-size:12px;color:var(--text-secondary);">${escapeHtml(log.details)}</td>
                <td style="font-size:11.5px;font-family:var(--font-mono);color:var(--text-muted);">${escapeHtml(log.ip || "")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll(".edit-user-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = state.usersList.find((x) => x.id === Number(btn.dataset.uid));
        if (u) openUserModal(u);
      });
    });

    container.querySelectorAll(".del-user-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const u = state.usersList.find((x) => x.id === Number(btn.dataset.uid));
        if (!u || !confirm(`¿Eliminar permanentemente al usuario "${u.username}"?`)) return;
        try {
          await apiFetch(`/api/users/${u.id}`, { method: "DELETE" });
          showToast(`Usuario "${u.username}" eliminado`);
          loadAndRenderUsuariosView();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  }

  function syncUserCompaniesUI() {
    const role = document.getElementById("u-role").value;
    const isAdm = role === "admin";
    document.querySelectorAll("#u-companies-group input[type='checkbox']").forEach((cb) => {
      cb.disabled = isAdm;
      if (isAdm) cb.checked = true;
    });
  }

  function openUserModal(userObj) {
    const isEdit = Boolean(userObj);
    document.getElementById("modal-user-title").textContent = isEdit
      ? `Editar Usuario: ${userObj.username}`
      : "Nuevo Usuario";

    document.getElementById("u-id").value = isEdit ? userObj.id : "";
    const uInput = document.getElementById("u-username");
    uInput.value = isEdit ? userObj.username : "";
    uInput.disabled = isEdit;

    document.getElementById("u-fullname").value = isEdit ? userObj.full_name : "";
    document.getElementById("u-role").value = isEdit ? userObj.role : "facturista";

    const pwdInput = document.getElementById("u-password");
    pwdInput.value = "";
    pwdInput.required = !isEdit;
    document.getElementById("u-password-label").textContent = isEdit
      ? "Nueva contraseña (dejar vacío para mantener la actual)"
      : "Contraseña inicial * (mínimo 6 caracteres)";

    // Checkboxes de empresas habilitadas
    const comps = state.adminCompanies.length > 0 ? state.adminCompanies : state.companies;
    const allowedRaw = isEdit ? (userObj.allowed_companies || "*") : (state.activeCompanyId || "*");
    const allowedSet = allowedRaw === "*"
      ? new Set(comps.map((c) => c.id))
      : new Set(allowedRaw.split(",").map((s) => s.trim().toLowerCase()));

    const grp = document.getElementById("u-companies-group");
    if (grp) {
      grp.innerHTML = comps.map((c) => `
        <label class="check-pill">
          <input type="checkbox" value="${escapeAttr(c.id)}" ${allowedSet.has(c.id) ? "checked" : ""}>
          ${escapeHtml(c.sigla)} — ${escapeHtml(c.nombre)}
        </label>
      `).join("");
    }
    syncUserCompaniesUI();

    document.getElementById("u-active-wrap").classList.toggle("hidden", !isEdit);
    document.getElementById("u-active").checked = isEdit ? Boolean(userObj.active) : true;

    openModal("modal-user");
  }

  async function handleSaveUser(e) {
    e.preventDefault();
    const uid = document.getElementById("u-id").value;
    const isEdit = Boolean(uid);
    const role = document.getElementById("u-role").value;
    const checkedComps = Array.from(document.querySelectorAll("#u-companies-group input:checked")).map((cb) => cb.value);
    if (role !== "admin" && checkedComps.length === 0) {
      showToast("Seleccioná al menos una empresa habilitada");
      return;
    }

    const body = {
      username: document.getElementById("u-username").value.trim(),
      full_name: document.getElementById("u-fullname").value.trim(),
      role,
      allowed_companies: role === "admin" ? "*" : checkedComps,
      password: document.getElementById("u-password").value,
      active: document.getElementById("u-active").checked
    };

    try {
      if (isEdit) {
        await apiFetch(`/api/users/${uid}`, { method: "PUT", body: JSON.stringify(body) });
        showToast("Usuario actualizado correctamente");
      } else {
        await apiFetch("/api/users", { method: "POST", body: JSON.stringify(body) });
        showToast(`Usuario "${body.username}" creado`);
      }
      closeModal("modal-user");
      loadAndRenderUsuariosView();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===================== CRUD MODAL: FINANCIADORAS (ADMIN) =====================
  function openFinModal(fin) {
    const isEdit = Boolean(fin && fin.id);
    const hasPrefill = Boolean(fin);
    document.getElementById("modal-fin-title").textContent = isEdit
      ? `Editar Financiadora: ${fin.nombre}`
      : hasPrefill
        ? `Nueva Financiadora (basada en ${fin.nombre.replace(/ \(COPIA\)$/, "")})`
        : "Nueva Financiadora";

    document.getElementById("f-id").value = isEdit ? fin.id : "";
    document.getElementById("f-codigo").value = hasPrefill ? (fin.codigo || "") : "";
    document.getElementById("f-nombre").value = hasPrefill ? fin.nombre : "";
    document.getElementById("f-categoria").value = hasPrefill ? fin.categoria : "obra_social";
    document.getElementById("f-ambulatorio").value = hasPrefill ? (fin.ambulatorio || "") : "";
    document.getElementById("f-internado").value = hasPrefill ? (fin.internado || "") : "";
    document.getElementById("f-vencimiento").value = hasPrefill ? (fin.vencimiento || "") : "";
    document.getElementById("f-asunto").value = hasPrefill ? (fin.asuntoRegla || "") : "";
    document.getElementById("f-archivos").value = hasPrefill ? (fin.archivos || []).join(", ") : "";
    document.getElementById("f-instrucciones").value = hasPrefill ? (fin.instrucciones || "") : "";

    const canales = hasPrefill ? (fin.canales || []) : ["email"];
    document.querySelectorAll("#f-canales-group input[type='checkbox']").forEach((cb) => {
      cb.checked = canales.includes(cb.value);
    });

    document.getElementById("f-portales-list").innerHTML = "";
    (hasPrefill && fin.portales && fin.portales.length ? fin.portales : []).forEach((p) => addPortalRow(p));

    document.getElementById("f-creds-list").innerHTML = "";
    (hasPrefill && fin.credenciales && fin.credenciales.length ? fin.credenciales : []).forEach((c) => addCredRow(c));

    document.getElementById("f-emails-list").innerHTML = "";
    (hasPrefill && fin.emails && fin.emails.length ? fin.emails : [{ address: "", label: "Facturación" }]).forEach((e) => addEmailRow(e));

    state.formImages = hasPrefill ? JSON.parse(JSON.stringify(fin.imagenes || [])) : [];
    renderFormImages();

    openModal("modal-fin");
  }

  function addPortalRow(data = {}) {
    const list = document.getElementById("f-portales-list");
    const row = document.createElement("div");
    row.className = "dynamic-row";
    row.innerHTML = `
      <input type="text" class="p-label" placeholder="Nombre del portal" value="${escapeAttr(data.label || "")}">
      <input type="url" class="p-url" placeholder="https://..." value="${escapeAttr(data.url || "")}">
      <button type="button" class="btn-icon-sm rm-row-btn" title="Quitar">✕</button>
    `;
    row.querySelector(".rm-row-btn").addEventListener("click", () => row.remove());
    list.appendChild(row);
  }

  function addCredRow(data = {}) {
    const list = document.getElementById("f-creds-list");
    const row = document.createElement("div");
    row.className = "dynamic-row dynamic-row-4";
    row.innerHTML = `
      <input type="text" class="c-label" placeholder="Etiqueta (IMRC)" value="${escapeAttr(data.label || "")}">
      <input type="text" class="c-user" placeholder="Usuario / CUIT" value="${escapeAttr(data.usuario || "")}">
      <input type="text" class="c-pass" placeholder="Contraseña" value="${escapeAttr(data.clave || "")}">
      <input type="text" class="c-extra" placeholder="PIN / Extra (opc.)" value="${escapeAttr(data.extra || "")}">
      <button type="button" class="btn-icon-sm rm-row-btn" title="Quitar">✕</button>
    `;
    row.querySelector(".rm-row-btn").addEventListener("click", () => row.remove());
    list.appendChild(row);
  }

  function addEmailRow(data = {}) {
    const list = document.getElementById("f-emails-list");
    const row = document.createElement("div");
    row.className = "dynamic-row";
    row.innerHTML = `
      <input type="email" class="e-addr" placeholder="correo@obrasocial.com.ar" value="${escapeAttr(data.address || "")}">
      <input type="text" class="e-label" placeholder="Rol (Facturación, Auditoría...)" value="${escapeAttr(data.label || "")}">
      <button type="button" class="btn-icon-sm rm-row-btn" title="Quitar">✕</button>
    `;
    row.querySelector(".rm-row-btn").addEventListener("click", () => row.remove());
    list.appendChild(row);
  }

  function handleFormImageUpload(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        compressImageDataUrl(ev.target.result, 1400, 0.85, (compressed) => {
          state.formImages.push({ src: compressed, caption: file.name.replace(/\.[^.]+$/, "") });
          renderFormImages();
        });
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }

  function compressImageDataUrl(dataUrl, maxWidth, quality, cb) {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
  }

  function renderFormImages() {
    const container = document.getElementById("f-images-list");
    if (state.formImages.length === 0) {
      container.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Sin capturas adjuntas.</span>`;
      return;
    }
    container.innerHTML = state.formImages.map((img, idx) => `
      <div class="form-img-card">
        <img src="${escapeAttr(img.src)}" alt="Preview">
        <button type="button" class="form-img-remove" data-idx="${idx}" title="Quitar imagen">✕</button>
        <input type="text" class="form-img-caption" data-idx="${idx}" value="${escapeAttr(img.caption || "")}" placeholder="Descripción...">
      </div>
    `).join("");

    container.querySelectorAll(".form-img-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.formImages.splice(Number(btn.dataset.idx), 1);
        renderFormImages();
      });
    });

    container.querySelectorAll(".form-img-caption").forEach((inp) => {
      inp.addEventListener("input", () => {
        state.formImages[Number(inp.dataset.idx)].caption = inp.value;
      });
    });
  }

  async function handleSaveFinanciadora(e) {
    e.preventDefault();
    if (!canEditFinanciadoras()) return;
    const existingId = document.getElementById("f-id").value.trim();
    const nombre = document.getElementById("f-nombre").value.trim();
    if (!nombre) return;

    const canales = Array.from(document.querySelectorAll("#f-canales-group input:checked")).map((c) => c.value);
    const archivos = document.getElementById("f-archivos").value.split(",").map((s) => s.trim()).filter(Boolean);
    const portales = Array.from(document.querySelectorAll("#f-portales-list .dynamic-row"))
      .map((r) => ({ label: r.querySelector(".p-label").value.trim() || "Portal Web", url: r.querySelector(".p-url").value.trim() }))
      .filter((p) => p.url);
    const credenciales = Array.from(document.querySelectorAll("#f-creds-list .dynamic-row"))
      .map((r) => ({
        label: r.querySelector(".c-label").value.trim() || "Acceso",
        usuario: r.querySelector(".c-user").value.trim(),
        clave: r.querySelector(".c-pass").value.trim(),
        extra: r.querySelector(".c-extra").value.trim()
      }))
      .filter((c) => c.usuario || c.clave || c.extra);
    const emails = Array.from(document.querySelectorAll("#f-emails-list .dynamic-row"))
      .map((r) => ({ address: r.querySelector(".e-addr").value.trim(), label: r.querySelector(".e-label").value.trim() || "Facturación" }))
      .filter((em) => em.address);

    const payload = {
      codigo: document.getElementById("f-codigo").value.trim(),
      nombre: nombre.toUpperCase(),
      categoria: document.getElementById("f-categoria").value,
      canales,
      archivos,
      ambulatorio: document.getElementById("f-ambulatorio").value.trim(),
      internado: document.getElementById("f-internado").value.trim(),
      vencimiento: document.getElementById("f-vencimiento").value.trim(),
      asuntoRegla: document.getElementById("f-asunto").value.trim(),
      portales,
      credenciales,
      emails,
      instrucciones: document.getElementById("f-instrucciones").value.trim(),
      imagenes: JSON.parse(JSON.stringify(state.formImages))
    };

    try {
      let saved;
      if (existingId) {
        const res = await apiFetch(`/api/financiadoras/${encodeURIComponent(existingId)}`, { method: "PUT", body: JSON.stringify(payload) });
        saved = res.financiadora;
        const idx = state.financiadoras.findIndex((f) => f.id === existingId);
        if (idx >= 0) state.financiadoras[idx] = saved;
        showToast(`"${saved.nombre}" actualizada en el servidor`);
      } else {
        const res = await apiFetch("/api/financiadoras", { method: "POST", body: JSON.stringify(payload) });
        saved = res.financiadora;
        state.financiadoras.push(saved);
        showToast(`"${saved.nombre}" agregada para todo el sector`);
      }
      populateDatalists();
      closeModal("modal-fin");
      state.selectedId = saved.id;
      switchView("financiadoras");
      updateNavBadges();
    } catch (err) {
      showToast(err.message);
    }
  }

  function duplicateFinanciadora(fin) {
    const copy = JSON.parse(JSON.stringify(fin));
    copy.id = "";
    copy.nombre = `${fin.nombre} (COPIA)`;
    openFinModal(copy);
  }

  async function deleteFinanciadora(fin) {
    if (!confirm(`¿Seguro que deseás eliminar "${fin.nombre}" del instructivo?`)) return;
    try {
      await apiFetch(`/api/financiadoras/${encodeURIComponent(fin.id)}`, { method: "DELETE" });
      state.financiadoras = state.financiadoras.filter((f) => f.id !== fin.id);
      state.favorites = state.favorites.filter((id) => id !== fin.id);
      state.selectedId = null;
      populateDatalists();
      renderAll();
      showToast(`"${fin.nombre}" eliminada`);
    } catch (err) {
      showToast(err.message);
    }
  }

  // ===================== BACKUP (ADMIN) =====================
  async function exportBackupJson() {
    try {
      const data = await apiFetch("/api/backup", { method: "GET" });
      const dateStr = new Date().toISOString().slice(0, 10);
      const sigla = (state.company && state.company.sigla) || "IMRC";
      downloadFile(`Backup_Instructivo_${sigla}_${dateStr}.json`, JSON.stringify(data, null, 2), "application/json");
      showToast(`Backup JSON de ${sigla} descargado desde el servidor`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function importBackupJson(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const res = await apiFetch("/api/backup/import", { method: "POST", body: JSON.stringify(parsed) });
        const boot = await fetchBootstrapForCompany(state.activeCompanyId);
        applyBootstrapData(boot);
        closeModal("modal-backup");
        showToast(`Importadas ${res.imported} financiadoras a ${state.company.sigla}`);
      } catch (err) {
        showToast(err.message || "Error importando backup JSON");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ===================== LIGHTBOX & MODALS =====================
  function openLightbox(images, index = 0) {
    if (!images || images.length === 0) return;
    state.lightboxImages = images;
    state.lightboxIndex = index;
    updateLightbox();
    document.getElementById("lightbox").classList.remove("hidden");
  }

  function updateLightbox() {
    const imgObj = state.lightboxImages[state.lightboxIndex];
    if (!imgObj) return;
    document.getElementById("lightbox-img").src = imgObj.src;
    document.getElementById("lightbox-caption").textContent =
      `${imgObj.caption || ""} (${state.lightboxIndex + 1} / ${state.lightboxImages.length})`;
    const multi = state.lightboxImages.length > 1;
    document.getElementById("lightbox-prev").classList.toggle("hidden", !multi);
    document.getElementById("lightbox-next").classList.toggle("hidden", !multi);
  }

  function navLightbox(delta) {
    const len = state.lightboxImages.length;
    if (len <= 1) return;
    state.lightboxIndex = (state.lightboxIndex + delta + len) % len;
    updateLightbox();
  }

  function closeLightbox() {
    document.getElementById("lightbox").classList.add("hidden");
  }

  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
  }

  // ===================== UTILITIES =====================
  function copyText(text, successMsg = "Copiado") {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => fallbackCopy(text, successMsg));
    } else {
      fallbackCopy(text, successMsg);
    }
  }

  function fallbackCopy(text, successMsg) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); showToast(successMsg); }
    catch (_) { showToast("No se pudo copiar automáticamente"); }
    document.body.removeChild(ta);
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showToast(msg) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.25s ease";
      setTimeout(() => toast.remove(), 260);
    }, 3000);
  }

  function normalizeStr(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function escapeHtml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
