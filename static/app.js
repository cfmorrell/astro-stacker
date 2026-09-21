/* astro-stacker frontend — plain JS, no build step, no framework.
 * Talks to the FastAPI backend documented in app/main.py. Keeps all
 * pipeline state (staged nights, exclude selections) derived from the
 * server's /projects/{name}/status rather than tracked independently,
 * so a page reload never gets out of sync with what's actually on disk.
 */

const STEPS = ["stage", "masters", "review", "stack"];
const STEP_LABELS = { stage: "File Staging", masters: "Calibration Frames", review: "Review Light Frames", stack: "Stack" };
const LARGE_NIGHT_THRESHOLD = 20; // beyond this, collapse to flagged frames +/- 2 neighbors

const state = {
  project: null,
  status: null,        // last /projects/{name}/status response
  excludeFrames: new Set(),  // filenames checked for exclusion in Review
  activeStep: "stage",
  analyzed: false,      // this-session flag: has an analyze run succeeded since project was selected
  lastAnalyzeResult: null,  // { nights: { name: [FrameStats,...] } }
  showSurvivorsOnly: false,
  expandedGroups: {},   // per-night Set of "start-end" collapsed-group keys the user expanded
  stretchMode: "linked",
  lastAnomalySigma: 3.0,  // the anomaly_sigma actually used for the current lastAnalyzeResult's flags
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

function formatCaptured(iso) {
  // FITS DATE-OBS has no trailing "Z" (e.g. "2026-09-14T00:00:47.585420")
  // but IS UTC per the FITS standard. Appending "Z" before parsing forces
  // the browser to treat it as UTC rather than guessing (engines vary,
  // and guessing wrong silently shows the wrong local time); Date's own
  // toLocale*String methods then do the actual UTC->local conversion.
  if (!iso) return { date: "—", time: "—" };
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (isNaN(d.getTime())) return { date: "—", time: "—" };
  const date = d.toLocaleDateString(undefined, { year: "2-digit", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour12: false });
  return { date, time };
}

function nightDisplayLabel(n) {
  return (n && (n.label || n.name)) || "";
}

function isFrameFlagged(f) {
  // Computed client-side from the raw per-metric z-scores the server
  // already returned, rather than trusting the server's own `flagged`
  // boolean (computed at whatever anomaly_sigma the analyze request
  // used). z-scores themselves don't change with the threshold, so the
  // outlier-sensitivity slider can move live with no re-analyze round
  // trip - matches the server's own "flag if ANY metric crosses it" rule.
  if (!f.anomaly_z) return false;
  return Object.values(f.anomaly_z).some((z) => z >= state.lastAnomalySigma);
}

function setOutcome(el_, ok, msg) {
  // Errors still get a full banner (there's real detail worth reading);
  // success does not — see setStepBadge, which is the "one consistent
  // place completion shows up" Chris asked for, matching Stage's
  // existing top-right badge instead of Masters' old full-width one.
  el_.innerHTML = "";
  if (!ok) {
    el_.appendChild(el("div", { class: "error-banner" }, ["✕ ", msg]));
  }
}

function setStepBadge(badgeId, kind, text) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  badge.textContent = text;
  badge.className = `badge${kind ? ` ${kind}` : ""}`;
}

// ---------- job polling ----------

async function pollJob(jobId, { progressEl, logViewEl, pipelineEl, onDone, lockButtons }) {
  const fill = progressEl ? progressEl.querySelector(".progress-fill") : null;
  const pct = progressEl ? progressEl.querySelector(".pct") : null;
  const msg = progressEl ? progressEl.querySelector(".msg") : null;
  if (progressEl) progressEl.style.display = "block";
  // Disable the triggering run button (and any sibling run buttons named
  // here) for the duration: two overlapping runs against the same project
  // race on the same scratch dirs (Siril still writing into a dir the
  // second run's prepare_fresh_dirs tries to rmtree) and blow up with an
  // unhandled 500 - confirmed this by accident testing back-to-back runs.
  (lockButtons || []).forEach((b) => { b.disabled = true; });

  while (true) {
    let snap;
    try {
      snap = await api("GET", `/jobs/${jobId}`);
    } catch (e) {
      (lockButtons || []).forEach((b) => { b.disabled = false; });
      if (onDone) onDone({ status: "failed", error: String(e) });
      return;
    }
    const p = snap.percent_complete || 0;
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, p)).toFixed(0)}%`;
    if (pct) pct.textContent = `${p.toFixed(0)}%`;
    if (msg) msg.textContent = snap.current_command ? `[${snap.current_command}] ${snap.current_line || ""}` : (snap.current_line || "");
    if (pipelineEl && snap.steps && snap.steps.length) renderPipelineSteps(pipelineEl, snap.steps, snap.current_step_index, snap.status);
    if (logViewEl) {
      try {
        logViewEl.textContent = await api("GET", `/jobs/${jobId}/log`);
        logViewEl.scrollTop = logViewEl.scrollHeight;
      } catch (_) { /* log may not exist yet */ }
    }
    if (snap.status === "succeeded" || snap.status === "failed") {
      (lockButtons || []).forEach((b) => { b.disabled = false; });
      if (onDone) onDone(snap);
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function renderPipelineSteps(container, steps, currentIndex, status) {
  container.style.display = "flex";
  container.innerHTML = "";
  steps.forEach((label, i) => {
    const done = status === "succeeded" || i < currentIndex || (i === currentIndex && status === "succeeded");
    const active = i === currentIndex && status === "running";
    container.appendChild(el("div", { class: `pipeline-step${done ? " done" : ""}${active ? " active" : ""}` }, [
      done ? "✓ " : "",
      `${i + 1}. ${label}`,
    ]));
  });
}

// ---------- toggleable script/log preview buttons ----------

function wireToggleButton(btnId, logKey, fetchFn) {
  const btn = document.getElementById(btnId);
  const arrow = btn.querySelector(".arrow");
  const view = document.querySelector(`[data-log-view="${logKey}"]`);
  let loaded = false;
  btn.addEventListener("click", async () => {
    const isOpen = view.classList.contains("open");
    if (isOpen) {
      view.classList.remove("open");
      arrow.textContent = "▾";
      return;
    }
    if (!loaded) {
      view.textContent = "loading…";
      try {
        view.textContent = await fetchFn();
        loaded = true;
      } catch (e) {
        view.textContent = String(e);
      }
    }
    view.classList.add("open");
    arrow.textContent = "▴";
  });
}

// ---------- folder browser (for Stage section) ----------

function renderBreadcrumb(rootLabel, path, onNavigate) {
  const wrap = el("div", { class: "browser-breadcrumb" }, []);
  const parts = path ? path.split("/") : [];
  wrap.appendChild(el("span", {
    class: `crumb${parts.length ? "" : " current"}`,
    onclick: parts.length ? () => onNavigate("") : null,
  }, [rootLabel]));
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = i === parts.length - 1;
    const target = acc;
    wrap.appendChild(el("span", { class: "crumb-sep" }, ["/"]));
    wrap.appendChild(el("span", {
      class: `crumb${isLast ? " current" : ""}`,
      onclick: isLast ? null : () => onNavigate(target),
    }, [part]));
  });
  return wrap;
}

function attachFolderBrowser(inputEl, browseBtn, onSelect) {
  async function open() {
    closeAnyBrowser();
    let path = inputEl.value || "";
    const panel = el("div", { class: "card", style: "position:fixed; z-index:50; min-width:280px;" }, []);
    document.body.appendChild(panel);
    const rect = browseBtn.getBoundingClientRect();
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
      panel.appendChild(renderBreadcrumb("captures", data.path, (target) => { path = target; render(); }));
      panel.appendChild(el("div", { class: "hint mono" }, [`${data.fit_count} .fit files here`]));
      const list = el("div", { style: "margin-top:6px; max-height:220px; overflow-y:auto;" }, []);
      for (const d of data.dirs) {
        list.appendChild(el("div", {
          class: "night-row", style: "cursor:pointer; justify-content:space-between;",
          onclick: () => { path = data.path ? `${data.path}/${d}` : d; render(); },
        }, [d]));
      }
      panel.appendChild(list);
      const actions = el("div", { style: "margin-top:8px; display:flex; gap:8px;" }, [
        el("button", { class: "primary small", onclick: () => { inputEl.value = path; closeAnyBrowser(); if (onSelect) onSelect(data.detected_type); } }, ["Use this folder"]),
        el("button", { class: "small ghost", onclick: () => closeAnyBrowser() }, ["Cancel"]),
      ]);
      panel.appendChild(actions);
    }
    render();
  }
  // The ellipsis button is the one, unambiguous way to open this picker
  // (matches the "Browse..." convention Siril's own reference tool uses,
  // per Chris) - the field itself is just a read-only display of the
  // current selection, not a second click target for the same action.
  browseBtn.addEventListener("click", open);
}

function closeAnyBrowser() {
  if (window.__openBrowserPanel) {
    window.__openBrowserPanel.remove();
    window.__openBrowserPanel = null;
  }
}

// ---------- project file browser (for Stack's master overrides) ----------

function attachFileBrowser(inputEl, browseBtn, startPath) {
  async function open() {
    closeAnyBrowser();
    let path = startPath;
    const panel = el("div", { class: "card", style: "position:fixed; z-index:50; min-width:280px;" }, []);
    document.body.appendChild(panel);
    const rect = browseBtn.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.left = `${rect.left}px`;
    window.__openBrowserPanel = panel;

    async function render() {
      panel.innerHTML = "";
      let data;
      try {
        data = await api("GET", `/projects/${encodeURIComponent(state.project)}/browse?path=${encodeURIComponent(path)}`);
      } catch (e) {
        panel.appendChild(el("div", { class: "status-line err" }, [String(e)]));
        return;
      }
      panel.appendChild(renderBreadcrumb(state.project, data.path, (target) => { path = target; render(); }));
      const list = el("div", { style: "margin-top:6px; max-height:220px; overflow-y:auto;" }, []);
      for (const d of data.dirs) {
        list.appendChild(el("div", {
          class: "night-row", style: "cursor:pointer; justify-content:space-between;",
          onclick: () => { path = data.path ? `${data.path}/${d}` : d; render(); },
        }, [`📁 ${d}`]));
      }
      for (const f of data.files) {
        list.appendChild(el("div", {
          class: "night-row", style: "cursor:pointer; justify-content:space-between;",
          onclick: () => { inputEl.value = f.abs_path; closeAnyBrowser(); },
        }, [f.name]));
      }
      panel.appendChild(list);
      const actions = el("div", { style: "margin-top:8px; display:flex; gap:8px;" }, [
        el("button", { class: "small ghost", onclick: () => { inputEl.value = ""; closeAnyBrowser(); } }, ["✕ Clear (use default)"]),
        el("button", { class: "small ghost", onclick: () => closeAnyBrowser() }, ["Cancel"]),
      ]);
      panel.appendChild(actions);
    }
    render();
  }
  // Same "one obvious way in" reasoning as attachFolderBrowser above.
  browseBtn.addEventListener("click", open);
}

// ---------- Stage section ----------

function nextNightNumber() {
  // Continue after whatever's already staged rather than always starting
  // from 1, so adding a session after removing one can't collide with a
  // night that's still there (e.g. night1 stays, night2 gets removed,
  // a new session becomes night3, not a second "night2").
  const existing = (state.status ? state.status.nights : [])
    .map((n) => parseInt(n.name.replace(/^night/, ""), 10))
    .filter((x) => !isNaN(x));
  return (existing.length ? Math.max(...existing) : 0) + 1;
}

function renderExistingStagedNights() {
  const container = document.getElementById("stage-existing-nights");
  container.innerHTML = "";
  const nights = state.status ? state.status.nights : [];
  if (!nights.length) {
    container.appendChild(el("span", { class: "empty-hint" }, ["None staged yet."]));
    return;
  }
  for (const n of nights) {
    container.appendChild(el("div", { class: "night-row", style: "justify-content:space-between;" }, [
      el("span", {}, [`${nightDisplayLabel(n)} — ${n.light_count} lights, ${n.flat_count} flats`]),
      el("button", {
        type: "button", class: "small danger-outline",
        onclick: async () => {
          if (!confirm(`Remove ${nightDisplayLabel(n)}? This deletes its staged files and any built master flat for it. Cannot be undone.`)) return;
          try {
            await api("DELETE", `/projects/${encodeURIComponent(state.project)}/nights/${encodeURIComponent(n.name)}`);
            await loadProjectStatus();
          } catch (e) {
            alert(`Remove failed: ${e}`);
          }
        },
      }, ["✕ Remove"]),
    ]));
  }
}

function addNightRow() {
  const container = document.getElementById("stage-nights");
  // Continue after whatever's already staged, not just count draft rows
  // in this form: opening a project that already has night1/night2
  // staged should offer "Session 3" for a new one, not restart at 1.
  const sessionNum = nextNightNumber() + container.children.length;
  const row = el("div", { class: "night-row" }, []);
  const label = el("span", { class: "session-label" }, [`Session ${sessionNum}`]);
  // A persistent "Lights"/"Flats" label above each field, not just
  // placeholder text: placeholder text disappears the moment a folder is
  // picked (readonly inputs show the selected path, not a hint anymore),
  // which was the whole problem - nothing left on screen said which side
  // was which once both were filled in.
  const lightsInput = el("input", { type: "text", class: "dirpick", placeholder: "e.g. Night 1/lights", readonly: "readonly" }, []);
  const flatsInput = el("input", { type: "text", class: "dirpick", placeholder: "e.g. Night 1/flats", readonly: "readonly" }, []);
  const lightsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const flatsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const mismatchWarning = el("div", { class: "session-mismatch-warning", style: "display:none;" }, []);
  let lightsDetectedType = null;
  let flatsDetectedType = null;
  // Not a hard block - Chris explicitly wants these catchable but still
  // possible (e.g. deliberately reusing one night's flats for another, or
  // unusual filenames that don't include a type keyword). Combines two
  // independent checks into one message so picking either field
  // re-evaluates both without stacking multiple warning lines:
  // 1) same parent folder = same session, matching how a real capture
  //    folder is normally laid out (Night 1/{lights,flats}) - catches a
  //    misclick like night1 lights + night2 flats;
  // 2) the folder's filenames actually look like the type being picked
  //    for (most capture software puts "Light"/"Flat"/etc. right in the
  //    name - see _detect_frame_type() in app/main.py).
  function updateSessionWarnings() {
    const messages = [];
    const lightsParent = lightsInput.value ? lightsInput.value.split("/").slice(0, -1).join("/") : "";
    const flatsParent = flatsInput.value ? flatsInput.value.split("/").slice(0, -1).join("/") : "";
    if (lightsParent && flatsParent && lightsParent !== flatsParent) {
      messages.push("Lights and flats look like they're from different sessions.");
    }
    if (lightsDetectedType && lightsDetectedType !== "light") {
      messages.push(`The lights folder looks like it contains ${lightsDetectedType === "mixed" ? "a mix of frame types" : `${lightsDetectedType} frames`}, not lights.`);
    }
    if (flatsDetectedType && flatsDetectedType !== "flat") {
      messages.push(`The flats folder looks like it contains ${flatsDetectedType === "mixed" ? "a mix of frame types" : `${flatsDetectedType} frames`}, not flats.`);
    }
    if (messages.length) {
      mismatchWarning.textContent = "⚠ " + messages.join(" ") + " Double check you picked the right folders.";
      mismatchWarning.style.display = "block";
    } else {
      mismatchWarning.style.display = "none";
    }
  }
  attachFolderBrowser(lightsInput, lightsBrowse, (detectedType) => { lightsDetectedType = detectedType; updateSessionWarnings(); });
  attachFolderBrowser(flatsInput, flatsBrowse, (detectedType) => { flatsDetectedType = detectedType; updateSessionWarnings(); });
  const lightsGroup = el("div", { class: "dirpick-group" }, [
    el("span", { class: "dirpick-label" }, ["Lights"]),
    el("div", { class: "dirpick-row" }, [lightsInput, lightsBrowse]),
  ]);
  const flatsGroup = el("div", { class: "dirpick-group" }, [
    el("span", { class: "dirpick-label" }, ["Flats"]),
    el("div", { class: "dirpick-row" }, [flatsInput, flatsBrowse]),
  ]);
  const removeBtn = el("button", { type: "button", class: "small ghost", onclick: () => { row.remove(); renumberSessions(); } }, ["✕"]);
  row.append(label, lightsGroup, flatsGroup, removeBtn, mismatchWarning);
  container.appendChild(row);
}

function renumberSessions() {
  const base = nextNightNumber();
  const rows = document.getElementById("stage-nights").children;
  Array.from(rows).forEach((row, i) => {
    row.querySelector(".session-label").textContent = `Session ${base + i}`;
  });
}

document.getElementById("add-night-btn").addEventListener("click", () => addNightRow());
function warnIfWrongType(expected, detectedType, warningEl) {
  if (detectedType && detectedType !== expected) {
    const what = detectedType === "mixed" ? "a mix of frame types, not consistently" : `${detectedType} frames, not`;
    warningEl.textContent = `⚠ This folder's filenames look like ${what} ${expected}s — double check you picked the right folder.`;
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }
}

attachFolderBrowser(document.getElementById("biases-dir"), document.getElementById("biases-browse"), (detectedType) => {
  warnIfWrongType("bias", detectedType, document.getElementById("biases-type-warning"));
});
attachFolderBrowser(document.getElementById("darks-dir"), document.getElementById("darks-browse"), (detectedType) => {
  warnIfWrongType("dark", detectedType, document.getElementById("darks-type-warning"));
});

document.getElementById("stage-btn").addEventListener("click", async () => {
  if (!state.project) return;
  let nextNum = nextNightNumber();
  const rows = Array.from(document.getElementById("stage-nights").children);
  const nights = rows
    .map((row) => {
      const inputs = row.querySelectorAll("input");
      return { lights_dir: inputs[0].value.trim(), flats_dir: inputs[1].value.trim() };
    })
    .filter((n) => n.lights_dir && n.flats_dir)
    .map((n) => ({ ...n, name: `night${nextNum++}` }));

  const body = {
    biases_dir: document.getElementById("biases-dir").value.trim() || null,
    darks_dir: document.getElementById("darks-dir").value.trim() || null,
    nights,
    is_osc: document.getElementById("stage-is-osc").checked,
  };
  const summaryEl = document.getElementById("stage-summary");
  summaryEl.innerHTML = "";
  summaryEl.appendChild(el("div", { class: "status-line" }, ["staging…"]));
  try {
    const res = await api("POST", `/projects/${encodeURIComponent(state.project)}/stage`, body);
    renderStageSummary(res.staged);
    await loadProjectStatus();
  } catch (e) {
    setOutcome(summaryEl, false, String(e));
  }
});

function renderStageSummary(staged) {
  const summaryEl = document.getElementById("stage-summary");
  summaryEl.innerHTML = "";
  const rows = [];
  if (staged.biases !== undefined) rows.push(`Biases — ${staged.biases} frames`);
  if (staged.darks !== undefined) rows.push(`Darks — ${staged.darks} frames`);
  if (staged.nights) {
    Object.entries(staged.nights).forEach(([name, counts], i) => {
      rows.push(`Session ${i + 1} (${name}) — ${counts.lights} lights, ${counts.flats} flats`);
    });
  }
  const wrap = el("div", { class: "stage-summary" }, []);
  for (const r of rows) {
    wrap.appendChild(el("div", { class: "stage-summary-row" }, [el("span", { class: "ok-dot" }, ["✓"]), r]));
  }
  summaryEl.appendChild(wrap);
}

// ---------- night checklists (shared pattern) ----------

function renderChecklist(containerId, nights, selected, countFn) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!nights.length) {
    container.appendChild(el("span", { class: "empty-hint" }, ["No nights staged yet — use Stage above."]));
    return;
  }
  const count = countFn || ((n) => n.light_count);
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
      document.createTextNode(`${nightDisplayLabel(n)} (${count(n)})`),
    ]);
    container.appendChild(chip);
  }
}

function survivorCountForNight(n) {
  const analyzed = state.lastAnalyzeResult && state.lastAnalyzeResult.nights[n.name];
  if (!analyzed) return n.light_count;
  const excluded = analyzed.filter((f) => state.excludeFrames.has(f.filename)).length;
  return analyzed.length - excluded;
}

function refreshStackNightsChecklist() {
  if (!state.status) return;
  renderChecklist("stack-nights", state.status.nights, stackSelected, survivorCountForNight);
}

const mastersSelected = new Set();
const analyzeSelected = new Set();
const stackSelected = new Set();

// ---------- Masters section ----------

function renderMastersPreviews() {
  const container = document.getElementById("masters-previews");
  container.innerHTML = "";
  if (!state.status) return;
  const items = [];
  if (state.status.master_bias_built) items.push({ label: "Master Bias", path: "process/master_bias.fit" });
  if (state.status.master_dark_built) items.push({ label: "Master Dark", path: "process/master_dark.fit" });
  for (const n of state.status.nights) {
    if (n.master_flat_built) {
      items.push({ label: `Master Flat — ${nightDisplayLabel(n)}`, path: `process/nights/${n.name}/master_flat.fit` });
    }
  }
  if (!items.length) return;
  // Master bias/dark/flat are never debayered by Siril (only light
  // calibration gets -cfa/-debayer - see Handoff.md), so they're still a
  // raw Bayer mosaic same as an unstaged raw light; debayer them here the
  // same way for a real look rather than grainy grayscale. "unlinked"
  // (independent per-channel percentile+asinh) rather than "none": Chris
  // asked for it specifically to actually see what these calibration
  // frames look like - same reasoning as review's raw-light thumbnails,
  // which are unbalanced straight off the sensor and need a per-channel
  // stretch to look like more than a flat color wash.
  const debayer = state.status.is_osc ? "&debayer=1" : "";
  for (const item of items) {
    const thumbUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(item.path)}&max_size=220&stretch=unlinked${debayer}`;
    const largeUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(item.path)}&max_size=1600&stretch=unlinked${debayer}`;
    container.appendChild(el("div", { class: "master-preview-card" }, [
      el("img", { src: thumbUrl, onclick: () => openPlainLightbox(largeUrl, item.label) }, []),
      el("div", { class: "master-preview-label" }, [item.label]),
    ]));
  }
}

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

wireToggleButton("masters-render-btn", "masters", () =>
  api("POST", `/projects/${encodeURIComponent(state.project)}/masters/render`, mastersBody())
);

document.getElementById("masters-run-btn").addEventListener("click", async () => {
  const runBtn = document.getElementById("masters-run-btn");
  const resultEl = document.getElementById("masters-result");
  resultEl.innerHTML = "";
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  runBtn.disabled = true;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/masters/run`, mastersBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("masters-progress"),
      logViewEl: document.querySelector('[data-log-view="masters"]'),
      lockButtons: [runBtn],
      onDone: async (snap) => {
        if (snap.status === "succeeded") setStepBadge("masters-status-badge", "ok", "masters built");
        else setOutcome(resultEl, false, `Failed: ${snap.error || ""}`);
        await loadProjectStatus();
      },
    });
  } catch (e) {
    runBtn.disabled = false;
    setOutcome(resultEl, false, String(e));
  }
});

document.getElementById("stage-next-btn").addEventListener("click", () => { state.activeStep = "masters"; showActiveStep(); });
document.getElementById("masters-next-btn").addEventListener("click", () => { state.activeStep = "review"; showActiveStep(); });
document.getElementById("review-next-btn").addEventListener("click", () => { state.activeStep = "stack"; showActiveStep(); });

// ---------- Analyze / Review section ----------

function analyzeBody() {
  return {
    nights: Array.from(analyzeSelected),
    exclude_frames: Array.from(state.excludeFrames),
    bin_factor: parseInt(document.getElementById("analyze-bin").value, 10) || 4,
    threshold_sigma: parseFloat(document.getElementById("analyze-threshold").value) || 8.0,
    anomaly_sigma: parseFloat(document.getElementById("analyze-anomaly-sigma").value) || 3.0,
  };
}

function metricStrip(label, frames, key, subKey, anomalySigma) {
  if (frames.length === 0) {
    return el("div", { class: "metric-strip" }, [el("div", { class: "metric-label" }, [label]), el("div", { class: "hint" }, ["no surviving frames"])]);
  }
  const values = frames.map((f) => (typeof f[key] === "number" ? f[key] : 0));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Scale bars to the metric's own min..max range, not 0..max: two FWHM
  // values like 4.62 and 4.69 are indistinguishable as bars sized against
  // a 0-based axis, but scaling to the actual observed range makes real
  // (if small) differences visible - which is also just what the bars are
  // for now that flagging is a separate, tunable z-score (see the anomaly
  // sigma input) rather than something to infer by eye from bar height.
  const span = hi - lo || 1;
  const bars = el("div", { class: "metric-bars" }, frames.map((f, i) => {
    const h = Math.max(3, ((values[i] - lo) / span) * 68 + 4);
    const flagged = f.anomaly_z && f.anomaly_z[subKey] !== undefined && f.anomaly_z[subKey] >= anomalySigma;
    const { date, time } = formatCaptured(f.captured_at);
    return el("div", { class: `bar${flagged ? " flagged" : ""}`, style: `height:${h}px;`, title: `${f.filename} (${date} ${time}): ${key}=${values[i]}` }, []);
  }));
  const axis = el("div", { class: "metric-axis" }, [
    el("span", {}, [hi.toFixed(2)]),
    el("span", {}, [lo.toFixed(2)]),
  ]);
  const firstTime = formatCaptured(frames[0].captured_at).time;
  const lastTime = formatCaptured(frames[frames.length - 1].captured_at).time;
  const xAxis = el("div", { class: "metric-xaxis" }, [
    el("span", {}, [firstTime]),
    el("span", {}, [lastTime]),
  ]);
  const barsWrap = el("div", { class: "metric-bars-wrap" }, [bars, xAxis]);
  return el("div", { class: "metric-strip" }, [
    el("div", { class: "metric-label" }, [label]),
    el("div", { class: "metric-strip-body" }, [axis, barsWrap]),
  ]);
}

let lightboxZoomed = false;
// Set only while browsing review frames (via openLightboxForFrame) so the
// prev/next arrows and exclude checkbox know what they're navigating;
// null for a plain open (e.g. the final stack preview), which has neither.
let lightboxNav = null;

function frameStatsLine(f) {
  return `Stars: ${f.star_count}, FWHM: ${f.fwhm !== null ? f.fwhm.toFixed(2) : "—"}, `
    + `Eccentricity: ${f.roundness !== null ? f.roundness.toFixed(3) : "—"}, SNR: ${f.snr !== null ? f.snr.toFixed(0) : "—"}`;
}

function frameLightboxUrl(night, f) {
  const debayer = state.status && state.status.is_osc ? "&debayer=1" : "";
  return `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(`raw/nights/${night}/lights/${f.filename}`)}&max_size=1600&stretch=unlinked${debayer}`;
}

function openLightbox(url, title, { stats, indicator } = {}) {
  const img = document.getElementById("lightbox-img");
  const scroll = document.getElementById("lightbox-scroll");
  img.src = url;
  lightboxZoomed = false;
  scroll.classList.remove("zoomed");
  scroll.scrollTop = 0;
  scroll.scrollLeft = 0;
  const captionEl = document.getElementById("lightbox-caption");
  captionEl.className = `lightbox-caption${indicator ? ` ${indicator}` : ""}`;
  captionEl.innerHTML = "";
  captionEl.appendChild(el("div", { class: "lightbox-caption-title" }, [title]));
  if (stats) captionEl.appendChild(el("div", { class: "lightbox-caption-stats" }, [stats]));
  document.getElementById("lightbox").classList.add("open");
}

function openPlainLightbox(url, title) {
  // For anything with no frame list to navigate and no exclusion to
  // toggle (the final stack preview, a master bias/dark/flat preview) -
  // resets the nav arrows/exclude row explicitly, since a plain
  // openLightbox() call doesn't touch them and they'd otherwise be left
  // over from whatever was last shown (e.g. a review frame).
  lightboxNav = null;
  document.getElementById("lightbox-exclude-row").style.display = "none";
  document.getElementById("lightbox-prev").classList.add("hidden");
  document.getElementById("lightbox-next").classList.add("hidden");
  openLightbox(url, title);
}

function currentLightboxFrames() {
  // Recomputed fresh every call from live state, never cached: the old
  // version snapshotted this array once at open time, so toggling
  // survivors-only or excluding the very frame being viewed left the
  // prev/next arrows navigating a list that no longer matched what was
  // actually on screen.
  if (!lightboxNav || !state.lastAnalyzeResult) return [];
  const allFrames = state.lastAnalyzeResult.nights[lightboxNav.night] || [];
  return state.showSurvivorsOnly ? allFrames.filter((f) => !state.excludeFrames.has(f.filename)) : allFrames;
}

function renderLightboxFrame() {
  const frames = currentLightboxFrames();
  let index = frames.findIndex((f) => f.filename === lightboxNav.filename);
  if (index === -1) {
    // The frame we were on dropped out of the live list (e.g.
    // survivors-only just got switched on and this was the frame that
    // got excluded) - land on the nearest neighbor instead of just
    // breaking, or close if the night has nothing left to show.
    if (!frames.length) {
      document.getElementById("lightbox").classList.remove("open");
      return;
    }
    index = Math.min(lightboxNav.lastIndex, frames.length - 1);
    lightboxNav.filename = frames[index].filename;
  }
  lightboxNav.lastIndex = index;
  const f = frames[index];
  const { date, time } = formatCaptured(f.captured_at);
  openLightbox(frameLightboxUrl(lightboxNav.night, f), `${f.filename} — ${date} ${time}`, {
    stats: frameStatsLine(f),
    indicator: isFrameFlagged(f) ? "flagged" : "ok",
  });
  document.getElementById("lightbox-exclude-row").style.display = "flex";
  document.getElementById("lightbox-exclude").checked = state.excludeFrames.has(f.filename);
  document.getElementById("lightbox-prev").classList.toggle("hidden", index <= 0);
  document.getElementById("lightbox-next").classList.toggle("hidden", index >= frames.length - 1);
}

function openLightboxForFrame(night, frames, index) {
  lightboxNav = { night, filename: frames[index].filename, lastIndex: index };
  renderLightboxFrame();
}

document.getElementById("lightbox").addEventListener("click", () => {
  document.getElementById("lightbox").classList.remove("open");
});
document.getElementById("lightbox-prev").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!lightboxNav) return;
  const frames = currentLightboxFrames();
  const index = frames.findIndex((f) => f.filename === lightboxNav.filename);
  if (index <= 0) return;
  lightboxNav.filename = frames[index - 1].filename;
  renderLightboxFrame();
});
document.getElementById("lightbox-next").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!lightboxNav) return;
  const frames = currentLightboxFrames();
  const index = frames.findIndex((f) => f.filename === lightboxNav.filename);
  if (index === -1 || index >= frames.length - 1) return;
  lightboxNav.filename = frames[index + 1].filename;
  renderLightboxFrame();
});
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("lightbox").classList.contains("open")) return;
  if (e.key === "ArrowLeft") document.getElementById("lightbox-prev").click();
  else if (e.key === "ArrowRight") document.getElementById("lightbox-next").click();
  else if (e.key === "Escape") document.getElementById("lightbox").classList.remove("open");
});
document.getElementById("lightbox-exclude-row").addEventListener("click", (e) => e.stopPropagation());
document.getElementById("lightbox-exclude").addEventListener("change", (e) => {
  if (!lightboxNav) return;
  if (e.target.checked) state.excludeFrames.add(lightboxNav.filename);
  else state.excludeFrames.delete(lightboxNav.filename);
  refreshExcludeDisplay();
  // Rebuilds the review grid behind the (still-open) lightbox, including
  // the matching frame-card's own checkbox/border - scroll position
  // (both the page and the per-night horizontal strip) is already
  // preserved by renderAnalyzeOutput/frameCard's own handling of this.
  renderAnalyzeOutput();
  // If survivors-only is on, excluding the frame just now may have
  // dropped it from the live list entirely - refresh the lightbox itself
  // so the arrows/checkbox reflect wherever that lands (a neighbor, or
  // closing if nothing's left), per currentLightboxFrames() above.
  renderLightboxFrame();
});
document.getElementById("lightbox-scroll").addEventListener("click", (e) => {
  // Toggle zoom instead of letting the click bubble to the overlay's
  // close handler - zooming in to actually inspect a frame is the whole
  // point of clicking into it (Chris: "I should be able to zoom in to
  // look closely"). Re-centers the scroll on the click point so zooming
  // in lands roughly where the user clicked, not the top-left corner.
  e.stopPropagation();
  const scroll = e.currentTarget;
  if (!lightboxZoomed) {
    const rect = scroll.getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top) / rect.height;
    lightboxZoomed = true;
    scroll.classList.add("zoomed");
    requestAnimationFrame(() => {
      scroll.scrollLeft = fracX * scroll.scrollWidth - rect.width / 2;
      scroll.scrollTop = fracY * scroll.scrollHeight - rect.height / 2;
    });
  } else {
    lightboxZoomed = false;
    scroll.classList.remove("zoomed");
  }
});

function frameCard(night, f, frames, index) {
  const debayer = state.status && state.status.is_osc ? "&debayer=1" : "";
  // Unlinked stretch (each channel gets its own black/white point) rather
  // than the "linked"/default: raw subs are wildly unbalanced straight
  // off the sensor (no white balance applied yet), so a linked stretch
  // left review thumbnails looking like a flat cyan wash - unlinked
  // actually shows the frame's real content.
  const smallUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(`raw/nights/${night}/lights/${f.filename}`)}&max_size=320&stretch=unlinked${debayer}`;
  const checked = state.excludeFrames.has(f.filename);
  const flagged = isFrameFlagged(f);
  const card = el("div", { class: `frame-card${flagged ? " flagged" : ""}` }, []);
  const { date, time } = formatCaptured(f.captured_at);
  // Not loading="lazy": the frame strip scrolls horizontally, and lazy
  // loading only fires once an image nears the *viewport*, not the
  // scroll container — off-screen thumbnails would silently never load
  // until a user happened to scroll to them (confirmed this the hard
  // way: 7/11 stuck "loading" indefinitely until manually scrolled).
  card.appendChild(el("img", {
    src: smallUrl,
    onclick: () => openLightboxForFrame(night, frames, index),
  }, []));
  const meta = el("div", { class: "frame-meta" }, []);
  meta.appendChild(el("div", { class: "frame-name" }, [f.filename]));
  meta.appendChild(el("div", { class: "frame-time" }, [`${date}  ${time}`]));
  const stats = el("div", { class: "frame-stats" }, []);
  const rows = [
    ["stars", f.star_count, "star_count"],
    ["fwhm", f.fwhm !== null ? f.fwhm.toFixed(2) : "—", "fwhm"],
    ["eccen", f.roundness !== null ? f.roundness.toFixed(3) : "—", "roundness"],
    ["snr", f.snr !== null ? f.snr.toFixed(0) : "—", "snr"],
  ];
  for (const [k, v, metricKey] of rows) {
    const isAnom = f.anomaly_z && f.anomaly_z[metricKey] !== undefined && f.anomaly_z[metricKey] >= state.lastAnomalySigma;
    stats.appendChild(el("span", {}, [k]));
    stats.appendChild(el("b", { class: isAnom ? "anom" : "" }, [String(v)]));
  }
  meta.appendChild(stats);
  if (isFrameFlagged(f)) meta.appendChild(el("div", { class: "badge danger", style: "margin-top:6px;" }, ["flagged"]));
  const excludeRow = el("label", { class: "frame-exclude" }, [
    el("input", {
      type: "checkbox", checked: checked ? "checked" : null,
      onchange: (e) => {
        if (e.target.checked) state.excludeFrames.add(f.filename);
        else state.excludeFrames.delete(f.filename);
        refreshExcludeDisplay();
        // Re-rendering the whole review grid below rebuilds every node,
        // which used to silently reset the page's scroll position back
        // to wherever the browser felt like - jarring when you're 40
        // frames deep excluding one at a time. Pin the viewport in place
        // across the rebuild instead.
        const y = window.scrollY;
        renderAnalyzeOutput();
        requestAnimationFrame(() => window.scrollTo(window.scrollX, y));
      },
    }, []),
    document.createTextNode("exclude from stack"),
  ]);
  meta.appendChild(excludeRow);
  card.appendChild(meta);
  return card;
}

function computeVisibleItems(night, frames) {
  if (frames.length <= LARGE_NIGHT_THRESHOLD) {
    return frames.map((f, i) => ({ type: "frame", frame: f, index: i }));
  }
  const expanded = state.expandedGroups[night] || new Set();
  const showIndex = new Set();
  frames.forEach((f, i) => {
    if (isFrameFlagged(f)) {
      for (let d = -2; d <= 2; d++) {
        const j = i + d;
        if (j >= 0 && j < frames.length) showIndex.add(j);
      }
    }
  });
  const items = [];
  let i = 0;
  while (i < frames.length) {
    if (showIndex.has(i)) {
      items.push({ type: "frame", frame: frames[i], index: i });
      i++;
    } else {
      let j = i;
      while (j < frames.length && !showIndex.has(j)) j++;
      const key = `${i}-${j}`;
      if (expanded.has(key)) {
        for (let k = i; k < j; k++) items.push({ type: "frame", frame: frames[k], index: k });
      } else {
        items.push({ type: "ellipsis", start: i, end: j, count: j - i, key });
      }
      i = j;
    }
  }
  return items;
}

function renderAnalyzeOutput() {
  const outputEl = document.getElementById("analyze-output");
  // Every re-render (e.g. toggling one exclude checkbox) throws away and
  // rebuilds each night's .frame-strip from scratch, and a freshly
  // created element always starts at scrollLeft 0 - which was silently
  // snapping the horizontally-scrolling strip back to its start on every
  // single click. Capture each night's current scroll position before
  // tearing it down, keyed by night so it survives even though the DOM
  // node itself doesn't.
  const prevScrollLeft = {};
  outputEl.querySelectorAll(".night-block").forEach((block) => {
    const strip = block.querySelector(".frame-strip");
    if (block.dataset.night && strip) prevScrollLeft[block.dataset.night] = strip.scrollLeft;
  });
  outputEl.innerHTML = "";
  if (!state.lastAnalyzeResult) return;

  for (const [night, allFrames] of Object.entries(state.lastAnalyzeResult.nights)) {
    const frames = state.showSurvivorsOnly ? allFrames.filter((f) => !state.excludeFrames.has(f.filename)) : allFrames;
    const flaggedCount = allFrames.filter((f) => isFrameFlagged(f)).length;
    const excludedCount = allFrames.filter((f) => state.excludeFrames.has(f.filename)).length;

    const block = el("div", { class: "night-block", "data-night": night }, []);
    block.appendChild(el("h4", {}, [
      `${night} — ${allFrames.length} frames, ${flaggedCount} flagged` + (excludedCount ? `, ${excludedCount} excluded` : ""),
    ]));
    const grid = el("div", { class: "metric-grid" }, [
      metricStrip("star count", frames, "star_count", "star_count", state.lastAnomalySigma),
      metricStrip("FWHM", frames, "fwhm", "fwhm", state.lastAnomalySigma),
      metricStrip("eccentricity", frames, "roundness", "roundness", state.lastAnomalySigma),
      metricStrip("SNR", frames, "snr", "snr", state.lastAnomalySigma),
    ]);
    block.appendChild(grid);

    const strip = el("div", { class: "frame-strip" }, []);
    if (frames.length > LARGE_NIGHT_THRESHOLD && !state.showSurvivorsOnly) {
      for (const item of computeVisibleItems(night, frames)) {
        if (item.type === "frame") {
          strip.appendChild(frameCard(night, item.frame, frames, item.index));
        } else {
          strip.appendChild(el("div", {
            class: "frame-ellipsis",
            onclick: () => {
              if (!state.expandedGroups[night]) state.expandedGroups[night] = new Set();
              state.expandedGroups[night].add(item.key);
              renderAnalyzeOutput();
            },
          }, [`⋯ ${item.count} more\n(not flagged)`]));
        }
      }
    } else {
      frames.forEach((f, i) => strip.appendChild(frameCard(night, f, frames, i)));
    }
    block.appendChild(strip);
    outputEl.appendChild(block);
    if (prevScrollLeft[night] !== undefined) strip.scrollLeft = prevScrollLeft[night];
  }

  if (state.excludeFrames.size > 0) {
    const totalAll = Object.values(state.lastAnalyzeResult.nights).reduce((n, fr) => n + fr.length, 0);
    const survivors = totalAll - state.excludeFrames.size;
    const banner = el("div", { class: "survivor-banner" }, [
      el("span", {}, [
        state.showSurvivorsOnly
          ? `Showing survivors only: ${survivors} of ${totalAll} frames will move forward to Stack.`
          : `${state.excludeFrames.size} frame(s) marked for exclusion — ${survivors} of ${totalAll} will move forward to Stack.`,
      ]),
      el("button", {
        class: "small" + (state.showSurvivorsOnly ? " primary" : ""),
        onclick: () => {
          state.showSurvivorsOnly = !state.showSurvivorsOnly;
          renderAnalyzeOutput();
          if (lightboxNav) renderLightboxFrame();
        },
      }, [state.showSurvivorsOnly ? "Show all frames" : "Accept exclusions — show survivors only"]),
    ]);
    outputEl.insertBefore(banner, outputEl.firstChild);
  }

  document.getElementById("analyze-rerun-btn").style.display = state.excludeFrames.size > 0 ? "inline-block" : "none";

  const anyUnacceptedFlags = Object.values(state.lastAnalyzeResult.nights)
    .flat()
    .some((f) => isFrameFlagged(f) && !state.excludeFrames.has(f.filename));
  document.getElementById("analyze-actions").style.display = anyUnacceptedFlags ? "block" : "none";

  refreshStackNightsChecklist();
}

async function runAnalyze() {
  const runBtn = document.getElementById("analyze-run-btn");
  const rerunBtn = document.getElementById("analyze-rerun-btn");
  const resultEl = document.getElementById("analyze-result");
  const body = analyzeBody();
  resultEl.innerHTML = "";
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-actions").style.display = "none";
  document.getElementById("analyze-reset-btn").style.display = "none";
  document.getElementById("review-next-btn").style.display = "none";
  setStepBadge("review-status-badge", null, "not analyzed");
  runBtn.disabled = true;
  rerunBtn.disabled = true;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/lights/analyze/run`, body);
    await pollJob(job_id, {
      progressEl: document.getElementById("analyze-progress"),
      lockButtons: [runBtn, rerunBtn],
      onDone: (snap) => {
        if (snap.status !== "succeeded") {
          setOutcome(resultEl, false, `Failed: ${snap.error || ""}`);
          return;
        }
        setStepBadge("review-status-badge", "ok", "analyzed");
        state.analyzed = true;
        state.lastAnalyzeResult = snap.result;
        state.lastAnomalySigma = body.anomaly_sigma;
        state.showSurvivorsOnly = false;
        state.expandedGroups = {};
        renderAnalyzeOutput();
        renderStepper();
        document.getElementById("analyze-reset-btn").style.display = "inline-block";
        document.getElementById("review-next-btn").style.display = "inline-block";
      },
    });
  } catch (e) {
    runBtn.disabled = false;
    rerunBtn.disabled = false;
    setOutcome(resultEl, false, String(e));
  }
}

document.getElementById("analyze-run-btn").addEventListener("click", runAnalyze);
document.getElementById("analyze-rerun-btn").addEventListener("click", runAnalyze);

document.getElementById("analyze-anomaly-sigma").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value) || 3.0;
  document.getElementById("anomaly-sigma-value").textContent = v.toFixed(1);
  state.lastAnomalySigma = v;
  // Flagging is derived client-side from the per-frame z-scores already
  // in hand (isFrameFlagged()), so dragging this slider re-colors
  // everything immediately with no server round trip - it only matters
  // once there's a result to re-color.
  if (state.lastAnalyzeResult) renderAnalyzeOutput();
});

document.getElementById("analyze-accept-recommended-btn").addEventListener("click", () => {
  if (!state.lastAnalyzeResult) return;
  for (const frames of Object.values(state.lastAnalyzeResult.nights)) {
    for (const f of frames) {
      if (isFrameFlagged(f)) state.excludeFrames.add(f.filename);
    }
  }
  refreshExcludeDisplay();
  renderAnalyzeOutput();
});

document.getElementById("analyze-reset-btn").addEventListener("click", () => {
  if (!confirm("Start over? This clears all excluded frames and this session's analysis results.")) return;
  // Also drop the per-project review cache (see reviewCache below) - it
  // only gets refreshed when switching away with a *non-null* analyze
  // result, so without this a switch-away-and-back after starting over
  // would silently resurrect the pre-reset data instead of respecting it.
  if (state.project) delete reviewCache[state.project];
  state.excludeFrames.clear();
  state.lastAnalyzeResult = null;
  state.analyzed = false;
  state.showSurvivorsOnly = false;
  state.expandedGroups = {};
  refreshExcludeDisplay();
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-result").innerHTML = "";
  document.getElementById("analyze-actions").style.display = "none";
  document.getElementById("analyze-reset-btn").style.display = "none";
  document.getElementById("analyze-rerun-btn").style.display = "none";
  document.getElementById("review-next-btn").style.display = "none";
  setStepBadge("review-status-badge", null, "not analyzed");
  refreshStackNightsChecklist();
  renderStepper();
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
    is_osc: state.status ? state.status.is_osc !== false : true,
    exclude_frames: Array.from(state.excludeFrames),
  };
  const dark = document.getElementById("stack-master-dark").value.trim();
  const flat = document.getElementById("stack-master-flat").value.trim();
  if (dark) body.master_dark = dark;
  if (flat) body.master_flat = flat;
  return body;
}

attachFileBrowser(document.getElementById("stack-master-dark"), document.getElementById("stack-master-dark-browse"), "process");
attachFileBrowser(document.getElementById("stack-master-flat"), document.getElementById("stack-master-flat-browse"), "process");

wireToggleButton("stack-render-btn", "stack", () =>
  api("POST", `/projects/${encodeURIComponent(state.project)}/stack/render`, stackBody())
);

document.getElementById("stack-run-btn").addEventListener("click", async () => {
  const runBtn = document.getElementById("stack-run-btn");
  const resultEl = document.getElementById("stack-result");
  const previewEl = document.getElementById("stack-preview");
  resultEl.innerHTML = "";
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  // Also clear builtFor, not just the DOM: showStackPreview() skips
  // rebuilding whenever the result path matches what it already built -
  // a correct optimization for the stretch-mode buttons, but back-to-back
  // stack runs (e.g. rejection, then max, then median) all write to the
  // SAME path, so without this reset showStackPreview() would see "same
  // path, nothing to do" after the job finishes and leave this now-empty
  // element blank forever - confirmed this is exactly what happened
  // testing successive runs with different stack methods.
  previewEl.innerHTML = "";
  previewEl.dataset.builtFor = "";
  runBtn.disabled = true;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/stack/run`, stackBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("stack-progress"),
      logViewEl: document.querySelector('[data-log-view="stack"]'),
      pipelineEl: document.getElementById("stack-pipeline"),
      lockButtons: [runBtn],
      onDone: async (snap) => {
        if (snap.status === "succeeded") setOutcome(resultEl, true, "Stack complete");
        else setOutcome(resultEl, false, `Failed: ${snap.error || ""}`);
        await loadProjectStatus();
        showStackPreview();
        renderStepper();
      },
    });
  } catch (e) {
    runBtn.disabled = false;
    setOutcome(resultEl, false, String(e));
  }
});

function currentResultPath() {
  if (!state.status) return null;
  return state.status.merged_result_path || (state.status.nights.find((n) => n.result_path) || {}).result_path || null;
}

function stackPreviewUrl(path, maxSize) {
  const size = maxSize ? `&max_size=${maxSize}` : "";
  return `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(path)}&stretch=${state.stretchMode}${size}&t=${Date.now()}`;
}

function showStackPreview() {
  const previewEl = document.getElementById("stack-preview");
  const path = currentResultPath();
  if (!path) {
    previewEl.innerHTML = "";
    previewEl.dataset.builtFor = "";
    return;
  }

  // Only rebuild the whole block (controls + frame) the first time, or
  // when the result path itself changes (a fresh stack ran). Switching
  // stretch mode just swaps the existing <img>'s src - rebuilding the
  // whole subtree each time briefly collapsed the frame to 0 height
  // (nothing to reserve space until the new PNG decoded), which yanked
  // the page up and buried the image below the fold until it reloaded.
  // The CSS aspect-ratio on .preview-frame is a second safety net for
  // this same problem; keeping the DOM node in place avoids it outright.
  if (previewEl.dataset.builtFor !== path) {
    previewEl.innerHTML = "";
    const controls = el("div", { class: "preview-controls" }, []);
    const toggle = el("div", { class: "stretch-toggle" }, []);
    for (const mode of ["none", "linked", "unlinked"]) {
      toggle.appendChild(el("button", {
        class: mode === state.stretchMode ? "active" : "",
        type: "button",
        onclick: () => {
          state.stretchMode = mode;
          toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === mode));
          previewEl.querySelector("img").src = stackPreviewUrl(path);
        },
      }, [mode]));
    }
    controls.appendChild(toggle);
    controls.appendChild(el("a", {
      href: `/projects/${encodeURIComponent(state.project)}/download?path=${encodeURIComponent(path)}`,
      class: "mono",
    }, [el("button", { type: "button" }, ["⬇ Download full-resolution .fit"])]));
    previewEl.appendChild(controls);
    previewEl.appendChild(el("div", { class: "preview-frame" }, [el("img", {
      src: stackPreviewUrl(path),
      onclick: () => openPlainLightbox(stackPreviewUrl(path, 2400), path.split("/").pop()),
    }, [])]));
    previewEl.dataset.builtFor = path;
  }
}

// ---------- stepper ----------

function stepStatus(step) {
  const s = state.status;
  if (!s) return { available: step === "stage", complete: false };
  const staged = s.nights.length > 0;
  const mastersComplete = s.master_bias_built && s.master_dark_built && staged && s.nights.every((n) => n.master_flat_built);
  const stackComplete = !!s.merged_result_path || s.nights.some((n) => n.result_path);
  switch (step) {
    case "stage": return { available: true, complete: staged };
    case "masters": return { available: staged, complete: mastersComplete };
    case "review": return { available: staged, complete: state.analyzed };
    case "stack": return { available: mastersComplete, complete: stackComplete };
    default: return { available: false, complete: false };
  }
}

function renderStepper() {
  const stepper = document.getElementById("stepper");
  stepper.innerHTML = "";
  STEPS.forEach((step, i) => {
    const { available, complete } = stepStatus(step);
    const classes = ["step"];
    if (step === state.activeStep) classes.push("active");
    if (complete) classes.push("complete");
    if (!available) classes.push("disabled");
    const stepEl = el("div", {
      class: classes.join(" "),
      onclick: available ? () => { state.activeStep = step; showActiveStep(); } : null,
    }, [
      el("div", { class: "dot" }, [complete ? "" : String(i + 1)]),
      el("span", {}, [STEP_LABELS[step]]),
    ]);
    stepper.appendChild(stepEl);
    if (i < STEPS.length - 1) stepper.appendChild(el("div", { class: "connector" }, []));
  });
}

function showActiveStep() {
  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("visible", panel.dataset.step === state.activeStep);
  });
  renderStepper();
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
  try {
    state.status = await api("GET", `/projects/${encodeURIComponent(state.project)}/status`);
  } catch (e) {
    // A project name can exist in the dropdown (added by Create) before
    // it exists on the server (nothing is created there until Stage
    // actually runs) - that 404 is expected, not an error. Previously
    // this threw here and left state.status holding whatever the
    // PREVIOUSLY selected project's status was, since the assignment
    // above never happened - the stepper then kept showing that other
    // project's completed steps (staged/built/stacked) against the new,
    // actually-empty project. Reset explicitly instead of leaving it stale.
    state.status = null;
    document.getElementById("delete-project-btn").disabled = true;
    document.getElementById("delete-project-btn").title = "This project hasn't been staged yet — nothing to delete";
    renumberSessions();
    renderStepper();
    return;
  }
  document.getElementById("delete-project-btn").disabled = false;
  document.getElementById("delete-project-btn").title = "";
  const nights = state.status.nights;

  setStepBadge("stage-status-badge", nights.length ? "ok" : null, nights.length ? `${nights.length} night(s) staged` : "not staged");
  document.getElementById("stage-next-btn").style.display = nights.length ? "inline-block" : "none";

  const mastersDone = stepStatus("masters").complete;
  setStepBadge("masters-status-badge", mastersDone ? "ok" : null, mastersDone ? "masters built" : "not built");
  document.getElementById("masters-next-btn").style.display = mastersDone ? "inline-block" : "none";

  const stackDone = stepStatus("stack").complete;
  setStepBadge("stack-status-badge", stackDone ? "ok" : null, stackDone ? "stack complete" : "not stacked");

  renderChecklist("masters-nights", nights, mastersSelected);
  renderChecklist("analyze-nights", nights, analyzeSelected);
  refreshStackNightsChecklist();
  renderExistingStagedNights();
  // The draft "Session N" row(s) in the Stage form are created by
  // addNightRow() at project-switch time, BEFORE this function's fetch
  // resolves - at that point state.status is still null (just reset),
  // so the label always came out "Session 1" regardless of how many
  // nights this project actually already has staged. Relabel now that
  // the real count is known.
  renumberSessions();

  document.getElementById("stage-is-osc").checked = state.status.is_osc !== false;

  renderMastersPreviews();
  showStackPreview();
  renderStepper();
  // Fire-and-forget, not awaited: a large project means one syscall per
  // staged file server-side, which could be noticeably slower than the
  // status load above on a big project or a slow NAS - never block the
  // rest of this function (or anything the user does next) on it.
  checkBrokenLinks();
}

async function checkBrokenLinks() {
  const project = state.project;
  const banner = document.getElementById("broken-links-banner");
  let data;
  try {
    data = await api("GET", `/projects/${encodeURIComponent(project)}/broken-links`);
  } catch (e) {
    return;
  }
  // The user may have switched projects while this was in flight (it's
  // deliberately not awaited by its caller) - don't show a stale result
  // for a project that isn't even open anymore.
  if (state.project !== project) return;
  if (!data.broken.length) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  const names = data.broken.map((p) => p.split("/").pop());
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : "");
  banner.querySelector(".msg").textContent =
    `${data.broken.length} staged file(s) are missing from captures (moved or deleted outside this app): ${shown}.`;
}

// Review results are pure client-side state (never saved server-side -
// see AnalyzeLightsRequest's docstring), so switching projects used to
// throw the whole review session away every time, even switching right
// back to a project you'd just analyzed a moment ago. Cache the last
// analyze result (plus exclusions/sensitivity) per project name and
// restore it on return instead of forcing a re-analyze.
const reviewCache = {};

// Shared by the project <select>'s own change handler and by clicking a
// row in the global active-jobs panel - factored out so the latter can
// land on the step that job actually belongs to (initialStep) instead of
// always defaulting to Stage, which is the right default for "I manually
// picked a project" but was wrong for "I clicked a running stack job and
// want to see the stack step," a real bug Chris hit (every project
// switch, from anywhere, hardcoded state.activeStep = "stage").
async function switchToProject(name, initialStep) {
  // Save the OUTGOING project's review session before resetting
  // anything below - keyed by whatever state.project still is at this
  // point (the project being switched away FROM).
  if (state.project && state.lastAnalyzeResult) {
    reviewCache[state.project] = {
      lastAnalyzeResult: state.lastAnalyzeResult,
      excludeFrames: new Set(state.excludeFrames),
      lastAnomalySigma: state.lastAnomalySigma,
    };
  }
  state.project = name || null;
  // Reset immediately, not just inside loadProjectStatus(): there's an
  // async gap before that fetch resolves, and showActiveStep() below
  // (which renders the stepper right away) would otherwise briefly - or,
  // if the fetch then fails, indefinitely - show the PREVIOUS project's
  // staged/built/stacked state against whatever's newly selected.
  state.status = null;
  document.getElementById("project-panels").style.display = state.project ? "block" : "none";
  document.getElementById("no-project-hint").style.display = state.project ? "none" : "block";
  document.getElementById("delete-project-btn").style.display = state.project ? "inline-block" : "none";
  document.getElementById("job-history-btn").style.display = state.project ? "inline-block" : "none";
  document.getElementById("job-history-panel").style.display = "none";
  document.getElementById("broken-links-banner").style.display = "none";
  // pollActiveJobs() runs globally regardless of project selection (see
  // init()) - just reset this so a stale job id from the PREVIOUS
  // project can't be mistaken for one belonging to the new selection.
  lastKnownRunningJobIdForCurrentProject = null;
  // Disabled until loadProjectStatus() below confirms the project
  // actually exists on the server: a name can sit in this dropdown
  // (added by Create) before anything is staged, and DELETE on a
  // project that was never staged 404s.
  document.getElementById("delete-project-btn").disabled = true;
  document.getElementById("delete-project-btn").title = "This project hasn't been staged yet — nothing to delete";
  mastersSelected.clear();
  analyzeSelected.clear();
  stackSelected.clear();
  state.excludeFrames.clear();
  state.analyzed = false;
  state.lastAnalyzeResult = null;
  state.showSurvivorsOnly = false;
  state.expandedGroups = {};
  state.activeStep = initialStep || "stage";
  refreshExcludeDisplay();
  document.getElementById("stage-nights").innerHTML = "";
  addNightRow();
  document.getElementById("stage-summary").innerHTML = "";
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-result").innerHTML = "";
  document.getElementById("masters-result").innerHTML = "";
  document.getElementById("masters-previews").innerHTML = "";
  document.getElementById("stack-result").innerHTML = "";
  document.getElementById("analyze-actions").style.display = "none";
  document.getElementById("analyze-reset-btn").style.display = "none";
  document.getElementById("analyze-rerun-btn").style.display = "none";
  document.getElementById("stage-next-btn").style.display = "none";
  document.getElementById("masters-next-btn").style.display = "none";
  document.getElementById("review-next-btn").style.display = "none";
  document.getElementById("stack-master-dark").value = "";
  document.getElementById("stack-master-flat").value = "";
  setStepBadge("review-status-badge", null, "not analyzed");
  // Same staleness risk as state.status above: these otherwise only get
  // updated inside loadProjectStatus()'s success path, so a project that
  // 404s (not staged on the server yet) would leave the PREVIOUS
  // project's badges and night checklists on screen indefinitely.
  setStepBadge("stage-status-badge", null, "not staged");
  setStepBadge("masters-status-badge", null, "not built");
  setStepBadge("stack-status-badge", null, "not stacked");
  renderChecklist("masters-nights", [], mastersSelected);
  renderChecklist("analyze-nights", [], analyzeSelected);
  renderChecklist("stack-nights", [], stackSelected);
  document.getElementById("stage-existing-nights").innerHTML = "";
  // The stack preview's "only rebuild when the path changes" optimization
  // (showStackPreview) keys off the result's path alone, which is
  // relative and could coincidentally match between two different
  // projects that both have a merged result - reset it so a project
  // switch always rebuilds instead of risking a stale image left over
  // from whichever project was open before.
  document.getElementById("stack-preview").innerHTML = "";
  document.getElementById("stack-preview").dataset.builtFor = "";
  showActiveStep();
  if (state.project) await loadProjectStatus();
  // Restore a cached review session for the INCOMING project, if this
  // browser tab analyzed it before switching away at some point - after
  // loadProjectStatus(), not before, since frame thumbnails need
  // state.status.is_osc (for debayering) to already be populated.
  const cached = state.project ? reviewCache[state.project] : null;
  if (cached) {
    state.lastAnalyzeResult = cached.lastAnalyzeResult;
    state.excludeFrames = new Set(cached.excludeFrames);
    state.lastAnomalySigma = cached.lastAnomalySigma;
    state.analyzed = true;
    document.getElementById("analyze-anomaly-sigma").value = cached.lastAnomalySigma;
    document.getElementById("anomaly-sigma-value").textContent = cached.lastAnomalySigma.toFixed(1);
    setStepBadge("review-status-badge", "ok", "analyzed");
    document.getElementById("analyze-reset-btn").style.display = "inline-block";
    document.getElementById("review-next-btn").style.display = "inline-block";
    refreshExcludeDisplay();
    renderAnalyzeOutput();
    renderStepper();
  }
}

document.getElementById("project-select").addEventListener("change", (e) => switchToProject(e.target.value || null, "stage"));

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

document.getElementById("delete-project-btn").addEventListener("click", async () => {
  if (!state.project) return;
  const name = state.project;
  // Deletes staged frames, built masters, and any stacked result -
  // permanent and not something a plain confirm() dialog conveys well
  // enough. Typing the name back is the same "you have to mean it"
  // pattern as most destructive-delete UIs.
  const typed = prompt(`Type the project name "${name}" to permanently delete it and everything in it (staged frames, masters, review data, stacked result). This cannot be undone.`);
  if (typed === null) return;
  if (typed !== name) {
    alert("Name didn't match — nothing was deleted.");
    return;
  }
  try {
    await api("DELETE", `/projects/${encodeURIComponent(name)}`);
  } catch (e) {
    alert(`Delete failed: ${e}`);
    return;
  }
  delete reviewCache[name];
  await loadProjects();
  const sel = document.getElementById("project-select");
  sel.value = "";
  sel.dispatchEvent(new Event("change"));
});

// ---------- job history ----------

function formatJobWhen(job) {
  if (!job.started_at) return "—";
  const started = new Date(job.started_at * 1000);
  let text = started.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (job.ended_at) {
    const secs = Math.round(job.ended_at - job.started_at);
    text += ` (${secs}s)`;
  } else if (job.status === "running") {
    text += ` — ${(job.percent_complete || 0).toFixed(0)}%`;
  }
  return text;
}

async function renderJobHistory() {
  const list = document.getElementById("job-history-list");
  list.innerHTML = "loading…";
  let jobsList;
  try {
    jobsList = (await api("GET", `/projects/${encodeURIComponent(state.project)}/jobs`)).jobs;
  } catch (e) {
    list.textContent = String(e);
    return;
  }
  list.innerHTML = "";
  if (!jobsList.length) {
    list.appendChild(el("span", { class: "empty-hint" }, ["No jobs run yet this server session."]));
    return;
  }
  for (const job of jobsList) {
    const statusClass = job.status === "succeeded" ? "ok" : job.status === "failed" ? "danger" : job.status === "running" ? "accent" : "";
    const row = el("div", { class: "job-history-row" }, [
      el("span", { class: "kind" }, [job.kind || "job"]),
      el("span", { class: `badge ${statusClass}` }, [job.status]),
      el("span", { class: "when" }, [formatJobWhen(job)]),
      el("span", { class: "hint" }, ["click for log"]),
    ]);
    const logView = el("pre", { class: "log-view", style: "display:none; white-space:pre-wrap;" }, []);
    let loaded = false;
    row.addEventListener("click", async () => {
      const open = logView.classList.contains("open");
      if (open) {
        logView.classList.remove("open");
        logView.style.display = "none";
        return;
      }
      if (!loaded) {
        logView.textContent = "loading…";
        try {
          logView.textContent = await api("GET", `/jobs/${job.id}/log`);
          loaded = true;
        } catch (e) {
          logView.textContent = String(e);
        }
      }
      logView.classList.add("open");
      logView.style.display = "block";
    });
    list.appendChild(row);
    list.appendChild(logView);
  }
}

document.getElementById("job-history-btn").addEventListener("click", () => {
  document.getElementById("job-history-panel").style.display = "block";
  renderJobHistory();
});
document.getElementById("job-history-close").addEventListener("click", () => {
  document.getElementById("job-history-panel").style.display = "none";
});

// ---------- global active-jobs panel + cross-tab job awareness ----------

// Runs for the lifetime of the page, independent of which (if any)
// project is selected — Chris: "if I'm running a stack in two separate
// projects, I shouldn't have to go clicking through projects to see
// what's happening." Started once at boot (see init()), never stopped.
let lastKnownRunningJobIdForCurrentProject = null;

function stepForJobKind(kind) {
  if (kind === "masters") return "masters";
  if (kind === "stack") return "stack";
  if (kind === "analyze") return "review";
  return "stage";
}

function renderActiveJobsPanel(runningJobs) {
  const panel = document.getElementById("active-jobs-panel");
  const list = document.getElementById("active-jobs-list");
  if (!runningJobs.length) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";
  list.innerHTML = "";
  for (const job of runningJobs) {
    const row = el("div", {
      class: `active-job-row${job.project === state.project ? " current-project" : ""}`,
      onclick: () => {
        const targetStep = stepForJobKind(job.kind);
        if (job.project === state.project) {
          // Already there - just jump to the relevant step rather than
          // running the whole switch-project reset for no reason.
          state.activeStep = targetStep;
          showActiveStep();
        } else {
          document.getElementById("project-select").value = job.project;
          switchToProject(job.project, targetStep);
        }
      },
    }, [
      el("span", { class: "project-name" }, [job.project]),
      el("span", { class: "kind" }, [job.kind || "job"]),
      el("span", { class: "pct" }, [`${(job.percent_complete || 0).toFixed(0)}%`]),
      el("span", { class: "hint" }, [job.current_line || ""]),
    ]);
    list.appendChild(row);
  }
}

async function pollActiveJobs() {
  let jobsList;
  try {
    jobsList = (await api("GET", "/jobs")).jobs;
  } catch (e) {
    return;
  }
  const running = jobsList.filter((j) => j.status === "running");
  renderActiveJobsPanel(running);

  // Masters/stack genuinely race on shared scratch directories if two run
  // at once against the same project (Frontend/web gotcha #4) - disable
  // both regardless of which kind is running, matching the server's own
  // has_running_job() check (any job blocks a new masters/stack run, not
  // just a same-kind one). Analyze has no such conflict, so its button
  // stays enabled. This is best-effort (up to ~5s to notice a job
  // started elsewhere) - the server's 409 is the actual guarantee, this
  // is just to avoid hitting it in the first place.
  if (!state.project) return;
  const runningHere = running.find((j) => j.project === state.project);
  const mastersBtn = document.getElementById("masters-run-btn");
  const stackBtn = document.getElementById("stack-run-btn");
  if (!mastersBtn || !stackBtn) return; // project-panels not in the DOM yet on first load
  if (runningHere) {
    lastKnownRunningJobIdForCurrentProject = runningHere.id;
    mastersBtn.disabled = true;
    stackBtn.disabled = true;
  } else {
    mastersBtn.disabled = false;
    stackBtn.disabled = false;
    if (lastKnownRunningJobIdForCurrentProject) {
      // Something that was running for THIS project (possibly from
      // another tab) just finished - pick up whatever it changed.
      lastKnownRunningJobIdForCurrentProject = null;
      await loadProjectStatus();
    }
  }
}

// ---------- advanced toggles (event delegation) ----------

document.addEventListener("click", (e) => {
  const advToggle = e.target.closest("[data-adv-for]");
  if (advToggle) {
    document.querySelector(`[data-adv="${advToggle.dataset.advFor}"]`).classList.toggle("open");
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
  showActiveStep();

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

  // Runs for the page's whole lifetime, regardless of project selection -
  // see pollActiveJobs()'s own docstring.
  pollActiveJobs();
  setInterval(pollActiveJobs, 5000);
})();
