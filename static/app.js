/* astro-stacker frontend — plain JS, no build step, no framework.
 * Talks to the FastAPI backend documented in app/main.py. Keeps all
 * pipeline state (staged nights, exclude selections) derived from the
 * server's /projects/{name}/status rather than tracked independently,
 * so a page reload never gets out of sync with what's actually on disk.
 */

const STEPS = ["stage", "masters", "review", "stack"];
const STEP_LABELS = { stage: "Stage", masters: "Masters", review: "Review", stack: "Stack" };
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

function formatTime(iso) {
  if (!iso) return "—";
  const t = iso.split("T")[1] || iso;
  return t.split(".")[0];
}

function setOutcome(el_, ok, msg) {
  el_.innerHTML = "";
  el_.appendChild(el("div", { class: ok ? "complete-banner" : "error-banner" }, [
    ok ? "✓ " : "✕ ",
    msg,
  ]));
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
    if (msg) msg.textContent = snap.current_command ? `[${snap.current_command}] ${snap.current_line || ""}`.slice(0, 90) : (snap.current_line || "").slice(0, 90);
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
  const view = document.querySelector(`[data-log-view="${logKey}"]`);
  let loaded = false;
  btn.addEventListener("click", async () => {
    const isOpen = view.classList.contains("open");
    if (isOpen) {
      view.classList.remove("open");
      btn.textContent = btn.textContent.replace("▴", "▾");
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
    btn.textContent = btn.textContent.replace("▾", "▴");
  });
}

// ---------- folder browser (for Stage section) ----------

function attachFolderBrowser(inputEl, browseBtn) {
  browseBtn.addEventListener("click", async () => {
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

// ---------- Stage section ----------

function addNightRow() {
  const container = document.getElementById("stage-nights");
  const sessionNum = container.children.length + 1;
  const row = el("div", { class: "night-row" }, []);
  const label = el("span", { class: "session-label" }, [`Session ${sessionNum}`]);
  const lightsInput = el("input", { type: "text", class: "dirpick", placeholder: "lights dir (e.g. Night 1/lights)" }, []);
  const flatsInput = el("input", { type: "text", class: "dirpick", placeholder: "flats dir (e.g. Night 1/flats)" }, []);
  const lightsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const flatsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  attachFolderBrowser(lightsInput, lightsBrowse);
  attachFolderBrowser(flatsInput, flatsBrowse);
  const removeBtn = el("button", { type: "button", class: "small ghost", onclick: () => { row.remove(); renumberSessions(); } }, ["✕"]);
  row.append(label, lightsInput, lightsBrowse, flatsInput, flatsBrowse, removeBtn);
  container.appendChild(row);
}

function renumberSessions() {
  const rows = document.getElementById("stage-nights").children;
  Array.from(rows).forEach((row, i) => {
    row.querySelector(".session-label").textContent = `Session ${i + 1}`;
  });
}

document.getElementById("add-night-btn").addEventListener("click", () => addNightRow());
attachFolderBrowser(document.getElementById("biases-dir"), document.getElementById("biases-browse"));
attachFolderBrowser(document.getElementById("darks-dir"), document.getElementById("darks-browse"));

document.getElementById("stage-btn").addEventListener("click", async () => {
  if (!state.project) return;
  const rows = Array.from(document.getElementById("stage-nights").children);
  const nights = rows.map((row, i) => {
    const inputs = row.querySelectorAll("input");
    return { name: `night${i + 1}`, lights_dir: inputs[0].value.trim(), flats_dir: inputs[1].value.trim() };
  }).filter((n) => n.lights_dir && n.flats_dir);

  const body = {
    biases_dir: document.getElementById("biases-dir").value.trim() || null,
    darks_dir: document.getElementById("darks-dir").value.trim() || null,
    nights,
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
        if (snap.status === "succeeded") setOutcome(resultEl, true, "Masters built");
        else setOutcome(resultEl, false, `Failed: ${snap.error || ""}`);
        await loadProjectStatus();
      },
    });
  } catch (e) {
    runBtn.disabled = false;
    setOutcome(resultEl, false, String(e));
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

function metricStrip(label, frames, key, subKey) {
  const values = frames.map((f) => (typeof f[key] === "number" ? f[key] : 0));
  const max = Math.max(...values, 1e-9);
  const bars = el("div", { class: "metric-bars" }, frames.map((f, i) => {
    const h = Math.max(2, (values[i] / max) * 32);
    const flagged = f.anomaly_z && f.anomaly_z[subKey] !== undefined && f.anomaly_z[subKey] >= 3.0;
    return el("div", { class: `bar${flagged ? " flagged" : ""}`, style: `height:${h}px;`, title: `${f.filename} (${formatTime(f.captured_at)}): ${key}=${values[i]}` }, []);
  }));
  return el("div", { class: "metric-strip" }, [
    el("div", { class: "metric-label" }, [label]),
    bars,
  ]);
}

function openLightbox(url, caption) {
  document.getElementById("lightbox-img").src = url;
  document.getElementById("lightbox-caption").textContent = caption;
  document.getElementById("lightbox").classList.add("open");
}
document.getElementById("lightbox").addEventListener("click", () => {
  document.getElementById("lightbox").classList.remove("open");
});

function frameCard(night, f) {
  const smallUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(`raw/nights/${night}/lights/${f.filename}`)}&max_size=320`;
  const largeUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(`raw/nights/${night}/lights/${f.filename}`)}&max_size=1024`;
  const checked = state.excludeFrames.has(f.filename);
  const card = el("div", { class: `frame-card${f.flagged ? " flagged" : ""}` }, []);
  // Not loading="lazy": the frame strip scrolls horizontally, and lazy
  // loading only fires once an image nears the *viewport*, not the
  // scroll container — off-screen thumbnails would silently never load
  // until a user happened to scroll to them (confirmed this the hard
  // way: 7/11 stuck "loading" indefinitely until manually scrolled).
  card.appendChild(el("img", {
    src: smallUrl,
    onclick: () => openLightbox(largeUrl, `${f.filename} — ${formatTime(f.captured_at)}`),
  }, []));
  const meta = el("div", { class: "frame-meta" }, []);
  meta.appendChild(el("div", { class: "frame-name" }, [f.filename]));
  meta.appendChild(el("div", { class: "frame-time" }, [formatTime(f.captured_at)]));
  const stats = el("div", { class: "frame-stats" }, []);
  const rows = [
    ["stars", f.star_count, "star_count"],
    ["fwhm", f.fwhm !== null ? f.fwhm.toFixed(2) : "—", "fwhm"],
    ["eccen", f.roundness !== null ? f.roundness.toFixed(3) : "—", "roundness"],
    ["snr", f.snr !== null ? f.snr.toFixed(0) : "—", "snr"],
  ];
  for (const [k, v, metricKey] of rows) {
    const isAnom = f.anomaly_z && f.anomaly_z[metricKey] !== undefined && f.anomaly_z[metricKey] >= 3.0;
    stats.appendChild(el("span", {}, [k]));
    stats.appendChild(el("b", { class: isAnom ? "anom" : "" }, [String(v)]));
  }
  meta.appendChild(stats);
  if (f.flagged) meta.appendChild(el("div", { class: "badge danger", style: "margin-top:6px;" }, ["flagged"]));
  const excludeRow = el("label", { class: "frame-exclude" }, [
    el("input", {
      type: "checkbox", checked: checked ? "checked" : null,
      onchange: (e) => {
        if (e.target.checked) state.excludeFrames.add(f.filename);
        else state.excludeFrames.delete(f.filename);
        refreshExcludeDisplay();
        renderAnalyzeOutput();
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
    if (f.flagged) {
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
  outputEl.innerHTML = "";
  if (!state.lastAnalyzeResult) return;

  for (const [night, allFrames] of Object.entries(state.lastAnalyzeResult.nights)) {
    const frames = state.showSurvivorsOnly ? allFrames.filter((f) => !state.excludeFrames.has(f.filename)) : allFrames;
    const flaggedCount = allFrames.filter((f) => f.flagged).length;
    const excludedCount = allFrames.filter((f) => state.excludeFrames.has(f.filename)).length;

    const block = el("div", { class: "night-block" }, []);
    block.appendChild(el("h4", {}, [
      `${night} — ${allFrames.length} frames, ${flaggedCount} flagged` + (excludedCount ? `, ${excludedCount} excluded` : ""),
    ]));
    block.appendChild(metricStrip("star count", frames, "star_count", "star_count"));
    block.appendChild(metricStrip("FWHM", frames, "fwhm", "fwhm"));
    block.appendChild(metricStrip("eccentricity", frames, "roundness", "roundness"));
    block.appendChild(metricStrip("SNR", frames, "snr", "snr"));

    const strip = el("div", { class: "frame-strip" }, []);
    if (frames.length > LARGE_NIGHT_THRESHOLD && !state.showSurvivorsOnly) {
      for (const item of computeVisibleItems(night, frames)) {
        if (item.type === "frame") {
          strip.appendChild(frameCard(night, item.frame));
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
      for (const f of frames) strip.appendChild(frameCard(night, f));
    }
    block.appendChild(strip);
    outputEl.appendChild(block);
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
        onclick: () => { state.showSurvivorsOnly = !state.showSurvivorsOnly; renderAnalyzeOutput(); },
      }, [state.showSurvivorsOnly ? "Show all frames" : "Accept exclusions — show survivors only"]),
    ]);
    outputEl.insertBefore(banner, outputEl.firstChild);
  }

  document.getElementById("analyze-rerun-btn").style.display = state.excludeFrames.size > 0 ? "inline-block" : "none";
}

async function runAnalyze() {
  const runBtn = document.getElementById("analyze-run-btn");
  const rerunBtn = document.getElementById("analyze-rerun-btn");
  const resultEl = document.getElementById("analyze-result");
  resultEl.innerHTML = "";
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  document.getElementById("analyze-output").innerHTML = "";
  runBtn.disabled = true;
  rerunBtn.disabled = true;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(state.project)}/lights/analyze/run`, analyzeBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("analyze-progress"),
      lockButtons: [runBtn, rerunBtn],
      onDone: (snap) => {
        if (snap.status !== "succeeded") {
          setOutcome(resultEl, false, `Failed: ${snap.error || ""}`);
          return;
        }
        setOutcome(resultEl, true, "Analysis complete");
        state.analyzed = true;
        state.lastAnalyzeResult = snap.result;
        state.showSurvivorsOnly = false;
        state.expandedGroups = {};
        renderAnalyzeOutput();
        renderStepper();
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

wireToggleButton("stack-render-btn", "stack", () =>
  api("POST", `/projects/${encodeURIComponent(state.project)}/stack/render`, stackBody())
);

document.getElementById("stack-run-btn").addEventListener("click", async () => {
  const runBtn = document.getElementById("stack-run-btn");
  const resultEl = document.getElementById("stack-result");
  const previewEl = document.getElementById("stack-preview");
  resultEl.innerHTML = "";
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  previewEl.innerHTML = "";
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

function showStackPreview() {
  const previewEl = document.getElementById("stack-preview");
  previewEl.innerHTML = "";
  const path = currentResultPath();
  if (!path) return;

  const controls = el("div", { class: "preview-controls" }, []);
  const toggle = el("div", { class: "stretch-toggle" }, []);
  for (const mode of ["none", "linked", "unlinked"]) {
    toggle.appendChild(el("button", {
      class: mode === state.stretchMode ? "active" : "",
      type: "button",
      onclick: () => { state.stretchMode = mode; showStackPreview(); },
    }, [mode]));
  }
  controls.appendChild(toggle);
  controls.appendChild(el("a", {
    href: `/projects/${encodeURIComponent(state.project)}/download?path=${encodeURIComponent(path)}`,
    class: "mono",
  }, [el("button", { type: "button" }, ["⬇ Download full-resolution .fit"])]));
  previewEl.appendChild(controls);

  const url = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(path)}&stretch=${state.stretchMode}&t=${Date.now()}`;
  previewEl.appendChild(el("div", { class: "preview-frame" }, [el("img", { src: url }, [])]));
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
  renderStepper();
}

document.getElementById("project-select").addEventListener("change", async (e) => {
  state.project = e.target.value || null;
  document.getElementById("project-panels").style.display = state.project ? "block" : "none";
  document.getElementById("no-project-hint").style.display = state.project ? "none" : "block";
  mastersSelected.clear();
  analyzeSelected.clear();
  stackSelected.clear();
  state.excludeFrames.clear();
  state.analyzed = false;
  state.lastAnalyzeResult = null;
  state.showSurvivorsOnly = false;
  state.expandedGroups = {};
  state.activeStep = "stage";
  refreshExcludeDisplay();
  document.getElementById("stage-nights").innerHTML = "";
  addNightRow();
  document.getElementById("stage-summary").innerHTML = "";
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-result").innerHTML = "";
  document.getElementById("masters-result").innerHTML = "";
  document.getElementById("stack-result").innerHTML = "";
  showActiveStep();
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
})();
