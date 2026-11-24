// Herramientas interactivas para el sector de Facturación y Exportación (IMRC)

window.ExportTools = (function () {
  function padLeft(val, len) {
    const clean = String(val || "").replace(/\D/g, "");
    return clean.padStart(len, "0").slice(-len);
  }

  function formatBorealImporte(raw) {
    if (!raw) return "00000000.00";
    const normalized = String(raw).replace(/\s/g, "").replace(",", ".");
    const num = parseFloat(normalized);
    if (isNaN(num)) return "00000000.00";
    const fixed = Math.max(0, num).toFixed(2);
    const [ent, dec] = fixed.split(".");
    return `${ent.padStart(8, "0").slice(-8)}.${dec}`;
  }

  const GENERATORS = {
    omint: {
      title: "OMINT — Nombre de Archivo PDF",
      subtitle: "Formato estricto: F_ + 5 dígitos sucursal + guion + 8 dígitos comprobante",
      fields: [
        { id: "suc", label: "Sucursal / Pto. Venta", placeholder: "Ej: 10", default: "10" },
        { id: "num", label: "N° de Comprobante", placeholder: "Ej: 50806", default: "" }
      ],
      compute: (v) => [
        { label: "Nombre de archivo PDF", value: `F_${padLeft(v.suc, 5)}-${padLeft(v.num, 8)}.pdf` }
      ]
    },
    osde: {
      title: "OSDE — Nombre TXT Ambulatorio",
      subtitle: "Formato: Letra + 5 dígitos sucursal + Letra + 8 dígitos factura + .TXT",
      fields: [
        { id: "letra1", label: "Prefijo", type: "select", options: ["A", "B", "C"], default: "A" },
        { id: "suc", label: "Sucursal", placeholder: "Ej: 10", default: "10" },
        { id: "letra2", label: "Tipo", type: "select", options: ["A", "B", "C"], default: "A" },
        { id: "num", label: "N° de Factura", placeholder: "Ej: 12345", default: "" }
      ],
      compute: (v) => [
        { label: "Nombre de archivo TXT", value: `${v.letra1 || "A"}${padLeft(v.suc, 5)}${v.letra2 || "A"}${padLeft(v.num, 8)}.TXT` }
      ]
    },
    boreal: {
      title: "BOREAL — Formateador de Campos Web",
      subtitle: "Completa automáticamente con ceros según los requisitos del formulario Boreal",
      fields: [
        { id: "suc", label: "Punto de Venta", placeholder: "Ej: 2 o 10", default: "10" },
        { id: "num", label: "N° de Comprobante", placeholder: "Ej: 35", default: "" },
        { id: "imp", label: "Importe ($)", placeholder: "Ej: 25000,50", default: "" }
      ],
      compute: (v, inst) => [
        { label: "CUIT (sin guiones)", value: (inst && inst.cuit) || "30546011980" },
        { label: "Punto de venta (5 díg.)", value: padLeft(v.suc, 5) },
        { label: "N° Comprobante (8 díg.)", value: padLeft(v.num, 8) },
        { label: "Importe (10 pos.)", value: formatBorealImporte(v.imp) }
      ]
    },
    iosfa: {
      title: "IOSFA — Archivo PDF y Asunto de Mail",
      subtitle: "El archivo y el asunto del correo deben llevar el mismo nombre",
      fields: [
        { id: "suc", label: "Sucursal", placeholder: "10", default: "10" },
        { id: "num", label: "N° de Factura", placeholder: "Ej: 50806", default: "" }
      ],
      compute: (v, inst) => {
        const nom = ((inst && inst.nombre) || "instituto médico rio cuarto").toLowerCase().replace(/\s*s\.a\.?$/i, "").trim();
        const base = `${nom} ${v.suc || "10"}-${v.num || "XXXXX"}`;
        return [
          { label: "Nombre de archivo PDF", value: `${base}.pdf` },
          { label: "Asunto del Email", value: base }
        ];
      }
    },
    fedpat: {
      title: "FEDERACION PATRONAL — Asunto de Email",
      subtitle: "Un correo por factura consignando CUIT y número",
      fields: [
        { id: "suc", label: "Sucursal", placeholder: "10", default: "10" },
        { id: "num", label: "N° de Factura", placeholder: "Ej: 50806", default: "" }
      ],
      compute: (v, inst) => [
        { label: "Asunto del Email", value: `CUIT ${(inst && inst.cuit) || "30546011980"} factura ${v.suc || "10"}-${v.num || "XXXXX"}` }
      ]
    },
    swiss: {
      title: "SWISS MEDICAL — Asunto de Email",
      subtitle: "N° de Prestador y período correspondiente",
      fields: [
        { id: "periodo", label: "Período (MM/AAAA)", placeholder: "Ej: 11/2026", default: "" },
        { id: "extra", label: "Detalle opcional", placeholder: "Ej: Ambulatorio / Internados", default: "" }
      ],
      compute: (v, inst) => {
        const ext = v.extra ? ` - ${v.extra}` : "";
        const prest = (inst && inst.prestadorSwiss) || "1592";
        return [
          { label: "Asunto del Email", value: `N° de Prestador ${prest} - Periodo ${v.periodo || "MM/AAAA"}${ext}` }
        ];
      }
    },
    mutual_medica: {
      title: "MUTUAL MEDICA — Asunto de Email",
      subtitle: "Separar ambulatorio e internados indicando período, quincena e importe total",
      fields: [
        { id: "tipo", label: "Modalidad", type: "select", options: ["ambulatorio", "internados"], default: "ambulatorio" },
        { id: "periodo", label: "Período (MM AAAA)", placeholder: "Ej: 11 2026", default: "" },
        { id: "quincena", label: "Quincena", type: "select", options: ["1era quincena", "2da quincena", "mensual"], default: "1era quincena" },
        { id: "importe", label: "Importe Total", placeholder: "Ej: 1206540,54", default: "" }
      ],
      compute: (v) => [
        { label: "Asunto del Email", value: `${v.tipo || "ambulatorio"} / ${v.periodo || "MM AAAA"} / ${v.quincena || "1era quincena"} / $${v.importe || "0,00"}` }
      ]
    },
    la_segunda: {
      title: "LA SEGUNDA (ART / Personas) — Asunto de Email",
      subtitle: "Consignar CUIT y Razón Social exacta",
      fields: [
        { id: "num", label: "N° Factura (opcional)", placeholder: "Opcional", default: "" }
      ],
      compute: (v, inst) => {
        const extra = v.num ? ` - Factura ${v.num}` : "";
        const cuit = (inst && inst.cuit) || "30546011980";
        const nom = (inst && inst.nombre) || "Instituto Medico Rio Cuarto SA";
        return [
          { label: "Asunto del Email", value: `CUIT ${cuit} ${nom}${extra}` }
        ];
      }
    },
    parana: {
      title: "PARANA SEGUROS — Asunto de Email",
      subtitle: "Colocar en el asunto el número de factura enviado",
      fields: [
        { id: "suc", label: "Sucursal", placeholder: "10", default: "10" },
        { id: "num", label: "N° de Factura", placeholder: "Ej: 50806", default: "" }
      ],
      compute: (v) => [
        { label: "Asunto del Email", value: `Factura ${v.suc || "10"}-${v.num || "XXXXX"}` }
      ]
    },
    colegio: {
      title: "COLEGIO MEDICO — Código Internado y Referencia",
      subtitle: "Agrega después de '15358' los últimos 6 dígitos del número de atención",
      fields: [
        { id: "atencion", label: "N° de Atención Paciente", placeholder: "Ej: 987654321", default: "" },
        { id: "mutual", label: "Mutual", placeholder: "Ej: APROSS", default: "" },
        { id: "tipo", label: "Modalidad", type: "select", options: ["amb", "int"], default: "int" },
        { id: "periodo", label: "Período", placeholder: "Ej: 202611", default: "" },
        { id: "pres", label: "N° Presentación", placeholder: "Ej: 161355", default: "" }
      ],
      compute: (v) => {
        const digits = String(v.atencion || "").replace(/\D/g, "");
        const last6 = digits.slice(-6).padStart(6, "0");
        return [
          { label: "Código TXT Internado (15358 + 6 díg.)", value: `15358${last6}` },
          { label: "Referencia de Presentación", value: `${v.mutual || "MUTUAL"} - ${v.tipo || "int"} - ${v.periodo || "AAAAMM"} - ${v.pres || "N°Pres"}` }
        ];
      }
    }
  };

  function getCurrentMonthPeriod() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${m}/${d.getFullYear()}`;
  }

  function renderGeneratorWidget(container, typeKey, onCopy, institution = {}) {
    const gen = GENERATORS[typeKey];
    if (!gen || !container) return;

    const values = {};
    gen.fields.forEach((f) => {
      if (f.id === "periodo" && !f.default) {
        values[f.id] = typeKey === "mutual_medica"
          ? getCurrentMonthPeriod().replace("/", " ")
          : typeKey === "colegio"
            ? `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}`
            : getCurrentMonthPeriod();
      } else {
        values[f.id] = f.default || "";
      }
    });

    container.innerHTML = `
      <div class="gen-card">
        <div class="gen-header">
          <div>
            <h4>${gen.title}</h4>
            <p>${gen.subtitle}</p>
          </div>
          <span class="badge badge-teal">Asistente en vivo</span>
        </div>
        <div class="gen-fields">
          ${gen.fields.map((f) => `
            <div class="gen-field">
              <label>${f.label}</label>
              ${f.type === "select"
                ? `<select data-field="${f.id}">
                    ${f.options.map((opt) => `<option value="${opt}" ${values[f.id] === opt ? "selected" : ""}>${opt}</option>`).join("")}
                   </select>`
                : `<input type="text" data-field="${f.id}" value="${values[f.id]}" placeholder="${f.placeholder || ""}">`
              }
            </div>
          `).join("")}
        </div>
        <div class="gen-outputs"></div>
      </div>
    `;

    const outputsEl = container.querySelector(".gen-outputs");

    function updateOutputs() {
      const results = gen.compute(values, institution || {});
      outputsEl.innerHTML = results.map((r) => `
        <div class="gen-output-row">
          <div>
            <span class="gen-out-label">${r.label}</span>
            <code class="gen-out-val">${escapeHtml(r.value)}</code>
          </div>
          <button type="button" class="btn btn-sm btn-primary copy-gen-btn" data-val="${escapeAttr(r.value)}">
            Copiar
          </button>
        </div>
      `).join("");

      outputsEl.querySelectorAll(".copy-gen-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          onCopy(btn.dataset.val, "Texto formateado copiado");
        });
      });
    }

    container.querySelectorAll("[data-field]").forEach((input) => {
      const evt = input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(evt, (e) => {
        values[e.target.dataset.field] = e.target.value;
        updateOutputs();
      });
    });

    updateOutputs();
  }

  // ===================== UNIFICADOR DE ARCHIVOS TXT =====================
  let txtFilesState = [];

  function initTxtMerger(container, onNotify) {
    if (!container) return;

    function render() {
      const totalLines = txtFilesState.reduce((acc, f) => acc + f.lines, 0);
      const today = new Date();
      const yymmdd = `${String(today.getFullYear()).slice(-2)}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

      container.innerHTML = `
        <div class="tool-panel">
          <div class="tool-panel-header">
            <div>
              <h3>Unificador de Archivos .TXT (Reemplazo Web de Visual Jerárquicos)</h3>
              <p>Unificá múltiples archivos <code>.txt</code> de Jerárquicos, Colegio Médico u otras obras sociales directamente en tu navegador. Los archivos nunca salen de tu PC.</p>
            </div>
          </div>

          <label class="dropzone" id="txt-dropzone">
            <input type="file" id="txt-file-input" accept=".txt,.TXT,.sdf,.SDF" multiple hidden>
            <div class="dropzone-icon">📄</div>
            <div class="dropzone-text">
              <strong>Hacé clic para seleccionar archivos .TXT</strong> o arrastralos y soltalos acá
            </div>
            <span class="dropzone-hint">Podés cargar múltiples archivos a la vez (ej. Fac B 0010-00045998.txt...)</span>
          </label>

          ${txtFilesState.length > 0 ? `
            <div class="txt-summary-bar">
              <div>
                <strong>${txtFilesState.length}</strong> archivo(s) cargado(s) · <strong>${totalLines}</strong> líneas totales
              </div>
              <button type="button" class="btn btn-sm btn-ghost" id="txt-clear-all">Limpiar lista</button>
            </div>

            <div class="txt-file-list">
              ${txtFilesState.map((f, idx) => `
                <div class="txt-file-item">
                  <div class="txt-file-info">
                    <span class="txt-file-idx">${idx + 1}</span>
                    <span class="txt-file-name">${escapeHtml(f.name)}</span>
                    <span class="badge badge-neutral">${f.lines} líneas</span>
                  </div>
                  <button type="button" class="btn-icon-sm txt-remove-btn" data-idx="${idx}" title="Quitar archivo">✕</button>
                </div>
              `).join("")}
            </div>

            <div class="txt-options-row">
              <div class="form-group-inline">
                <label for="txt-output-name">Nombre del archivo resultante:</label>
                <input type="text" id="txt-output-name" value="UNIFICADO_${yymmdd}.txt">
              </div>
              <label class="checkbox-label">
                <input type="checkbox" id="txt-strip-empty" checked>
                Omitir líneas completamente vacías
              </label>
            </div>

            <div class="txt-actions">
              <button type="button" class="btn btn-primary" id="txt-download-btn">
                ⬇ Descargar Archivo .TXT Unificado
              </button>
              <button type="button" class="btn btn-secondary" id="txt-copy-btn">
                📋 Copiar contenido al portapapeles
              </button>
            </div>

            <div class="txt-preview-box">
              <div class="txt-preview-label">Vista previa (primeras 15 líneas):</div>
              <pre id="txt-preview-content"></pre>
            </div>
          ` : ""}
        </div>
      `;

      const input = container.querySelector("#txt-file-input");
      const dropzone = container.querySelector("#txt-dropzone");

      if (input) {
        input.addEventListener("change", (e) => handleFiles(e.target.files));
      }
      if (dropzone) {
        dropzone.addEventListener("dragover", (e) => {
          e.preventDefault();
          dropzone.classList.add("dragover");
        });
        dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
        dropzone.addEventListener("drop", (e) => {
          e.preventDefault();
          dropzone.classList.remove("dragover");
          handleFiles(e.dataTransfer.files);
        });
      }

      container.querySelectorAll(".txt-remove-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          txtFilesState.splice(Number(btn.dataset.idx), 1);
          render();
        });
      });

      const clearBtn = container.querySelector("#txt-clear-all");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          txtFilesState = [];
          render();
        });
      }

      const stripCheckbox = container.querySelector("#txt-strip-empty");
      const previewEl = container.querySelector("#txt-preview-content");

      function buildMergedText() {
        const stripEmpty = stripCheckbox ? stripCheckbox.checked : true;
        const chunks = [];
        txtFilesState.forEach((f) => {
          const lines = f.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
          lines.forEach((line) => {
            if (!stripEmpty || line.trim().length > 0) {
              chunks.push(line);
            }
          });
        });
        return chunks.join("\r\n");
      }

      function updatePreview() {
        if (!previewEl) return;
        const merged = buildMergedText();
        const previewLines = merged.split("\r\n").slice(0, 15);
        previewEl.textContent = previewLines.join("\n") + (merged.split("\r\n").length > 15 ? "\n..." : "");
      }

      if (stripCheckbox) {
        stripCheckbox.addEventListener("change", updatePreview);
      }
      updatePreview();

      const downloadBtn = container.querySelector("#txt-download-btn");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", () => {
          const outName = (container.querySelector("#txt-output-name").value || "UNIFICADO.txt").trim();
          const finalName = outName.toLowerCase().endsWith(".txt") ? outName : `${outName}.txt`;
          const blob = new Blob([buildMergedText()], { type: "text/plain;charset=windows-1252" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = finalName;
          a.click();
          URL.revokeObjectURL(url);
          onNotify(`Archivo ${finalName} generado (${txtFilesState.length} archivos unificados)`);
        });
      }

      const copyBtn = container.querySelector("#txt-copy-btn");
      if (copyBtn) {
        copyBtn.addEventListener("click", () => {
          onNotify("Contenido TXT copiado al portapapeles", buildMergedText());
        });
      }
    }

    async function handleFiles(fileList) {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      for (const file of files) {
        const content = await readFileAsText(file);
        const lines = content.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0).length;
        txtFilesState.push({ name: file.name, content, lines });
      }
      onNotify(`${files.length} archivo(s) cargado(s) correctamente`);
      render();
    }

    function readFileAsText(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result || "");
        reader.readAsText(file, "ISO-8859-1");
      });
    }

    render();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  return {
    GENERATORS,
    renderGeneratorWidget,
    initTxtMerger
  };
})();
