/* astro-stacker frontend — plain JS, no build step, no framework.
 * Talks to the FastAPI backend documented in app/main.py. Keeps all
 * pipeline state (staged nights, exclude selections) derived from the
 * server's /projects/{name}/status rather than tracked independently,
 * so a page reload never gets out of sync with what's actually on disk.
 */

const state = {
  project: null,
  status: null,        // last /projects/{name}/status response
  excludeFrames: new Set(),  // filenames checked for exclusion in Review
};

// ---------- tiny fetch helpers ----------

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const detail = isJson && data && data.detail ? JSON.stringify(data.detail) : String(data);
    throw new Error(`${res.status}: ${detail}`);
  }
  return data;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---------- job polling ----------

async function pollJob(jobId, { progressEl, logViewEl, onDone }) {
  const fill = progressEl ? progressEl.querySelector(".progress-fill") : null;
  const pct = progressEl ? progressEl.querySelector(".pct") : null;
  const msg = progressEl ? progressEl.querySelector(".msg") : null;
  if (progressEl) progressEl.style.display = "block";

  while (true) {
    let snap;
    try {
      snap = await api("GET", `/jobs/${jobId}`);
    } catch (e) {
      if (onDone) onDone({ status: "failed", error: String(e) });
      return;
    }
    const p = snap.percent_complete || 0;
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, p)).toFixed(0)}%`;
    if (pct) pct.textContent = `${p.toFixed(0)}%`;
    if (msg) msg.textContent = snap.current_command ? `[${snap.current_command}] ${snap.current_line || ""}`.slice(0, 90) : (snap.current_line || "").slice(0, 90);
    if (logViewEl) {
      try {
        logViewEl.textContent = await api("GET", `/jobs/${jobId}/log`);
        logViewEl.scrollTop = logViewEl.scrollHeight;
      } catch (_) { /* log may not exist yet */ }
    }
    if (snap.status === "succeeded" || snap.status === "failed") {
      if (onDone) onDone(snap);
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

// ---------- folder browser (for Stage section) ----------

function attachFolderBrowser(inputEl, browseBtn) {
  browseBtn.addEventListener("click", async () => {
    closeAnyBrowser();
    let path = inputEl.value || "";
    const panel = el("div", { class: "card", style: "position:absolute; z-index:50; margin-top:4px; min-width:280px;" }, []);
    document.body.appendChild(panel);
    const rect = browseBtn.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.left = `${rect.left}px`;
    window.__openBrowserPanel = panel;

    async function render() {
      panel.innerHTML = "";
      let data;
      try {
        data = await api("GET", `/captures/browse?path=${encodeURIComponent(path)}`);
      } catch (e) {
        panel.appendChild(el("div", { class: "status-line err" }, [String(e)]));
        return;
      }
      panel.appendChild(el("div", { class: "hint mono" }, [`/${data.path || ""}  (${data.fit_count} .fit files here)`]));
      if (path) {
        panel.appendChild(el("button", { class: "small", onclick: () => { path = path.split("/").slice(0, -1).join("/"); render(); } }, ["← up"]));
      }
      const list = el("div", { style: "margin-top:6px; max-height:220px; overflow-y:auto;" }, []);
      for (const d of data.dirs) {
        list.appendChild(el("div", {
          class: "night-row", style: "cursor:pointer; justify-content:space-between;",
          onclick: () => { path = data.path ? `${data.path}/${d}` : d; render(); },
        }, [d]));
      }
      panel.appendChild(list);
      const actions = el("div", { style: "margin-top:8px; display:flex; gap:8px;" }, [
        el("button", { class: "primary small", onclick: () => { inputEl.value = path; closeAnyBrowser(); } }, ["Use this folder"]),
        el("button", { class: "small ghost", onclick: () => closeAnyBrowser() }, ["Cancel"]),
      ]);
      panel.appendChild(actions);
    }
    render();
  });
}

function closeAnyBrowser() {
  if (window.__openBrowserPanel) {
    window.__openBrowserPanel.remove();
    window.__openBrowserPanel = null;
  }
}
document.addEventListener("click", (e) => {
  if (window.__openBrowserPanel && !window.__openBrowserPanel.contains(e.target) && e.target.dataset.browseBtn === undefined) {
    // clicks on the browse buttons themselves are handled by their own listener
  }
});

// ---------- Stage section ----------

function addNightRow(prefill) {
  const container = document.getElementById("stage-nights");
  const row = el("div", { class: "night-row" }, []);
  const nameInput = el("input", { type: "text", placeholder: "night name (e.g. night1)", value: (prefill && prefill.name) || "" }, []);
  const lightsInput = el("input", { type: "text", class: "dirpick", placeholder: "lights dir (e.g. Night 1/lights)" }, []);
  const flatsInput = el("input", { type: "text", class: "dirpick", placeholder: "flats dir (e.g. Night 1/flats)" }, []);
  const lightsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const flatsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  attachFolderBrowser(lightsInput, lightsBrowse);
  attachFolderBrowser(flatsInput, flatsBrowse);
  const removeBtn = el("button", { type: "button", class: "small ghost", onclick: () => row.remove() }, ["✕"]);
  row.append(nameInput, lightsInput, lightsBrowse, flatsInput, flatsBrowse, removeBtn);
  container.appendChild(row);
}

document.getElementById("add-night-btn").addEventListener("click", () => addNightRow());

document.getElementById("stage-btn").addEventListener("click", async () => {
  if (!state.project) return;
  const rows = Array.from(document.getElementById("stage-nights").children);
  const nights = rows.map((row) => {
    const inputs = row.querySelectorAll("input");
    return { name: inputs[0].value.trim(), lights_dir: inputs[1].value.trim(), flats_dir: inputs[2].value.trim() };
  }).filter((n) => n.name && n.lights_dir && n.flats_dir);

  const body = {
    biases_dir: document.getElementById("biases-dir").value.trim() || null,
    darks_dir: document.getElementById("darks-dir").value.trim() || null,
    nights,
  };
  const resultEl = document.getElementById("stage-result");
  resultEl.textContent = "staging…";
  resultEl.className = "status-line";
  try {
    const res = await api("POST", `/projects/${encodeURIComponent(state.project)}/stage`, body);
    resultEl.textContent = `staged: ${JSON.stringify(res.staged)}`;
    resultEl.className = "status-line ok";
    await loadProjectStatus();
  } catch (e) {
    resultEl.textContent = String(e);
    resultEl.className = "status-line err";
  }
});

// ---------- night checklists (shared pattern) ----------

function renderChecklist(containerId, nights, selected) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!nights.length) {
    container.appendChild(el("span", { class: "empty-hint" }, ["No nights staged yet — use Stage above."]));
    return;
  }
  for (const n of nights) {
    const checked = selected.has(n.name);
    const chip = el("label", { class: `chip${checked ? " checked" : ""}` }, [
      el("input", {
        type: "checkbox", checked: checked ? "checked" : null,
        onchange: (e) => {
          if (e.target.checked) selected.add(n.name); else selected.delete(n.name);
          chip.classList.toggle("checked", e.target.checked);
        },
      }, []),
      document.createTextNode(`${n.name} (${n.light_count})`),
    ]);
    container.appendChild(chip);
  }
}

const mastersSelected = new Set();
const analyzeSelected = new Set();
const stackSelected = new Set();

// ---------- Masters section ----------

function mastersBody() {
  return {
    nights: Array.from(mastersSelected),
    stack: {
      method: document.getElementById("masters-method").value,
      sigma_low: parseFloat(document.getElementById("masters-sigma-low").value) || 3.0,
      sigma_high: parseFloat(document.getElementById("masters-sigma-high").value) || 3.0,
    },
  };
}

document.getElementById("masters-render-btn").addEventListener("click", async () => {
  const view = document.querySelector('[data-log-view="masters"]');
  view.classList.add("open");
  try {
    view.textContent = await api("POST", `/projects/${encodeURIComponent(state.project)}/masters/render`, mastersBody());
  } catch (e) {
    view.textContent = String(e);
  }
});

document.getElementById("masters-run-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("masters-result");
  resultEl.textContent = "starting…";
  resultEl.className = "status-line";
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/masters/run`, mastersBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("masters-progress"),
      logViewEl: document.querySelector('[data-log-view="masters"]'),
      onDone: async (snap) => {
        resultEl.textContent = snap.status === "succeeded" ? "masters built" : `failed: ${snap.error || ""}`;
        resultEl.className = `status-line ${snap.status === "succeeded" ? "ok" : "err"}`;
        await loadProjectStatus();
      },
    });
  } catch (e) {
    resultEl.textContent = String(e);
    resultEl.className = "status-line err";
  }
});

// ---------- Analyze / Review section ----------

function analyzeBody() {
  return {
    nights: Array.from(analyzeSelected),
    exclude_frames: Array.from(state.excludeFrames),
    bin_factor: parseInt(document.getElementById("analyze-bin").value, 10) || 4,
    threshold_sigma: parseFloat(document.getElementById("analyze-threshold").value) || 8.0,
  };
}

function metricStrip(label, frames, key, flaggedKey) {
  const values = frames.map((f) => (typeof f[key] === "number" ? f[key] : 0));
  const max = Math.max(...values, 1e-9);
  const bars = el("div", { class: "metric-bars" }, frames.map((f, i) => {
    const h = Math.max(2, (values[i] / max) * 32);
    const flagged = f.anomaly_z && f.anomaly_z[flaggedKey] !== undefined && f.anomaly_z[flaggedKey] >= 3.0;
    return el("div", { class: `bar${flagged ? " flagged" : ""}`, style: `height:${h}px;`, title: `${f.filename}: ${key}=${values[i]}` }, []);
  }));
  return el("div", { class: "metric-strip" }, [
    el("div", { class: "metric-label" }, [label]),
    bars,
  ]);
}

function frameCard(night, f) {
  // max_size=320 for the review grid — a small thumbnail doesn't need a
  // full-resolution decode+stretch; see app/imaging.py's render_preview_png.
  const previewUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(`raw/nights/${night}/lights/${f.filename}`)}&max_size=320`;
  const checked = state.excludeFrames.has(f.filename);
  const card = el("div", { class: `frame-card${f.flagged ? " flagged" : ""}` }, []);
  // Not loading="lazy": the frame strip scrolls horizontally, and lazy
  // loading only fires once an image nears the *viewport*, not the
  // scroll container — off-screen thumbnails would silently never load
  // until a user happened to scroll to them (confirmed this the hard
  // way: 7/11 stuck "loading" indefinitely until manually scrolled).
  card.appendChild(el("img", { src: previewUrl }, []));
  const meta = el("div", { class: "frame-meta" }, []);
  meta.appendChild(el("div", { class: "frame-name" }, [f.filename]));
  const stats = el("div", { class: "frame-stats" }, []);
  const rows = [
    ["stars", f.star_count],
    ["fwhm", f.fwhm !== null ? f.fwhm.toFixed(2) : "—"],
    ["round", f.roundness !== null ? f.roundness.toFixed(3) : "—"],
    ["snr", f.snr !== null ? f.snr.toFixed(0) : "—"],
  ];
  for (const [k, v] of rows) {
    const isAnom = f.anomaly_z && Object.keys(f.anomaly_z).some((m) => m.startsWith(k.slice(0, 4)) && f.anomaly_z[m] >= 3.0);
    stats.appendChild(el("span", {}, [k]));
    stats.appendChild(el("b", { class: isAnom ? "anom" : "" }, [String(v)]));
  }
  meta.appendChild(stats);
  if (f.flagged) meta.appendChild(el("div", { class: "badge warn", style: "margin-top:6px;" }, ["flagged"]));
  const excludeRow = el("label", { class: "frame-exclude" }, [
    el("input", {
      type: "checkbox", checked: checked ? "checked" : null,
      onchange: (e) => {
        if (e.target.checked) state.excludeFrames.add(f.filename);
        else state.excludeFrames.delete(f.filename);
        refreshExcludeDisplay();
      },
    }, []),
    document.createTextNode("exclude from stack"),
  ]);
  meta.appendChild(excludeRow);
  card.appendChild(meta);
  return card;
}

document.getElementById("analyze-run-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("analyze-result");
  const outputEl = document.getElementById("analyze-output");
  resultEl.textContent = "starting…";
  resultEl.className = "status-line";
  outputEl.innerHTML = "";
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/lights/analyze/run`, analyzeBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("analyze-progress"),
      onDone: async (snap) => {
        if (snap.status !== "succeeded") {
          resultEl.textContent = `failed: ${snap.error || ""}`;
          resultEl.className = "status-line err";
          return;
        }
        resultEl.textContent = "analysis complete";
        resultEl.className = "status-line ok";
        outputEl.innerHTML = "";
        for (const [night, frames] of Object.entries(snap.result.nights)) {
          const flaggedCount = frames.filter((f) => f.flagged).length;
          const block = el("div", { class: "night-block" }, [
            el("h4", {}, [`${night} — ${frames.length} frames, ${flaggedCount} flagged`]),
            metricStrip("star count", frames, "star_count", "star_count"),
            metricStrip("SNR", frames, "snr", "snr"),
            el("div", { class: "frame-strip" }, frames.map((f) => frameCard(night, f))),
          ]);
          outputEl.appendChild(block);
        }
      },
    });
  } catch (e) {
    resultEl.textContent = String(e);
    resultEl.className = "status-line err";
  }
});

// ---------- Stack section ----------

function refreshExcludeDisplay() {
  document.getElementById("exclude-count").textContent = state.excludeFrames.size;
  const listEl = document.getElementById("exclude-list");
  listEl.textContent = state.excludeFrames.size ? Array.from(state.excludeFrames).join(", ") : "none";
}

function stackBody() {
  const body = {
    nights: Array.from(stackSelected),
    stack: {
      method: document.getElementById("stack-method").value,
      sigma_low: parseFloat(document.getElementById("stack-sigma-low").value) || 3.0,
      sigma_high: parseFloat(document.getElementById("stack-sigma-high").value) || 3.0,
    },
    is_osc: document.getElementById("stack-is-osc").checked,
    exclude_frames: Array.from(state.excludeFrames),
  };
  const dark = document.getElementById("stack-master-dark").value.trim();
  const flat = document.getElementById("stack-master-flat").value.trim();
  if (dark) body.master_dark = dark;
  if (flat) body.master_flat = flat;
  return body;
}

document.getElementById("stack-render-btn").addEventListener("click", async () => {
  const view = document.querySelector('[data-log-view="stack"]');
  view.classList.add("open");
  try {
    view.textContent = await api("POST", `/projects/${encodeURIComponent(state.project)}/stack/render`, stackBody());
  } catch (e) {
    view.textContent = String(e);
  }
});

document.getElementById("stack-run-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("stack-result");
  const previewEl = document.getElementById("stack-preview");
  resultEl.textContent = "starting…";
  resultEl.className = "status-line";
  previewEl.innerHTML = "";
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/stack/run`, stackBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("stack-progress"),
      logViewEl: document.querySelector('[data-log-view="stack"]'),
      onDone: async (snap) => {
        resultEl.textContent = snap.status === "succeeded" ? "stack complete" : `failed: ${snap.error || ""}`;
        resultEl.className = `status-line ${snap.status === "succeeded" ? "ok" : "err"}`;
        await loadProjectStatus();
        showStackPreview();
      },
    });
  } catch (e) {
    resultEl.textContent = String(e);
    resultEl.className = "status-line err";
  }
});

function showStackPreview() {
  const previewEl = document.getElementById("stack-preview");
  previewEl.innerHTML = "";
  if (!state.status) return;
  const path = state.status.merged_result_path || (state.status.nights.find((n) => n.result_path) || {}).result_path;
  if (!path) return;
  const url = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(path)}`;
  previewEl.appendChild(el("div", { class: "preview-frame" }, [el("img", { src: `${url}&t=${Date.now()}` }, [])]));
}

// ---------- project load / status ----------

async function loadProjects() {
  const { projects } = await api("GET", "/projects");
  const sel = document.getElementById("project-select");
  const current = sel.value;
  sel.innerHTML = '<option value="">— select —</option>';
  for (const p of projects) sel.appendChild(el("option", { value: p }, [p]));
  if (projects.includes(current)) sel.value = current;
}

async function loadProjectStatus() {
  if (!state.project) return;
  state.status = await api("GET", `/projects/${encodeURIComponent(state.project)}/status`);
  const nights = state.status.nights;

  document.getElementById("stage-status-badge").textContent =
    nights.length ? `${nights.length} night(s) staged` : "not staged";
  document.getElementById("stage-status-badge").className =
    `badge ${nights.length ? "ok" : ""}`;

  renderChecklist("masters-nights", nights, mastersSelected);
  renderChecklist("analyze-nights", nights, analyzeSelected);
  renderChecklist("stack-nights", nights, stackSelected);

  showStackPreview();
}

document.getElementById("project-select").addEventListener("change", async (e) => {
  state.project = e.target.value || null;
  document.getElementById("project-panels").style.display = state.project ? "block" : "none";
  document.getElementById("no-project-hint").style.display = state.project ? "none" : "block";
  mastersSelected.clear();
  analyzeSelected.clear();
  stackSelected.clear();
  state.excludeFrames.clear();
  refreshExcludeDisplay();
  document.getElementById("stage-nights").innerHTML = "";
  addNightRow();
  document.getElementById("analyze-output").innerHTML = "";
  if (state.project) await loadProjectStatus();
});

document.getElementById("create-project-btn").addEventListener("click", async () => {
  const name = document.getElementById("new-project-name").value.trim();
  if (!name) return;
  // A project is "created" the moment it's staged with at least biases/
  // darks — /projects/{name}/stage makes the directory if needed, so just
  // select it here and let Stage below do the actual creation.
  await loadProjects();
  const sel = document.getElementById("project-select");
  if (!Array.from(sel.options).some((o) => o.value === name)) {
    sel.appendChild(el("option", { value: name }, [name]));
  }
  sel.value = name;
  sel.dispatchEvent(new Event("change"));
  document.getElementById("new-project-name").value = "";
});

document.getElementById("refresh-status-btn").addEventListener("click", loadProjectStatus);

// ---------- advanced toggles + log toggles (event delegation) ----------

document.addEventListener("click", (e) => {
  const advToggle = e.target.closest("[data-adv-for]");
  if (advToggle) {
    document.querySelector(`[data-adv="${advToggle.dataset.advFor}"]`).classList.toggle("open");
  }
  const logToggle = e.target.closest("[data-log-for]");
  if (logToggle) {
    document.querySelector(`[data-log-view="${logToggle.dataset.logFor}"]`).classList.toggle("open");
  }
});

// ---------- boot ----------

(async function init() {
  try {
    const health = await api("GET", "/health");
    const badge = document.getElementById("health-badge");
    badge.textContent = health.status === "ok" ? "online" : "error";
    badge.className = `badge ${health.status === "ok" ? "ok" : "danger"}`;
  } catch (e) {
    document.getElementById("health-badge").textContent = "offline";
    document.getElementById("health-badge").className = "badge danger";
  }
  await loadProjects();

  // Deep-link support: #project=name pre-selects a project on load, so a
  // bookmarked/shared link can drop straight into a specific project.
  const match = /project=([^&]+)/.exec(location.hash);
  if (match) {
    const sel = document.getElementById("project-select");
    const name = decodeURIComponent(match[1]);
    if (Array.from(sel.options).some((o) => o.value === name)) {
      sel.value = name;
      sel.dispatchEvent(new Event("change"));
    }
  }
})();
