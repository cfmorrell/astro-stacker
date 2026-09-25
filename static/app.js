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

// Shared by every per-session checklist/list in this app (Masters,
// Review's checklist AND its own per-session output blocks, Stack) - a
// project can span several nights, each with several filters (e.g.
// night 1 shot in S/H/O/L/R/G/B, night 2 just H/O), and each (night,
// filter) combo is its own independent session entry (see the
// Stage-time fan-out), so a project like that can easily have a dozen+
// entries. Listing them in raw staging order buries "all my H data"
// across however many other filters/nights sit between them - grouping
// by filter instead (the unit Stack eventually combines nights INTO)
// answers the question these views actually exist to answer: "is my H
// data, across every night I have it, ready?" A plain OSC project (no
// filters at all - the common case) gets no group headings at all,
// falling back to one implicit group so every caller can treat the
// return value uniformly either way. An OSC project split by exposure
// length instead of filter (see splitRowByExposure()) groups by
// `exposure_s` the same way, for the same reason - "is my 300s data
// ready?" is just as real a question once one project has more than one
// exposure length in play.
function groupNightsByFilter(nights) {
  if (nights.some((n) => n.filter)) {
    const byFilter = new Map();
    for (const n of nights) {
      const key = n.filter || "(no filter)";
      if (!byFilter.has(key)) byFilter.set(key, []);
      byFilter.get(key).push(n);
    }
    return Array.from(byFilter.entries())
      .sort(([a], [b]) => (a === "(no filter)" ? 1 : b === "(no filter)" ? -1 : a.localeCompare(b)))
      .map(([key, groupNights]) => ({ heading: `Filter: ${key}`, nights: groupNights }));
  }
  if (nights.some((n) => n.exposure_s != null) && new Set(nights.map((n) => n.exposure_s)).size > 1) {
    const byExposure = new Map();
    for (const n of nights) {
      const key = n.exposure_s != null ? formatExposure(n.exposure_s) : "(no exposure)";
      if (!byExposure.has(key)) byExposure.set(key, []);
      byExposure.get(key).push(n);
    }
    return Array.from(byExposure.entries())
      .sort(([a], [b]) => (a === "(no exposure)" ? 1 : b === "(no exposure)" ? -1 : a.localeCompare(b)))
      .map(([key, groupNights]) => ({ heading: `${key} exposure`, nights: groupNights }));
  }
  return [{ heading: null, nights }];
}

function isFrameFlagged(f) {
  // Computed client-side from the raw per-metric z-scores the server
  // already returned, rather than trusting the server's own `flagged`
  // boolean (computed at whatever anomaly_sigma the analyze request
  // used). z-scores themselves don't change with the threshold, so the
  // outlier-sensitivity slider can move live with no re-analyze round
  // trip - matches the server's own "flag if ANY metric crosses it" rule.
  //
  // A REAL bug lived here: this only ever checked z-scores against the
  // slider, silently dropping the server's OTHER, unconditional rule
  // (app/framestats.py's flag_anomalies(): "f.star_count == 0 or any(z >=
  // threshold ...)" - zero detections is its own unambiguous anomaly,
  // deliberately NOT gated on how extreme its z-score happens to be).
  // Confirmed on a real session: 4 tail frames with star_count=0 (a
  // corrupt/saturated capture) had a star_count z-score of only ~0.68 -
  // not statistically extreme relative to the rest of a night that
  // already had generally few detected stars - so they silently rendered
  // as NOT flagged even though the server's own `f.flagged` said
  // otherwise, and even though every OTHER metric for those frames was
  // `null` (excluded from anomaly_z entirely) and thus couldn't trigger
  // this check either. Checking star_count === 0 directly, unconditionally,
  // closes the gap regardless of what any metric's z-score comes out to.
  if (f.star_count === 0) return true;
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

async function pollJob(jobId, { progressEl, logViewEl, pipelineEl, onDone, lockButtons, ownerProject }) {
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
      // This app has ONE shared set of DOM elements for Stack/Masters/
      // Review, repainted for whichever project switchToProject() last
      // opened - not one tree per project. If the user has since
      // navigated to a DIFFERENT project, every element this loop was
      // given (progressEl, pipelineEl, lockButtons, and whatever onDone
      // touches - e.g. state.lastAnalyzeResult) now belongs to THAT
      // project, not this job's. Confirmed as a real bug (not
      // hypothetical): Chris ran an OSC stack, started staging a mono
      // project while it ran, and saw the OSC job's pipeline markers
      // painted onto the mono project's Stack panel once he opened it -
      // this loop had no idea he'd navigated away and kept writing into
      // the (now reassigned) shared elements regardless. Going quiet
      // once ownerProject no longer matches - rather than stopping the
      // poll outright - still lets onDone fire correctly if the user
      // switches BACK to this project before the job finishes.
      if (!ownerProject || state.project === ownerProject) {
        (lockButtons || []).forEach((b) => { b.disabled = false; });
        if (onDone) onDone({ status: "failed", error: String(e) });
      }
      return;
    }
    if (!ownerProject || state.project === ownerProject) {
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
    }
    if (snap.status === "succeeded" || snap.status === "failed") {
      if (!ownerProject || state.project === ownerProject) {
        (lockButtons || []).forEach((b) => { b.disabled = false; });
        if (onDone) onDone(snap);
      }
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
  btn.addEventListener("click", async () => {
    const isOpen = view.classList.contains("open");
    if (isOpen) {
      view.classList.remove("open");
      arrow.textContent = "▾";
      return;
    }
    // Always re-fetch rather than caching after the first load - this
    // view is shared across whichever project is currently open (see
    // switchToProject()'s reset), and caching once meant switching
    // projects and reopening this same panel kept showing the FIRST
    // project's rendered script forever. Rendering a script preview is
    // a cheap local template render, not a Siril run, so there's no real
    // cost to just always asking again.
    view.textContent = "loading…";
    try {
      view.textContent = await fetchFn();
    } catch (e) {
      view.textContent = String(e);
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

function attachFolderBrowser(inputEl, browseBtn, onSelect, options) {
  // `options.onUnselect`, when given, adds a third "Unselect" action
  // alongside "Use this folder"/"Cancel" - lets an OPTIONAL field (e.g.
  // per-group darks) be cleared from the exact same picker that sets it,
  // rather than a separate standalone "✕" button sitting next to other
  // buttons in the row (confusing once a row already has its own remove
  // button - Chris: "the multiple X buttons at the right is confusing").
  const onUnselect = options && options.onUnselect;
  async function open() {
    closeAnyBrowser();
    // Start browsing from this project's own root_dir (set at creation -
    // see the create-project flow below) rather than always the full
    // captures root, so picking lights/flats/darks/biases doesn't mean
    // walking the whole tree every time. Only a starting point, never a
    // restriction: the breadcrumb below still reaches anywhere else under
    // captures. Doesn't apply once a field already has its own value.
    let path = inputEl.value || (state.status && state.status.root_dir) || "";
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
      const actionButtons = [
        el("button", { class: "primary small", onclick: () => { inputEl.value = path; closeAnyBrowser(); if (onSelect) onSelect(data); } }, ["Use this folder"]),
        el("button", { class: "small ghost", onclick: () => closeAnyBrowser() }, ["Cancel"]),
      ];
      if (onUnselect) {
        actionButtons.push(el("button", { class: "small ghost", onclick: () => { closeAnyBrowser(); onUnselect(); } }, ["Unselect"]));
      }
      const actions = el("div", { style: "margin-top:8px; display:flex; gap:8px;" }, actionButtons);
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

// One-off captures folder pick, not tied to any persistent input field -
// used by the create-project flow below to choose a project's root_dir.
// Resolves the chosen path, or null if skipped. Shares the same
// /captures/browse + breadcrumb UI as attachFolderBrowser above, just
// resolving a promise instead of writing into an input on "use this".
function pickCapturesFolder(anchorEl) {
  return new Promise((resolve) => {
    closeAnyBrowser();
    let path = "";
    const panel = el("div", { class: "card", style: "position:fixed; z-index:50; min-width:280px;" }, []);
    document.body.appendChild(panel);
    const rect = anchorEl.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.left = `${rect.left}px`;
    window.__openBrowserPanel = panel;

    function finish(value) {
      closeAnyBrowser();
      resolve(value);
    }

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
        el("button", { class: "primary small", onclick: () => finish(path) }, ["Use this folder"]),
        el("button", { class: "small ghost", onclick: () => finish(null) }, ["Skip"]),
      ]);
      panel.appendChild(actions);
    }
    render();
  });
}

// ---------- project file browser (for Stack's master overrides) ----------

function attachFileBrowser(inputEl, browseBtn, startPath, onSelect) {
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
          onclick: () => { inputEl.value = f.abs_path; closeAnyBrowser(); if (onSelect) onSelect(f.abs_path); },
        }, [f.name]));
      }
      panel.appendChild(list);
      const actions = el("div", { style: "margin-top:8px; display:flex; gap:8px;" }, [
        el("button", { class: "small ghost", onclick: () => { inputEl.value = ""; closeAnyBrowser(); if (onSelect) onSelect(""); } }, ["✕ Clear (use default)"]),
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

function nextGroupNumber() {
  // Continue after whatever's already staged rather than always starting
  // from 1, so adding a group after removing one can't collide with a
  // group that's still there (e.g. group1 stays, group2 gets removed,
  // a new group becomes group3, not a second "group2"). Matches the old
  // "night" prefix too, so a project with groups staged before this
  // rename (still on disk as night1/night2/...) still numbers new ones
  // correctly instead of restarting at 1.
  const existing = (state.status ? state.status.nights : [])
    .map((n) => parseInt(n.name.replace(/^(group|night)/, ""), 10))
    .filter((x) => !isNaN(x));
  return (existing.length ? Math.max(...existing) : 0) + 1;
}

function renderExistingStagedNights() {
  const container = document.getElementById("stage-existing-nights");
  container.innerHTML = "";
  const nights = state.status ? state.status.nights : [];
  const biasesCount = state.status ? state.status.biases_count : 0;
  if (!nights.length && !biasesCount) {
    container.appendChild(el("span", { class: "empty-hint" }, ["None staged yet."]));
    return;
  }
  // Biases shown here too, not just groups - a REAL gap Chris caught:
  // this panel previously only ever listed nights/groups, so staged
  // biases were invisible here and had no way back to "not staged" short
  // of deleting the whole project (see the new DELETE /projects/{name}/
  // biases endpoint this pairs with).
  if (biasesCount) {
    container.appendChild(el("div", { class: "night-row", style: "justify-content:space-between;" }, [
      el("span", {}, [`Biases — ${biasesCount} frames`]),
      el("button", {
        type: "button", class: "small danger-outline",
        onclick: async () => {
          if (!confirm("Remove staged biases? This deletes the staged files and any built master bias. Cannot be undone.")) return;
          try {
            await api("DELETE", `/projects/${encodeURIComponent(state.project)}/biases`);
            await loadProjectStatus();
          } catch (e) {
            alert(`Remove failed: ${e}`);
          }
        },
      }, ["✕ Remove"]),
    ]));
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

// Lets each night use a different dark/flat than its normal default (its
// own dark, shared with any other night whose darks resolved to the same
// exposure length; its own flat) - e.g. a project spanning months where
// one night was shot at a different temperature, or a night that's
// missing its own flats and should borrow another night's. Saves immediately on
// each change (POSTing the complete current picture, not just what
// changed - see CalibrationOverridesRequest) rather than needing a
// separate save step.
function renderCalibrationAlignment(nights) {
  const container = document.getElementById("calibration-alignment");
  container.innerHTML = "";
  if (!nights.length) {
    container.appendChild(el("span", { class: "empty-hint" }, ["Stage at least one night first."]));
    return;
  }

  async function saveOverrides() {
    const night_dark_overrides = {};
    const night_flat_overrides = {};
    for (const row of Array.from(container.children)) {
      const darkVal = row.querySelector(".calib-dark-input").value.trim();
      const flatVal = row.querySelector(".calib-flat-input").value.trim();
      if (darkVal) night_dark_overrides[row.dataset.night] = darkVal;
      if (flatVal) night_flat_overrides[row.dataset.night] = flatVal;
    }
    try {
      await api("POST", `/projects/${encodeURIComponent(state.project)}/calibration-overrides`, { night_dark_overrides, night_flat_overrides });
    } catch (e) {
      alert(`Saving calibration alignment failed: ${e}`);
    }
  }

  for (const night of nights) {
    const darkInput = el("input", {
      type: "text", class: "dirpick calib-dark-input", placeholder: "default: this session's own dark",
      readonly: "readonly", value: night.dark_override || "",
    }, []);
    const flatInput = el("input", {
      type: "text", class: "dirpick calib-flat-input", placeholder: "default: this night's own flat",
      readonly: "readonly", value: night.flat_override || "",
    }, []);
    const darkBrowse = el("button", { type: "button", class: "small" }, ["…"]);
    const flatBrowse = el("button", { type: "button", class: "small" }, ["…"]);
    attachFileBrowser(darkInput, darkBrowse, "process", saveOverrides);
    attachFileBrowser(flatInput, flatBrowse, "process", saveOverrides);
    container.appendChild(el("div", { class: "night-row", "data-night": night.name }, [
      el("span", { class: "session-label" }, [nightDisplayLabel(night)]),
      el("div", { class: "dirpick-group" }, [
        el("span", { class: "dirpick-label" }, ["Dark"]),
        el("div", { class: "dirpick-row" }, [darkInput, darkBrowse]),
      ]),
      el("div", { class: "dirpick-group" }, [
        el("span", { class: "dirpick-label" }, ["Flat"]),
        el("div", { class: "dirpick-row" }, [flatInput, flatBrowse]),
      ]),
    ]));
  }
}

// Every draft session row currently in #stage-nights, tracked outside any
// one row's own closure so cross-row logic (auto-filling a row's darks
// from another row that already picked a matching-exposure one) can see
// every row at once. Only ever holds DRAFT rows (mirrors
// sessionWarningUpdaters' own scope) - already-staged nights shown in
// #stage-existing-nights are a separate, read-only display.
const nightRows = [];

// Cross-row darks auto-fill: once one row's darks resolve to an exposure
// length, every OTHER row whose own lights share that exposure and whose
// darks field is still EMPTY gets filled in too - Chris: "once the user
// has selected a dark at some exposure length, we could automatically
// fill the darks for all other exposures of that same length." Never
// overwrites a row that already has something in its darks field
// (manually picked or already auto-filled) - only ever fills a currently
// empty one. If more than one distinct darks folder would match (two
// different real folders both at this exposure), that's genuinely
// ambiguous - do nothing rather than guess, same "can't tell isn't wrong"
// rule already used throughout this app's own filter/exposure detection.
function autoFillMatchingDarks() {
  for (const target of nightRows) {
    if (target.darksInput.value.trim()) continue;
    const targetExposure = target.getLightsExposure();
    if (targetExposure == null) continue;
    const candidates = nightRows.filter((r) => {
      if (r === target) return false;
      const dir = r.darksInput.value.trim();
      if (!dir) return false;
      const exp = r.getDarksExposure();
      return exp != null && Math.abs(exp - targetExposure) <= 0.01;
    });
    const distinctDirs = new Set(candidates.map((r) => r.darksInput.value.trim()));
    if (distinctDirs.size !== 1) continue;
    const source = candidates[0];
    target.fillDarksFrom(
      source.darksInput.value.trim(),
      `Matched from ${source.getLabel()} (${formatExposure(targetExposure)} exposure)`
    );
  }
}

// The flats counterpart of the above - a REAL gap Chris hit: "when
// adding a second mono night, the lights get pulled from the folder into
// their respective filters, but the flats do not." Splitting a mixed
// lights folder into one row per filter only ever had LIGHTS info at
// split time (flats usually hasn't been picked yet) - each of the new
// rows then needed its OWN separate flats pick, once per filter, with no
// propagation. Matched differently than darks (by filter membership, not
// exposure): once ANY row's flats resolves to a folder that ALSO
// contains frames for another EMPTY-flats row's own locked filter, fill
// that row in too - each will independently cull to its own filter at
// stage time, exactly like the folder they were split from already does.
//
// Deliberately scoped to rows sharing the EXACT SAME lights folder path
// (i.e. genuinely split from the same physical night) - NOT just "any
// row anywhere whose flats happen to cover this filter." Real mono data
// confirms why this matters: each night has its own separate flats (dust/
// vignetting - and even each filter's own auto-exposure - genuinely
// changes night to night), so night 2's H group must never inherit night
// 1's H flats just because both are filter "H" - only true siblings from
// the same split should ever auto-fill each other.
function autoFillMatchingFlats() {
  for (const target of nightRows) {
    if (target.flatsInput.value.trim()) continue;
    const targetFilter = target.row.dataset.filter;
    if (!targetFilter) continue;
    const targetLightsDir = target.lightsInput.value.trim();
    if (!targetLightsDir) continue;
    const candidates = nightRows.filter((r) => {
      if (r === target) return false;
      if (r.lightsInput.value.trim() !== targetLightsDir) return false;
      const dir = r.flatsInput.value.trim();
      if (!dir) return false;
      const counts = r.getFlatsFilterCounts();
      return !!(counts && counts[targetFilter]);
    });
    const distinctDirs = new Set(candidates.map((r) => r.flatsInput.value.trim()));
    if (distinctDirs.size !== 1) continue;
    const source = candidates[0];
    target.fillFlatsFrom(source.flatsInput.value.trim(), `Matched from ${source.getLabel()} (filter ${targetFilter})`);
  }
}

// A filter code in ANY group's lights filenames is hard evidence of a
// filter wheel - i.e. mono, not OSC (see app/frameinfo.py's parse_filter()
// docstring: an OSC camera's filenames have nothing there at all, by
// construction). Only checked in this one direction - real evidence of a
// filter wheel contradicting a checked OSC box - not the reverse (no
// filter evidence detected + OSC unchecked), since plenty of legitimate
// mono setups never encode a filter code in their filenames at all
// (already an accepted limitation of the filter-detection feature
// itself); warning there would just be noisy false positives on ordinary,
// correctly-configured mono projects. Re-run on every filter-detection
// change, group add/remove, and OSC checkbox toggle.
function updateOscMismatchWarning() {
  const warningEl = document.getElementById("stage-osc-mismatch-warning");
  const oscCheckbox = document.getElementById("stage-is-osc");
  if (!warningEl || !oscCheckbox) return;
  // Checks both the CURRENT draft rows (about to be staged) and already-
  // staged groups (in case OSC got toggled after the fact) - either one
  // showing real filter evidence while OSC is checked is worth flagging.
  const draftHasFilter = nightRows.some((r) => r.row.dataset.filter);
  const stagedHasFilter = state.status && state.status.nights && state.status.nights.some((n) => n.filter);
  if (oscCheckbox.checked && (draftHasFilter || stagedHasFilter)) {
    warningEl.textContent = "⚠ These light frames look like mono (filter-wheel) data, not OSC — double check the checkbox above.";
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }
}
document.getElementById("stage-is-osc").addEventListener("change", updateOscMismatchWarning);

// Replaces the old inline filter-checkbox picker: rather than one row
// fanning out into several filters/exposures via checkboxes (doesn't
// scale past 2-3 - a real project can use all of L/R/G/B/H/S/O), a
// folder that resolves to more than one filter or exposure length splits
// into that many independent rows immediately, each with its own
// lights/flats/darks pickers - "for consistency's sake ... show a row
// per filter, whether they are in the same folder or nested deeper."
// Reuses the exact same addNightRow(initial) mechanism autoPopulateFromScan()
// already uses to generate rows programmatically.
function splitRowByFilters(sourceRow, { lightsDir, flatsDir }, filters) {
  for (const filter of filters) {
    addNightRow({ lightsDir, flatsDir, filter });
  }
  sourceRow.remove();
  sourceRow._cleanup();
  renumberGroups();
  updateOscMismatchWarning();
}

// The OSC counterpart: a lights folder with no filter-wheel evidence at
// all but more than one detected exposure length (e.g. 60s and 300s subs
// of the same target mixed together) splits by exposure instead of
// filter, for the identical reason - each exposure length needs its own
// dark, so each gets its own session.
function splitRowByExposure(sourceRow, { lightsDir, flatsDir }, exposures) {
  for (const exposureS of exposures) {
    addNightRow({ lightsDir, flatsDir, exposureS });
  }
  sourceRow.remove();
  sourceRow._cleanup();
  renumberGroups();
  updateOscMismatchWarning();
}

function addNightRow(initial) {
  const container = document.getElementById("stage-nights");
  // Continue after whatever's already staged, not just count draft rows
  // in this form: opening a project that already has group1/group2
  // staged should offer "Group 3" for a new one, not restart at 1.
  const sessionNum = nextGroupNumber() + container.children.length;
  const groupNumberEl = el("span", { class: "group-number" }, [`Group ${sessionNum}`]);
  // Whichever of filter/exposure/night actually makes this group distinct
  // from any other - Chris: "each session that points to a particular
  // exposure, night, or filter, should be clearly annotated." Filled in
  // by updateGroupAnnotation() below once there's something to show;
  // blank (no dash, nothing extra) for a plain single-group OSC project
  // with nothing to disambiguate.
  const groupAnnotationEl = el("span", { class: "group-annotation" }, []);
  const label = el("span", { class: "session-label" }, [groupNumberEl, groupAnnotationEl]);
  function updateGroupAnnotation() {
    let text = "";
    if (row.dataset.filter) {
      text = `Filter ${row.dataset.filter}`;
    } else if (row.dataset.exposureS) {
      text = formatExposure(parseFloat(row.dataset.exposureS));
    } else if (lightsInput.value) {
      // Falls back to the picked lights folder's own parent name (e.g.
      // "2025-10-04-HeartNebula-2600MM-WO61") as the "which night is
      // this" identifier once there's no filter/exposure tag to show.
      const parts = lightsInput.value.split("/");
      text = parts.length > 1 ? parts[parts.length - 2] : "";
    }
    groupAnnotationEl.textContent = text ? ` — ${text}` : "";
  }
  const row = el("div", { class: "night-row" }, []);
  // A persistent "Lights"/"Flats"/"Darks" label above each field, not
  // just placeholder text: placeholder text disappears the moment a
  // folder is picked (readonly inputs show the selected path, not a hint
  // anymore), which was the whole problem - nothing left on screen said
  // which side was which once all three were filled in.
  const lightsInput = el("input", { type: "text", class: "dirpick", placeholder: "e.g. Night 1/lights", readonly: "readonly" }, []);
  const flatsInput = el("input", { type: "text", class: "dirpick", placeholder: "e.g. Night 1/flats", readonly: "readonly" }, []);
  const lightsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const flatsBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const mismatchWarning = el("div", { class: "session-mismatch-warning", style: "display:none;" }, []);
  let lightsDetectedType = null;
  let flatsDetectedType = null;
  let lightsDetectedExposureS = null;
  let lightsSampleDateObs = null;
  let lightsSampleInstrument = null;
  let flatsSampleDateObs = null;
  let flatsSampleInstrument = null;
  // A filter-wheel camera's lights/flats folders can mix several filters
  // together (e.g. narrowband H/O/S all in one "Light" folder) - see
  // app/frameinfo.py's detect_filters()/count_filters(). An OSC camera
  // has no filter wheel at all, but can still mix multiple LIGHT exposure
  // lengths together the same way (e.g. 60s and 300s subs of the same
  // target) - see detect_exposures()/count_exposures(). Lights and flats
  // are two SEPARATE folder picks, each with their own detected filter
  // set/counts, tracked independently since there's no guarantee they
  // agree; exposures are tracked from LIGHTS only (a flat's own exposure
  // is unrelated to the light sub length it calibrates).
  let lightsDetectedFilters = [];
  let flatsDetectedFilters = [];
  let lightsFilterCounts = {};
  let flatsFilterCounts = {};
  let lightsDetectedExposures = [];
  let lightsExposureCounts = {};
  // Each detected filter's OWN dominant exposure (e.g. {"H": 300, "L":
  // 180} - see app/frameinfo.py's detect_exposure_by_filter()). A REAL
  // bug this fixes: a folder mixing filters that use DIFFERENT exposures
  // (real narrowband H/O/S at 300s + L at 180s in one "Light" folder) can
  // have NO single dominant exposure across ALL files at once (confirmed
  // on real data: 300s covered only 85.5% of files, just under the 90%
  // threshold), leaving lightsDetectedExposureS null even though this
  // filter-locked row's OWN true exposure is perfectly well-known.
  // effectiveLightsExposure() below is what every consumer (the darks
  // mismatch warning, cross-row darks auto-fill, and the summary display)
  // should read instead of the raw lightsDetectedExposureS.
  let lightsFilterExposures = {};
  function effectiveLightsExposure() {
    if (row.dataset.filter && lightsFilterExposures[row.dataset.filter] != null) {
      return lightsFilterExposures[row.dataset.filter];
    }
    return lightsDetectedExposureS;
  }
  // The raw /captures/browse response for whichever folder is currently
  // picked, kept around so the summary line can be RECOMPUTED once this
  // row's filter/exposure lock is actually known - fixes a real bug: a
  // mixed H/O/S folder's own fit_count (e.g. 30) was being shown
  // verbatim even after this row split into a single-filter group that
  // only actually stages that filter's own subset (e.g. 10) - see
  // refreshLightsSummary()/refreshFlatsSummary() below.
  let lastLightsData = null;
  let lastFlatsData = null;
  function refreshLightsSummary() {
    if (!lastLightsData) { lightsSummary.textContent = ""; return; }
    let overrides;
    if (row.dataset.filter) {
      overrides = { count: lightsFilterCounts[row.dataset.filter] || 0, exposureS: effectiveLightsExposure() };
    } else if (row.dataset.exposureS) {
      const exposureS = parseFloat(row.dataset.exposureS);
      overrides = { count: findCountForExposure(lightsExposureCounts, exposureS) || 0, exposureS };
    }
    lightsSummary.textContent = formatFolderSummary(lastLightsData, overrides);
  }
  function refreshFlatsSummary() {
    if (!lastFlatsData) { flatsSummary.textContent = ""; return; }
    const overrides = row.dataset.filter ? { count: flatsFilterCounts[row.dataset.filter] || 0 } : undefined;
    flatsSummary.textContent = formatFolderSummary(lastFlatsData, overrides);
  }
  // This row's own picked darks - genuinely per-session now (unlike
  // biases, which stay one global picker below), since different
  // filters/exposure lengths commonly need different master darks. Same
  // detected-type/exposure/date/camera tracking as lights/flats, feeding
  // the same combined warning box.
  let darksDetectedType = null;
  let darksDetectedExposureS = null;
  let darksSampleDateObs = null;
  let darksSampleInstrument = null;
  // Set once this row is locked to a single filter or (OSC) a single
  // exposure length - either directly (only one detected) or as the
  // result of a split (see maybeSplitRow()/splitRowByFilters()/
  // splitRowByExposure() below). row.dataset.filter/.exposureS (NOT the
  // old plural "filters" checkbox list - that picker is gone) are what
  // the stage-btn handler reads to build this row's NightSource.
  // splitDone guards against a genuine race: lights and flats each fire
  // their own independent folder-browse callback, and either one alone
  // could decide this row needs to split - without this flag, both firing
  // in quick succession (e.g. from autoPopulateFromScan()'s concurrent
  // lights+flats fetches) could each trigger their OWN split, doubling
  // the resulting rows.
  let splitDone = false;
  function maybeSplitRow() {
    if (splitDone || row.dataset.filter || row.dataset.exposureS) return false;
    const filters = Array.from(new Set([...lightsDetectedFilters, ...flatsDetectedFilters])).sort();
    if (filters.length > 1) {
      splitDone = true;
      splitRowByFilters(row, { lightsDir: lightsInput.value, flatsDir: flatsInput.value }, filters);
      return true;
    }
    if (filters.length === 1) {
      row.dataset.filter = filters[0];
      return false;
    }
    // No filter-wheel evidence at all - OSC path. Only lights' own
    // exposures matter here (flats are never exposure-split - see above).
    if (lightsDetectedExposures.length > 1) {
      splitDone = true;
      splitRowByExposure(row, { lightsDir: lightsInput.value, flatsDir: flatsInput.value }, lightsDetectedExposures);
      return true;
    }
    if (lightsDetectedExposures.length === 1) {
      row.dataset.exposureS = String(lightsDetectedExposures[0]);
      return false;
    }
    return false;
  }
  // Not a hard block - Chris explicitly wants these catchable but still
  // possible (e.g. deliberately reusing one night's flats for another, or
  // unusual filenames that don't include a type keyword). Combines several
  // independent checks into one message so picking any field re-evaluates
  // all of them without stacking multiple warning lines:
  // 1) same parent folder = same session, matching how a real capture
  //    folder is normally laid out (Night 1/{lights,flats}) - catches a
  //    misclick like night1 lights + night2 flats;
  // 2) the folder's filenames actually look like the type being picked
  //    for (most capture software puts "Light"/"Flat"/etc. right in the
  //    name - see _detect_frame_type() in app/main.py);
  // 3) this session's lights exposure matches ITS OWN darks exposure
  //    (darks calibrate out sensor noise at a SPECIFIC exposure length -
  //    a mismatch here silently produces a badly-calibrated stack, not
  //    an error, so it's worth flagging same as the others);
  // 4) these flats' actual FITS capture date (not filename - see
  //    app/fitsinfo.py) is within a day of the lights', since flats
  //    correct dust/vignetting that can change session to session;
  // 5) darks/bias aren't more than a year older or a month newer than
  //    these lights - sensor characteristics drift over that kind of
  //    span, same reasoning as the flats date check but a looser window
  //    since dark/bias frames are valid for longer than a single flat is;
  // 6) every calibration frame type was shot on the SAME PHYSICAL CAMERA
  //    as these lights (FITS INSTRUME, e.g. "ZWO ASI2600MC Duo") - the
  //    one thing no filename convention encodes, and the most serious
  //    mistake to catch (pointing at a completely different camera's
  //    calibration library, not just an out-of-date one);
  // 7) this row is locked to a specific filter or exposure length (from a
  //    previous split) but a LATER re-pick of lights/flats/darks no
  //    longer actually contains any matching frames - warn rather than
  //    silently letting a later real stage-time error (zero matches) be
  //    the only signal.
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
    const thisLightsExposure = effectiveLightsExposure();
    if (thisLightsExposure != null && darksDetectedExposureS != null && Math.abs(thisLightsExposure - darksDetectedExposureS) > 0.01) {
      messages.push(`These lights are ${formatExposure(thisLightsExposure)} exposures, but this session's darks are ${formatExposure(darksDetectedExposureS)} — they won't calibrate correctly.`);
    }
    const lightsDate = parseFitsDate(lightsSampleDateObs);
    const flatsDate = parseFitsDate(flatsSampleDateObs);
    if (lightsDate && flatsDate && Math.abs(daysBetween(lightsDate, flatsDate)) > 1) {
      messages.push("These flats look like they're from a different session than the lights (more than a day apart) — flats correct dust/vignetting that can change from one session to the next.");
    }
    if (lightsSampleInstrument && flatsSampleInstrument && lightsSampleInstrument !== flatsSampleInstrument) {
      messages.push(`These flats look like they're from a different camera (${flatsSampleInstrument}) than the lights (${lightsSampleInstrument}).`);
    }
    const darksDate = parseFitsDate(darksSampleDateObs);
    if (lightsDate && darksDate) {
      if (daysBetween(darksDate, lightsDate) > 365) messages.push("This session's darks are over a year older than the lights they'd calibrate.");
      else if (daysBetween(lightsDate, darksDate) > 30) messages.push("This session's darks are more than a month newer than the lights they'd calibrate.");
    }
    if (lightsSampleInstrument && darksSampleInstrument && lightsSampleInstrument !== darksSampleInstrument) {
      messages.push(`This session's darks look like they're from a different camera (${darksSampleInstrument}) than the lights (${lightsSampleInstrument}).`);
    }
    const biasDate = parseFitsDate(biasesSampleDateObs);
    if (lightsDate && biasDate) {
      if (daysBetween(biasDate, lightsDate) > 365) messages.push("The bias frames are over a year older than the lights they'd calibrate.");
      else if (daysBetween(lightsDate, biasDate) > 30) messages.push("The bias frames are more than a month newer than the lights they'd calibrate.");
    }
    if (lightsSampleInstrument && biasesSampleInstrument && lightsSampleInstrument !== biasesSampleInstrument) {
      messages.push(`The bias frames look like they're from a different camera (${biasesSampleInstrument}) than the lights (${lightsSampleInstrument}).`);
    }
    if (row.dataset.filter && lightsDetectedFilters.length && !lightsFilterCounts[row.dataset.filter]) {
      messages.push(`This session is locked to filter ${row.dataset.filter}, but the lights folder you picked has no ${row.dataset.filter} frames.`);
    }
    if (row.dataset.filter && flatsDetectedFilters.length && !flatsFilterCounts[row.dataset.filter]) {
      messages.push(`This session is locked to filter ${row.dataset.filter}, but the flats folder you picked has no ${row.dataset.filter} frames.`);
    }
    if (row.dataset.exposureS && lightsDetectedExposures.length && !lightsDetectedExposures.some((e) => Math.abs(e - parseFloat(row.dataset.exposureS)) <= 0.01)) {
      messages.push(`This session is locked to a ${formatExposure(parseFloat(row.dataset.exposureS))} exposure, but the lights folder you picked has no frames at that exposure.`);
    }
    if (messages.length) {
      mismatchWarning.textContent = "⚠ " + messages.join(" ") + " Double check you picked the right folders.";
      mismatchWarning.style.display = "block";
    } else {
      mismatchWarning.style.display = "none";
    }
  }
  const lightsSummary = el("div", { class: "dirpick-summary" }, []);
  const flatsSummary = el("div", { class: "dirpick-summary" }, []);
  const flatsProvenance = el("div", { class: "dirpick-provenance" }, []);
  sessionWarningUpdaters.push(updateSessionWarnings);
  attachFolderBrowser(lightsInput, lightsBrowse, (data) => {
    if (splitDone) return;
    lightsDetectedType = data.detected_type;
    lightsDetectedExposureS = data.detected_exposure_s;
    lightsSampleDateObs = data.sample_date_obs;
    lightsSampleInstrument = data.sample_instrument;
    lightsDetectedFilters = data.detected_filters || [];
    lightsFilterCounts = data.filter_counts || {};
    lightsDetectedExposures = data.detected_exposures || [];
    lightsExposureCounts = data.exposure_counts || {};
    lightsFilterExposures = data.filter_exposures || {};
    lastLightsData = data;
    if (maybeSplitRow()) return;
    refreshLightsSummary();
    updateGroupAnnotation();
    updateSessionWarnings();
    autoFillMatchingDarks();
    updateOscMismatchWarning();
  });
  function processFlatsData(data, provenanceText) {
    flatsDetectedType = data.detected_type;
    flatsSampleDateObs = data.sample_date_obs;
    flatsSampleInstrument = data.sample_instrument;
    flatsDetectedFilters = data.detected_filters || [];
    flatsFilterCounts = data.filter_counts || {};
    lastFlatsData = data;
    flatsProvenance.textContent = provenanceText || "";
    refreshFlatsSummary();
    updateSessionWarnings();
  }
  // Shared by the manual pick, the scan-proposed prefill below, AND
  // autoFillMatchingFlats() - one path in, always the same processing.
  function fillFlatsFrom(path, provenanceText) {
    flatsInput.value = path;
    api("GET", `/captures/browse?path=${encodeURIComponent(path)}`).then((data) => {
      processFlatsData(data, provenanceText);
      autoFillMatchingFlats();
    }).catch(() => {});
  }
  // Clearing flats leaves this row's filter/exposure lock exactly as it
  // is (that's decided by lights, not flats) - it just reverts flats to
  // "not yet picked," same incomplete state as a fresh row, until picked
  // again (staging already skips a row missing either lights or flats).
  // NOT followed by autoFillMatchingFlats() - same reasoning as darks'
  // own clearDarksForRow(): re-running auto-fill right after a manual
  // clear could immediately refill this row from a sibling that still has
  // a matching flats folder, making Unselect look like it does nothing.
  function clearFlatsForRow() {
    flatsInput.value = "";
    flatsDetectedType = null;
    flatsSampleDateObs = null;
    flatsSampleInstrument = null;
    flatsDetectedFilters = [];
    flatsFilterCounts = {};
    lastFlatsData = null;
    flatsProvenance.textContent = "";
    refreshFlatsSummary();
    updateSessionWarnings();
  }
  attachFolderBrowser(
    flatsInput, flatsBrowse,
    (data) => {
      if (splitDone) return;
      processFlatsData(data, ""); // a manual pick is never "found for you" - no caption
      if (maybeSplitRow()) return;
      updateGroupAnnotation();
      autoFillMatchingFlats();
    },
    { onUnselect: clearFlatsForRow }
  );
  // Input row directly under the label, summary/details BELOW the picker -
  // Chris: "the row of pickers should be even... move the extra details
  // (frame count, exposure, date...) under the picker box." Keeps every
  // picker's own input+browse button lined up at the same height instead
  // of being pushed down by however many detail lines happen to be
  // showing above it.
  const lightsGroup = el("div", { class: "dirpick-group" }, [
    el("span", { class: "dirpick-label" }, ["Lights"]),
    el("div", { class: "dirpick-row" }, [lightsInput, lightsBrowse]),
    lightsSummary,
  ]);
  const flatsGroup = el("div", { class: "dirpick-group" }, [
    el("span", { class: "dirpick-label" }, ["Flats"]),
    el("div", { class: "dirpick-row" }, [flatsInput, flatsBrowse]),
    flatsSummary,
    flatsProvenance,
  ]);

  // Per-group darks picker (replaces the old project-wide #darks-dir
  // field) - optional (staging with none is a normal, supported case,
  // same as flats - the placeholder text says so, the label doesn't need
  // to). "Unselect" lives INSIDE this picker's own browse popup (alongside
  // "Use this folder"/"Cancel") rather than a separate standalone "✕" next
  // to the input - Chris: "the multiple X buttons at the right is
  // confusing." A provenance caption distinguishes a manual pick from one
  // this app filled in for you (scan-proposed, or cross-row
  // exposure-matched - see autoFillMatchingDarks()) so it's never a
  // mystery where a pre-filled path came from.
  const darksInput = el("input", { type: "text", class: "dirpick", placeholder: "optional", readonly: "readonly" }, []);
  const darksBrowse = el("button", { type: "button", class: "small" }, ["…"]);
  const darksSummary = el("div", { class: "dirpick-summary" }, []);
  const darksProvenance = el("div", { class: "dirpick-provenance" }, []);
  const darksTypeWarning = el("div", { class: "session-mismatch-warning", style: "display:none;" }, []);

  function processDarksData(data, provenanceText) {
    darksDetectedType = data.detected_type;
    darksDetectedExposureS = data.detected_exposure_s;
    darksSampleDateObs = data.sample_date_obs;
    darksSampleInstrument = data.sample_instrument;
    darksSummary.textContent = formatFolderSummary(data);
    warnIfWrongType("dark", data.detected_type, darksTypeWarning);
    darksProvenance.textContent = provenanceText || "";
    updateSessionWarnings();
  }
  // Shared by a scan-proposed prefill, autoFillMatchingDarks(), AND the
  // manual browse callback below - one path in, always the same
  // processing, so nothing gets a free pass depending on how it got set.
  function fillDarksFrom(path, provenanceText) {
    darksInput.value = path;
    api("GET", `/captures/browse?path=${encodeURIComponent(path)}`).then((data) => {
      processDarksData(data, provenanceText);
    }).catch(() => {});
  }
  // NOT followed by autoFillMatchingDarks() - a REAL bug Chris hit
  // ("unselect darks is broken when another session auto matches to
  // it"): if another row still has a matching-exposure darks value set,
  // re-running auto-fill right after a manual clear would immediately
  // refill this row from that other row, making Unselect look like it
  // does nothing at all. Unselect must be the user's own clean, final
  // word on this row's darks - it never triggers a fresh auto-fill pass.
  function clearDarksForRow() {
    darksInput.value = "";
    darksSummary.textContent = "";
    darksProvenance.textContent = "";
    darksTypeWarning.style.display = "none";
    darksDetectedType = null;
    darksDetectedExposureS = null;
    darksSampleDateObs = null;
    darksSampleInstrument = null;
    updateSessionWarnings();
  }
  attachFolderBrowser(
    darksInput, darksBrowse,
    (data) => {
      processDarksData(data, ""); // a manual pick is never "found for you" - no caption
      autoFillMatchingDarks();
    },
    { onUnselect: clearDarksForRow }
  );
  const darksGroup = el("div", { class: "dirpick-group" }, [
    el("span", { class: "dirpick-label" }, ["Darks"]),
    el("div", { class: "dirpick-row" }, [darksInput, darksBrowse]),
    darksSummary,
    darksProvenance,
  ]);

  const removeBtn = el("button", {
    type: "button", class: "small ghost",
    onclick: () => {
      row.remove();
      row._cleanup();
      renumberGroups();
      updateOscMismatchWarning();
    },
  }, ["✕"]);
  row.append(label, lightsGroup, flatsGroup, darksGroup, removeBtn, mismatchWarning, darksTypeWarning);
  container.appendChild(row);

  // Exposed so splitRowByFilters()/splitRowByExposure() (which only have
  // the `row` DOM element, not this closure) and the remove button above
  // can both tear down this row's entries in the shared module-level
  // arrays without duplicating the bookkeeping in three places.
  row._cleanup = () => {
    const idx = sessionWarningUpdaters.indexOf(updateSessionWarnings);
    if (idx !== -1) sessionWarningUpdaters.splice(idx, 1);
    const rIdx = nightRows.indexOf(rowState);
    if (rIdx !== -1) nightRows.splice(rIdx, 1);
  };
  const rowState = {
    row,
    lightsInput,
    flatsInput,
    darksInput,
    fillDarksFrom,
    fillFlatsFrom,
    getLightsExposure: () => effectiveLightsExposure(),
    getDarksExposure: () => darksDetectedExposureS,
    getFlatsFilterCounts: () => flatsFilterCounts,
    getLabel: () => row.querySelector(".session-label")?.textContent.trim() || "this group",
  };
  nightRows.push(rowState);

  // Pre-filled by Stage's auto-detect scan (see autoPopulateFromScan())
  // rather than a manual folder-browser pick, OR by splitRowByFilters()/
  // splitRowByExposure() when a mixed folder just got split into one row
  // per filter/exposure - runs the EXACT SAME metadata fetch + warning
  // checks a manual pick would, so a pre-filled row gets no free pass on
  // the type/exposure/date/camera checks everything else here already
  // goes through. A split-generated row's filter/exposure tag is applied
  // up front (before either async fetch resolves) so maybeSplitRow()
  // never mistakes an already-decided row for one still needing a split.
  if (initial) {
    if (initial.filter) row.dataset.filter = initial.filter;
    if (initial.exposureS != null) row.dataset.exposureS = String(initial.exposureS);
    updateGroupAnnotation();
    if (initial.lightsDir) {
      lightsInput.value = initial.lightsDir;
      api("GET", `/captures/browse?path=${encodeURIComponent(initial.lightsDir)}`).then((data) => {
        if (splitDone) return;
        lightsDetectedType = data.detected_type;
        lightsDetectedExposureS = data.detected_exposure_s;
        lightsSampleDateObs = data.sample_date_obs;
        lightsSampleInstrument = data.sample_instrument;
        lightsDetectedFilters = data.detected_filters || [];
        lightsFilterCounts = data.filter_counts || {};
        lightsDetectedExposures = data.detected_exposures || [];
        lightsExposureCounts = data.exposure_counts || {};
        lightsFilterExposures = data.filter_exposures || {};
        lastLightsData = data;
        if (maybeSplitRow()) return;
        refreshLightsSummary();
        updateGroupAnnotation();
        updateSessionWarnings();
        autoFillMatchingDarks();
        updateOscMismatchWarning();
      }).catch(() => {});
    }
    if (initial.flatsDir) {
      flatsInput.value = initial.flatsDir;
      api("GET", `/captures/browse?path=${encodeURIComponent(initial.flatsDir)}`).then((data) => {
        if (splitDone) return;
        processFlatsData(data, "");
        if (maybeSplitRow()) return;
        autoFillMatchingFlats();
      }).catch(() => {});
    } else {
      // No flats folder known yet for this freshly split/scanned row -
      // check whether a SIBLING row (created in the same split, or
      // already staged) already has a matching-filter flats folder
      // picked, and borrow it - the cross-row counterpart of darks'
      // auto-fill, closing the gap Chris hit: "when adding a second mono
      // night, the lights get pulled into their respective filters, but
      // the flats do not."
      autoFillMatchingFlats();
    }
    if (initial.darksDir) {
      fillDarksFrom(initial.darksDir, "Found automatically at this path");
    }
    if (initial.darksDir) {
      fillDarksFrom(initial.darksDir, "Found automatically at this path");
    }
  }
}

function renumberGroups() {
  const base = nextGroupNumber();
  const rows = document.getElementById("stage-nights").children;
  Array.from(rows).forEach((row, i) => {
    const numberEl = row.querySelector(".group-number");
    if (numberEl) numberEl.textContent = `Group ${base + i}`;
  });
}

document.getElementById("add-night-btn").addEventListener("click", () => addNightRow());
function formatExposure(seconds) {
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds}s`;
}

// One line of "what did we actually find in this folder" - shown above
// each Lights/Flats/Biases/Darks picker the moment a folder's been
// picked (manually or via Stage's auto-detect), so Chris doesn't have to
// open a folder browser again just to remember what's in there. Frame
// count always shows if there's anything to show at all; exposure/date
// only show when they could actually be determined (see
// app/frameinfo.py/app/fitsinfo.py's own "can't tell isn't wrong" rule -
// same thing applies to just not showing a line for it here).
function formatFolderSummary(data, overrides) {
  if (!data || !data.fit_count) return "";
  // `overrides` lets a caller show the count/exposure that actually
  // apply to a specific filter/exposure-locked group rather than the raw
  // whole-folder totals - see addNightRow()'s refreshLightsSummary()/
  // refreshFlatsSummary(), which is the only caller that ever passes this.
  const count = overrides && overrides.count != null ? overrides.count : data.fit_count;
  const exposureS = overrides && overrides.exposureS !== undefined ? overrides.exposureS : data.detected_exposure_s;
  const parts = [`${count} frame${count === 1 ? "" : "s"}`];
  if (exposureS != null) parts.push(formatExposure(exposureS));
  if (data.sample_date_obs) parts.push(data.sample_date_obs.slice(0, 10));
  return parts.join(" · ");
}

// Matches an exposure-length key from /captures/browse's exposure_counts
// (JSON round-trips a Python float dict key as a STRING, e.g. "300.0")
// against a target float value within the same tolerance used everywhere
// else in this app, rather than relying on exact string formatting to
// happen to line up.
function findCountForExposure(exposureCounts, exposureS) {
  for (const [key, count] of Object.entries(exposureCounts || {})) {
    if (Math.abs(parseFloat(key) - exposureS) <= 0.01) return count;
  }
  return undefined;
}

// FITS DATE-OBS has no trailing "Z" but IS UTC per the FITS standard -
// same parsing convention as formatCaptured() elsewhere in this file.
function parseFitsDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return isNaN(d.getTime()) ? null : d;
}

// Positive when b is after a, in days.
function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / 86400000;
}

function warnIfWrongType(expected, detectedType, warningEl) {
  if (detectedType && detectedType !== expected) {
    const what = detectedType === "mixed" ? "a mix of frame types, not consistently" : `${detectedType} frames, not`;
    warningEl.textContent = `⚠ This folder's filenames look like ${what} ${expected}s — double check you picked the right folder.`;
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }
}

// Bias's own detected exposure/date/camera, remembered so each session's
// lights picker (added below) can warn if it doesn't match - bias stays
// staged once per project (unlike darks, now per-session - see
// addNightRow()), so this has to live above any one session row.
// Re-checked against every already-rendered row's lights whenever bias
// changes, via sessionWarningUpdaters (not just forward, in case it gets
// (re)picked after sessions already exist).
let biasesSampleDateObs = null;
let biasesSampleInstrument = null;
const sessionWarningUpdaters = [];

// Named (not inline) so autoPopulateFromScan() below can run the exact
// same processing for a scan-proposed path as a manual folder-browser
// pick would - an auto-populated field gets no free pass on these checks.
function onBiasesPicked(data) {
  warnIfWrongType("bias", data.detected_type, document.getElementById("biases-type-warning"));
  biasesSampleDateObs = data.sample_date_obs;
  biasesSampleInstrument = data.sample_instrument;
  document.getElementById("biases-summary").textContent = formatFolderSummary(data);
  sessionWarningUpdaters.forEach((fn) => fn());
}
// Optional (staging with none is a normal, supported case - see the
// stage-btn handler's `|| null`), but until this there was no way back to
// "nothing selected" short of re-picking a different real folder - an
// inadvertent pick had nowhere to go. Same reset switchToProject() already
// does when leaving a project, just triggerable on demand here too. Lives
// inside the browse popup's own "Unselect" button now (mirrors darks/
// flats - Chris: "for consistency's sake, remove the X from biases and go
// to the unselect button inside the picker"), not a separate standalone
// "✕" next to the field.
function clearBiases() {
  document.getElementById("biases-dir").value = "";
  document.getElementById("biases-summary").textContent = "";
  document.getElementById("biases-type-warning").style.display = "none";
  biasesSampleDateObs = null;
  biasesSampleInstrument = null;
  sessionWarningUpdaters.forEach((fn) => fn());
}
attachFolderBrowser(
  document.getElementById("biases-dir"), document.getElementById("biases-browse"),
  onBiasesPicked,
  { onUnselect: clearBiases }
);

// Stage's "best effort" auto-detect: given the root folder chosen at
// project creation, ask the backend to propose a staging plan (see
// app/autostage.py for the actual algorithm and its deliberately
// conservative rules) and pre-populate Stage's fields from it - one
// picked root folder instead of clicking through the folder picker once
// per lights/flats/darks/biases field. Every candidate still goes
// through the SAME detection + warning checks a manual pick would (see
// addNightRow()'s `initial` handling and onBiasesPicked above), and every
// candidate can be edited or removed exactly like a manually-added one -
// this only ever saves clicks, it never bypasses review.
async function autoPopulateFromScan(rootDir) {
  let scan;
  try {
    scan = await api("GET", `/captures/scan?path=${encodeURIComponent(rootDir)}`);
  } catch (e) {
    return; // a failed scan just leaves Stage empty, same as skipping root_dir entirely
  }
  if (!scan.sessions.length && !scan.biases_dir) return;

  if (scan.biases_dir) {
    document.getElementById("biases-dir").value = scan.biases_dir;
    api("GET", `/captures/browse?path=${encodeURIComponent(scan.biases_dir)}`).then(onBiasesPicked).catch(() => {});
  }
  if (scan.sessions.length) {
    // switchToProject() already seeded one blank draft "Group 1" row
    // before this ever runs - without clearing it first, real
    // auto-detected data would land as "Group 2" behind an empty
    // "Group 1" (confirmed as a real bug on an OSC project with
    // exactly one group, not just a multi-group cosmetic issue).
    const container = document.getElementById("stage-nights");
    Array.from(container.children).forEach((row) => {
      const inputs = row.querySelectorAll("input");
      if (!inputs[0].value && !inputs[1].value) {
        row.remove();
        row._cleanup();
      }
    });
    // darks_dir is per-session now (see app/autostage.py's per-session
    // pairing cascade) - undefined/null just leaves that row's darks
    // picker empty, same as a session with no darks candidate found.
    for (const session of scan.sessions) {
      addNightRow({ lightsDir: session.lights_dir, flatsDir: session.flats_dir, darksDir: session.darks_dir || null });
    }
    renumberGroups();
  }
  // Give the per-field async /captures/browse fetches above a moment to
  // land before re-checking the cross-field warnings (darks exposure/
  // date/camera vs each session's lights) - a short fixed delay rather
  // than tracking every individual promise, since this is a best-effort
  // UX nicety on top of an already-async scan, not something that needs
  // to be perfectly synchronized.
  setTimeout(() => sessionWarningUpdaters.forEach((fn) => fn()), 800);

  const note = document.getElementById("stage-autopopulate-note");
  if (note) note.style.display = "block";
}

document.getElementById("stage-btn").addEventListener("click", async () => {
  if (!state.project) return;
  // Each row is already locked to at most one filter or one exposure
  // length by the time it reaches here (see addNightRow()'s
  // maybeSplitRow() - a mixed folder splits into one row per filter/
  // exposure the moment it's detected, so there's no ambiguous "pending"
  // state left to block on the way the old checkbox picker needed to).
  let nextNum = nextGroupNumber();
  const nights = nightRows
    .map((r) => {
      const lights_dir = r.lightsInput.value.trim();
      const flats_dir = r.flatsInput.value.trim();
      if (!lights_dir || !flats_dir) return null;
      return {
        lights_dir,
        flats_dir,
        darks_dir: r.darksInput.value.trim() || null,
        filter: r.row.dataset.filter || null,
        exposure_s: r.row.dataset.exposureS ? parseFloat(r.row.dataset.exposureS) : null,
      };
    })
    .filter((n) => n !== null)
    .map((n) => ({ ...n, name: `group${nextNum++}` }));

  const body = {
    biases_dir: document.getElementById("biases-dir").value.trim() || null,
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
  if (staged.nights) {
    Object.entries(staged.nights).forEach(([name, counts], i) => {
      const darksPart = counts.darks !== undefined ? `, ${counts.darks} darks` : "";
      rows.push(`Group ${i + 1} (${name}) — ${counts.lights} lights, ${counts.flats} flats${darksPart}`);
    });
  }
  const wrap = el("div", { class: "stage-summary" }, []);
  for (const r of rows) {
    wrap.appendChild(el("div", { class: "stage-summary-row" }, [el("span", { class: "ok-dot" }, ["✓"]), r]));
  }
  summaryEl.appendChild(wrap);
}

// ---------- night checklists (shared pattern) ----------

function renderChecklist(containerId, nights, selected, countFn, onChange) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!nights.length) {
    container.appendChild(el("span", { class: "empty-hint" }, ["No groups staged yet — use Stage above."]));
    return;
  }
  const count = countFn || ((n) => n.light_count);
  for (const group of groupNightsByFilter(nights)) {
    if (group.heading) container.appendChild(el("div", { class: "checklist-group-heading" }, [group.heading]));
    for (const n of group.nights) {
      const checked = selected.has(n.name);
      const chip = el("label", { class: `chip${checked ? " checked" : ""}` }, [
        el("input", {
          type: "checkbox", checked: checked ? "checked" : null,
          onchange: (e) => {
            if (e.target.checked) selected.add(n.name); else selected.delete(n.name);
            chip.classList.toggle("checked", e.target.checked);
            if (onChange) onChange();
          },
        }, []),
        document.createTextNode(`${nightDisplayLabel(n)} (${count(n)})`),
      ]);
      container.appendChild(chip);
    }
  }
  if (onChange) onChange();
}

function survivorCountForNight(n) {
  const analyzed = state.lastAnalyzeResult && state.lastAnalyzeResult.nights[n.name];
  if (!analyzed) return n.light_count;
  const excluded = analyzed.filter((f) => state.excludeFrames.has(f.filename)).length;
  return analyzed.length - excluded;
}

// Sessions with different filters selected together used to be a silent
// trap (Siril has no concept of "filter" - a merge would have happily
// combined two different wavelengths into one nonsensical stack). Now
// that Stack fans a multi-filter selection out into one independent run
// per filter instead (see the stack-run-btn handler), this is no longer
// a mistake to warn against - but it's still worth being upfront that
// one "Run stack" click is about to kick off several sequential jobs
// and produce several separate results, not one.
function checkStackFilterMismatch() {
  const warningEl = document.getElementById("stack-filter-warning");
  if (!warningEl || !state.status) return;
  const filters = new Set(
    state.status.nights.filter((n) => stackSelected.has(n.name) && n.filter).map((n) => n.filter)
  );
  if (filters.size > 1) {
    warningEl.textContent = `ℹ Selected groups span ${filters.size} filters (${Array.from(filters).sort().join(", ")}) — "Run stack" will run them one at a time and produce ${filters.size} separate results, one per filter.`;
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }
}

function refreshStackNightsChecklist() {
  if (!state.status) return;
  renderChecklist("stack-nights", state.status.nights, stackSelected, survivorCountForNight, checkStackFilterMismatch);
}

const mastersSelected = new Set();
const analyzeSelected = new Set();
const stackSelected = new Set();

// "Select all"/"Select none" for each of the three per-group checklists -
// Chris: "especially with a large 12+ group project," clicking every
// checkbox by hand doesn't scale. Each just mutates the shared Set
// directly then re-renders that one checklist the same way its own
// normal refresh path already does, so onChange/survivor-count/filter-
// mismatch side effects all still fire correctly.
document.getElementById("masters-select-all-btn").addEventListener("click", () => {
  if (!state.status) return;
  for (const n of state.status.nights) mastersSelected.add(n.name);
  renderChecklist("masters-nights", state.status.nights, mastersSelected);
});
document.getElementById("masters-select-none-btn").addEventListener("click", () => {
  mastersSelected.clear();
  renderChecklist("masters-nights", state.status ? state.status.nights : [], mastersSelected);
});
document.getElementById("analyze-select-all-btn").addEventListener("click", () => {
  if (!state.status) return;
  for (const n of state.status.nights) analyzeSelected.add(n.name);
  renderChecklist("analyze-nights", state.status.nights, analyzeSelected);
});
document.getElementById("analyze-select-none-btn").addEventListener("click", () => {
  analyzeSelected.clear();
  renderChecklist("analyze-nights", state.status ? state.status.nights : [], analyzeSelected);
});
document.getElementById("stack-select-all-btn").addEventListener("click", () => {
  if (!state.status) return;
  for (const n of state.status.nights) stackSelected.add(n.name);
  refreshStackNightsChecklist();
});
document.getElementById("stack-select-none-btn").addEventListener("click", () => {
  stackSelected.clear();
  refreshStackNightsChecklist();
});

// ---------- Masters section ----------

function renderMastersPreviews() {
  const container = document.getElementById("masters-previews");
  container.innerHTML = "";
  if (!state.status) return;
  const items = [];
  if (state.status.master_bias_built) items.push({ label: "Master Bias", path: "process/master_bias.fit", debayer: false, stretch: "noise" });
  // Multiple nights can share one master dark (same detected exposure
  // length - see app/ssf.py's dark_exposure_key()) - dedupe by the actual
  // built path so a shared master shows exactly ONE tile, labeled with
  // every session that uses it, not one identical-looking tile per night.
  const darkGroups = new Map();
  for (const n of state.status.nights) {
    if (!n.master_dark_built) continue;
    const path = `process/darks/${n.dark_key}/master_dark.fit`;
    if (!darkGroups.has(path)) darkGroups.set(path, []);
    darkGroups.get(path).push(n);
  }
  for (const [path, sharingNights] of darkGroups) {
    const label = `Master Dark — ${sharingNights.map(nightDisplayLabel).join(", ")}`;
    items.push({ label, path, debayer: false, stretch: "noise" });
  }
  for (const n of state.status.nights) {
    if (n.master_flat_built) {
      items.push({ label: `Master Flat — ${nightDisplayLabel(n)}`, path: `process/nights/${n.name}/master_flat.fit`, debayer: state.status.is_osc, stretch: "calibration" });
    }
  }
  if (!items.length) return;
  // Master bias/dark/flat are never debayered by Siril (only light
  // calibration gets -cfa/-debayer - see Handoff.md), so they're still a
  // raw Bayer mosaic same as an unstaged raw light. Flats still get
  // debayered here for a real color look ("calibration" = per-channel
  // ZScale, no asinh curve - a flat's real signal (vignetting) is a
  // subtle, smooth few-percent gradient next to sharp, outlier dust-mote
  // pixels, and the percentile+asinh curve "unlinked" uses, tuned for the
  // opposite problem, crushes the gradient toward white - confirmed on
  // real master flat data before choosing this fix, see
  // app/imaging.py's docstring).
  //
  // Bias/dark deliberately do NOT get debayered (per-item `debayer: false`
  // above), even on an OSC project - a REAL bug Chris caught: these
  // frames are pure sensor noise/hot-pixel data, not light through a
  // color filter array, so there's no real per-channel color signal to
  // reconstruct. Worse, bilinear debayering SPREADS each single hot/cold
  // outlier pixel's extreme value across several of its neighbors (the
  // interpolation kernel's own nature), which confuses an outlier-
  // sensitive stretch into computing a too-narrow, over-bright range for
  // the (should stay near-black) background - "it shouldn't look like our
  // current stretch" for bias/dark specifically. Previewing them as the
  // plain grayscale mosaic they actually are fixes that.
  //
  // Bias/dark also use "noise" stretch, not "calibration" - a SEPARATE
  // real bug Chris caught: ZScaleInterval (calibration mode) targets the
  // DS9/IRAF "sky background at a comfortable ~50% gray" convention,
  // right for a flat's smooth vignetting gradient but wrong for a bias/
  // dark's noise floor (confirmed against real pixel data: it mapped the
  // median to ~50% gray, not the "mostly solid dark field with a small
  // handful of hot/cold pixels" Chris gets from Siril's own unlinked
  // autostretch on the same frames). "noise" mode's MTF autostretch (see
  // app/imaging.py) targets that same dark-background look directly.
  for (const item of items) {
    const debayer = item.debayer ? "&debayer=1" : "";
    const thumbUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(item.path)}&max_size=220&stretch=${item.stretch}${debayer}`;
    const largeUrl = `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(item.path)}&max_size=1600&stretch=${item.stretch}${debayer}`;
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
  const ownerProject = state.project;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(ownerProject)}/masters/run`, mastersBody());
    await pollJob(job_id, {
      progressEl: document.getElementById("masters-progress"),
      logViewEl: document.querySelector('[data-log-view="masters"]'),
      lockButtons: [runBtn],
      ownerProject,
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
  // A REAL bug this fixes: lightboxNav stayed truthy after closing (only
  // ever reassigned by openLightboxForFrame/openPlainLightbox, never
  // cleared here), so later clicking "Show all frames"/"Accept
  // exclusions - show survivors only" - which unconditionally does
  // `if (lightboxNav) renderLightboxFrame()` - would call
  // renderLightboxFrame() -> openLightbox() -> classList.add("open"),
  // popping the lightbox back open even though the user only clicked a
  // toggle, not a thumbnail.
  lightboxNav = null;
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
  else if (e.key === "Escape") {
    document.getElementById("lightbox").classList.remove("open");
    lightboxNav = null; // see the overlay-click handler's comment above
  }
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

// Review-specific wrapper around groupNightsByFilter() - the frame data
// itself is keyed by night in state.lastAnalyzeResult, not present on
// the status.nights objects that carry .filter, so this joins the two
// before handing off to the shared grouping logic.
function groupAnalyzeEntriesByFilter() {
  const entries = Object.entries(state.lastAnalyzeResult.nights).map(([nightKey, frames]) => {
    const statusNight = state.status ? state.status.nights.find((n) => n.name === nightKey) : null;
    return {
      nightKey,
      frames,
      filter: statusNight ? statusNight.filter : null,
      label: statusNight ? nightDisplayLabel(statusNight) : nightKey,
    };
  });
  return groupNightsByFilter(entries).map((g) => ({ heading: g.heading, entries: g.nights }));
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

  for (const group of groupAnalyzeEntriesByFilter()) {
    if (group.heading) outputEl.appendChild(el("h3", { class: "filter-group-heading" }, [group.heading]));
    for (const { nightKey: night, frames: allFrames, label } of group.entries) {
      const frames = state.showSurvivorsOnly ? allFrames.filter((f) => !state.excludeFrames.has(f.filename)) : allFrames;
      const flaggedCount = allFrames.filter((f) => isFrameFlagged(f)).length;
      const excludedCount = allFrames.filter((f) => state.excludeFrames.has(f.filename)).length;

      const block = el("div", { class: "night-block", "data-night": night }, []);
      block.appendChild(el("h4", {}, [
        `${label} — ${allFrames.length} frames, ${flaggedCount} flagged` + (excludedCount ? `, ${excludedCount} excluded` : ""),
      ]));
      // Per-group, not one single button above the whole grid - Chris:
      // "add an accept exclusions button per group and get rid of the
      // main one at the top" (a 12+ group project made the one global
      // button, which accepted EVERY group's recommendations at once,
      // too coarse to use group by group). Only shown when THIS group
      // actually has an unaccepted flagged frame.
      if (allFrames.some((f) => isFrameFlagged(f) && !state.excludeFrames.has(f.filename))) {
        block.appendChild(el("button", {
          class: "small",
          onclick: () => {
            for (const f of allFrames) {
              if (isFrameFlagged(f)) state.excludeFrames.add(f.filename);
            }
            refreshExcludeDisplay();
            renderAnalyzeOutput();
          },
        }, ["✓ Accept recommended exclusions"]));
      }
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
  document.getElementById("analyze-reset-btn").style.display = "none";
  document.getElementById("review-next-btn").style.display = "none";
  setStepBadge("review-status-badge", null, "not analyzed");
  runBtn.disabled = true;
  rerunBtn.disabled = true;
  const ownerProject = state.project;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(ownerProject)}/lights/analyze/run`, body);
    await pollJob(job_id, {
      progressEl: document.getElementById("analyze-progress"),
      lockButtons: [runBtn, rerunBtn],
      ownerProject,
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


document.getElementById("analyze-reset-btn").addEventListener("click", () => {
  if (!confirm("Start over? This clears all excluded frames and this session's analysis results.")) return;
  // Also drop the per-project review cache (see reviewCache below) - it
  // only gets refreshed when switching away with a *non-null* analyze
  // result, so without this a switch-away-and-back after starting over
  // would silently resurrect the pre-reset data instead of respecting it.
  // Same reasoning applies server-side now too (see review-state's
  // persistence, added so a page reload doesn't lose review progress) -
  // fire-and-forget, since the in-memory reset above already takes
  // effect immediately regardless of whether this network call lands.
  if (state.project) {
    delete reviewCache[state.project];
    api("DELETE", `/projects/${encodeURIComponent(state.project)}/review-state`).catch(() => {});
  }
  state.excludeFrames.clear();
  state.lastAnalyzeResult = null;
  state.analyzed = false;
  state.showSurvivorsOnly = false;
  state.expandedGroups = {};
  refreshExcludeDisplay();
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-result").innerHTML = "";
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
  listEl.innerHTML = "";
  if (!state.excludeFrames.size) {
    listEl.textContent = "none";
    return;
  }
  if (!state.lastAnalyzeResult) {
    // No per-night breakdown available - fall back to a flat list rather
    // than showing nothing.
    listEl.textContent = Array.from(state.excludeFrames).join(", ");
    return;
  }
  for (const [nightKey, frames] of Object.entries(state.lastAnalyzeResult.nights)) {
    const excludedHere = frames.filter((f) => state.excludeFrames.has(f.filename)).map((f) => f.filename);
    if (!excludedHere.length) continue;
    const statusNight = state.status && state.status.nights.find((n) => n.name === nightKey);
    const label = statusNight ? nightDisplayLabel(statusNight) : nightKey;
    listEl.appendChild(el("div", {}, [el("b", {}, [`${label}: `]), excludedHere.join(", ")]));
  }
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
    drizzle: {
      enabled: document.getElementById("stack-drizzle-enabled").checked,
      scale: parseFloat(document.getElementById("stack-drizzle-scale").value) || 2.0,
      pixel_fraction: parseFloat(document.getElementById("stack-drizzle-pixfrac").value) || 1.0,
      kernel: document.getElementById("stack-drizzle-kernel").value,
    },
  };
  return body;
}

// Sigma low/high are meaningless for "Mean" (rej none — no clipping at
// all), so hiding them there rather than just leaving greyed-out inputs
// matches Chris's ask ("only show Sigma values for Sigma Options").
function wireSigmaVisibility(methodSelectId, lowFieldId, highFieldId) {
  const select = document.getElementById(methodSelectId);
  const update = () => {
    const show = select.value !== "none";
    document.getElementById(lowFieldId).style.display = show ? "" : "none";
    document.getElementById(highFieldId).style.display = show ? "" : "none";
  };
  select.addEventListener("change", update);
  update();
}
wireSigmaVisibility("masters-method", "masters-sigma-low-field", "masters-sigma-high-field");
wireSigmaVisibility("stack-method", "stack-sigma-low-field", "stack-sigma-high-field");

document.getElementById("stack-drizzle-enabled").addEventListener("change", (e) => {
  document.getElementById("stack-drizzle-options").style.display = e.target.checked ? "flex" : "none";
  document.getElementById("stack-drizzle-hint").style.display = e.target.checked ? "block" : "none";
});

wireToggleButton("stack-render-btn", "stack", () =>
  api("POST", `/projects/${encodeURIComponent(state.project)}/stack/render`, stackBody())
);

// Selected nights grouped by filter (""  for OSC/no-filter data) - a
// narrowband project's selection can span several filters at once, and
// each filter's nights become their own independent stack run (mixing
// filters into one merge never makes sense - see
// checkStackFilterMismatch(), which already warns about exactly this).
function groupStackSelectionByFilter() {
  const groups = new Map();
  for (const name of stackSelected) {
    const night = state.status.nights.find((n) => n.name === name);
    const key = (night && night.filter) || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  return Array.from(groups.entries());
}

document.getElementById("stack-run-btn").addEventListener("click", async () => {
  const runBtn = document.getElementById("stack-run-btn");
  const resultEl = document.getElementById("stack-result");
  const previewEl = document.getElementById("stack-preview");
  resultEl.innerHTML = "";
  // Also clear builtFor, not just the DOM: showStackPreview() skips
  // rebuilding whenever the result set matches what it already built -
  // a correct optimization for the stretch-mode buttons, but back-to-back
  // stack runs (e.g. rejection, then max, then median) all write to the
  // SAME path, so without this reset showStackPreview() would see "same
  // results, nothing to do" after the job finishes and leave this now-
  // empty element blank forever - confirmed this is exactly what
  // happened testing successive runs with different stack methods.
  previewEl.innerHTML = "";
  previewEl.dataset.builtFor = "";
  runBtn.disabled = true;
  const ownerProject = state.project;
  const baseBody = stackBody();
  // Run groups one at a time, not concurrently - the server already
  // rejects a second job against the same project while one is running
  // (shared scratch dirs), so firing them all at once would just 409 on
  // everything after the first.
  const groups = groupStackSelectionByFilter();
  for (let i = 0; i < groups.length; i++) {
    const [filterKey, nightsForGroup] = groups[i];
    const label = filterKey || (groups.length > 1 ? "(no filter)" : "stack");
    const line = el("div", { class: "status-line" }, [
      groups.length > 1 ? `Running ${label} (${i + 1}/${groups.length})…` : "starting…",
    ]);
    resultEl.appendChild(line);
    let snap;
    try {
      const body = { ...baseBody, nights: nightsForGroup };
      const { job_id } = await api("POST", `/projects/${encodeURIComponent(ownerProject)}/stack/run`, body);
      snap = await new Promise((resolve) => {
        pollJob(job_id, {
          progressEl: document.getElementById("stack-progress"),
          logViewEl: document.querySelector('[data-log-view="stack"]'),
          pipelineEl: document.getElementById("stack-pipeline"),
          ownerProject,
          onDone: resolve,
        });
      });
    } catch (e) {
      snap = { status: "failed", error: String(e) };
    }
    line.innerHTML = "";
    if (snap.status === "succeeded") {
      // Quiet on success when there's only one group (matches every
      // other run button's "the badge is the signal" convention) - but
      // a multi-group fan-out is worth a visible per-group trail, since
      // several sequential outcomes are real detail, not noise.
      if (groups.length > 1) line.appendChild(el("div", { class: "status-line ok" }, [`✓ ${label} complete`]));
    } else {
      line.appendChild(el("div", { class: "error-banner" }, [`✕ ${groups.length > 1 ? `${label}: ` : ""}Failed: ${snap.error || ""}`]));
    }
    if (ownerProject === state.project) await loadProjectStatus();
  }
  runBtn.disabled = false;
  if (ownerProject === state.project) {
    showStackPreview();
    renderStepper();
  }
});

// The final step of a multi-filter (or multi-exposure-group) project:
// once 2+ filters/groups each have their own final stacked result,
// register them against each other so they're pixel-aligned for
// combining as channels in external post-processing - Chris: "the last
// step of a mono project should be a registration so that when they get
// combined during post processing they're aligned." Section stays hidden
// until there's genuinely something to align (see app/ssf.py's
// final_stack_paths() / app/status.py's final_results_count).
function renderRegisterFinalsSection() {
  const section = document.getElementById("register-finals-section");
  if (!state.status || state.status.final_results_count < 2) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  const list = document.getElementById("register-finals-list");
  list.innerHTML = "";
  for (const item of state.status.aligned_finals || []) {
    list.appendChild(el("div", { class: "night-row", style: "justify-content:space-between;" }, [
      el("span", {}, [item.label]),
      el("a", {
        class: "small",
        href: `/projects/${encodeURIComponent(state.project)}/download?path=${encodeURIComponent(item.path)}`,
      }, ["⬇ Download"]),
    ]));
  }
}

document.getElementById("register-finals-run-btn").addEventListener("click", async () => {
  const runBtn = document.getElementById("register-finals-run-btn");
  const resultEl = document.getElementById("register-finals-result");
  resultEl.innerHTML = "";
  runBtn.disabled = true;
  const ownerProject = state.project;
  resultEl.appendChild(el("div", { class: "status-line" }, ["starting…"]));
  let snap;
  try {
    const { job_id } = await api("POST", `/projects/${encodeURIComponent(ownerProject)}/register-finals/run`, {});
    snap = await new Promise((resolve) => {
      pollJob(job_id, {
        progressEl: document.getElementById("register-finals-progress"),
        logViewEl: document.querySelector('[data-log-view="register-finals"]'),
        ownerProject,
        onDone: resolve,
      });
    });
  } catch (e) {
    snap = { status: "failed", error: String(e) };
  }
  resultEl.innerHTML = "";
  if (snap.status !== "succeeded") {
    resultEl.appendChild(el("div", { class: "error-banner" }, [`✕ Failed: ${snap.error || ""}`]));
  }
  runBtn.disabled = false;
  if (ownerProject === state.project) await loadProjectStatus();
});

// Every currently-existing result at once, not just one - a narrowband
// project can have several independent results (one per filter) live
// simultaneously, each from its own stack run (see the fan-out in the
// stack-run-btn handler below). Deduped by path since a night that's
// since been folded into a merge could still have an older single-night
// result file sitting around from before that.
function allResultEntries() {
  if (!state.status) return [];
  const entries = [];
  const seen = new Set();
  for (const m of state.status.merged_results || []) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    entries.push({ label: m.filter ? `Merged — ${m.filter}` : "Merged", path: m.path });
  }
  for (const n of state.status.nights) {
    if (n.result_path && !seen.has(n.result_path)) {
      seen.add(n.result_path);
      entries.push({ label: nightDisplayLabel(n), path: n.result_path });
    }
  }
  return entries;
}

function stackPreviewUrl(path, maxSize) {
  const size = maxSize ? `&max_size=${maxSize}` : "";
  return `/projects/${encodeURIComponent(state.project)}/preview?path=${encodeURIComponent(path)}&stretch=${state.stretchMode}${size}&t=${Date.now()}`;
}

function showStackPreview() {
  const previewEl = document.getElementById("stack-preview");
  const entries = allResultEntries();
  if (!entries.length) {
    previewEl.innerHTML = "";
    previewEl.dataset.builtFor = "";
    return;
  }

  // Only rebuild the whole block (controls + gallery) the first time, or
  // when the actual SET of results changes (a fresh stack ran, or a new
  // filter's result appeared). Switching stretch mode just swaps each
  // existing <img>'s src - rebuilding the whole subtree each time
  // briefly collapsed every frame to 0 height (nothing to reserve space
  // until the new PNG decoded), which yanked the page up and buried the
  // gallery below the fold until it reloaded. The CSS aspect-ratio on
  // .preview-frame is a second safety net for this same problem; keeping
  // the DOM nodes in place avoids it outright.
  const builtForKey = entries.map((e) => e.path).sort().join("|");
  if (previewEl.dataset.builtFor === builtForKey) return;
  previewEl.innerHTML = "";
  previewEl.dataset.builtFor = builtForKey;

  const controls = el("div", { class: "preview-controls" }, []);
  const toggle = el("div", { class: "stretch-toggle" }, []);
  for (const mode of ["none", "linked", "unlinked"]) {
    toggle.appendChild(el("button", {
      class: mode === state.stretchMode ? "active" : "",
      type: "button",
      onclick: () => {
        state.stretchMode = mode;
        toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === mode));
        previewEl.querySelectorAll("img[data-result-path]").forEach((img) => {
          img.src = stackPreviewUrl(img.dataset.resultPath);
        });
      },
    }, [mode]));
  }
  controls.appendChild(toggle);
  previewEl.appendChild(controls);

  const gallery = el("div", { class: "stack-result-gallery" }, []);
  for (const entry of entries) {
    gallery.appendChild(el("div", { class: "stack-result-item" }, [
      el("div", { class: "stack-result-label" }, [entry.label]),
      el("div", { class: "preview-frame" }, [el("img", {
        "data-result-path": entry.path,
        src: stackPreviewUrl(entry.path),
        onclick: () => openPlainLightbox(stackPreviewUrl(entry.path, 2400), entry.path.split("/").pop()),
      }, [])]),
      el("a", {
        href: `/projects/${encodeURIComponent(state.project)}/download?path=${encodeURIComponent(entry.path)}`,
        class: "mono",
      }, [el("button", { type: "button", class: "small" }, ["⬇ Download full-resolution .fit"])]),
    ]));
  }
  previewEl.appendChild(gallery);
}

// ---------- stepper ----------

function stepStatus(step) {
  const s = state.status;
  if (!s) return { available: step === "stage", complete: false };
  const staged = s.nights.length > 0;
  // Bias/dark only count as "required" if any were actually staged -
  // calibration frames are genuinely optional now (see app/ssf.py's
  // _resolve_master()), so a project with none staged at all (nothing
  // to build) must still be able to reach "masters complete" and unlock
  // Stack, not stay permanently gated on a build that will never happen.
  // Dark is checked per-night (darks_count is no longer a single
  // project-wide figure - see app/status.py's per-night dark_count).
  const mastersComplete = staged
    && (s.biases_count === 0 || s.master_bias_built)
    && s.nights.every((n) => n.dark_count === 0 || n.master_dark_built)
    && s.nights.every((n) => n.master_flat_built);
  const stackComplete = (s.merged_results && s.merged_results.length > 0) || s.nights.some((n) => n.result_path);
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
    renumberGroups();
    renderStepper();
    return;
  }
  document.getElementById("delete-project-btn").disabled = false;
  document.getElementById("delete-project-btn").title = "";
  const nights = state.status.nights;

  setStepBadge("stage-status-badge", nights.length ? "ok" : null, nights.length ? `${nights.length} group(s) staged` : "not staged");
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
  renderCalibrationAlignment(nights);
  // The draft "Group N" row(s) in the Stage form are created by
  // addNightRow() at project-switch time, BEFORE this function's fetch
  // resolves - at that point state.status is still null (just reset),
  // so the label always came out "Group 1" regardless of how many
  // groups this project actually already has staged. Relabel now that
  // the real count is known.
  renumberGroups();

  document.getElementById("stage-is-osc").checked = state.status.is_osc !== false;
  updateOscMismatchWarning();

  renderMastersPreviews();
  showStackPreview();
  renderRegisterFinalsSection();
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
  // point (the project being switched away FROM). reviewCache alone only
  // covers switching projects within one still-open tab - a page reload
  // or a brand new session loses it entirely, which is exactly what
  // Chris hit ("we've lost our light frame history when I exit and go
  // back into a project"). The exclude list / sensitivity are cheap
  // enough to just re-save here (fire-and-forget - losing this one write
  // to a network hiccup isn't worth blocking the switch over); the
  // actual analyze RESULT is real compute time, so that's persisted
  // separately, once, right when /lights/analyze/run itself succeeds
  // (see app/main.py's run_analyze()).
  if (state.project && state.lastAnalyzeResult) {
    reviewCache[state.project] = {
      lastAnalyzeResult: state.lastAnalyzeResult,
      excludeFrames: new Set(state.excludeFrames),
      lastAnomalySigma: state.lastAnomalySigma,
    };
    api("POST", `/projects/${encodeURIComponent(state.project)}/review-state`, {
      exclude_frames: Array.from(state.excludeFrames),
      anomaly_sigma: state.lastAnomalySigma,
    }).catch(() => {});
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
  document.getElementById("project-logs-btn").style.display = state.project ? "inline-block" : "none";
  document.getElementById("project-logs-panel").style.display = "none";
  document.getElementById("broken-links-banner").style.display = "none";
  document.getElementById("stage-autopopulate-note").style.display = "none";
  // A REAL pre-existing gap, caught while adding the summary line below:
  // #biases-dir is a plain static input (not re-created per project like
  // the session rows are), so without an explicit reset here a PREVIOUS
  // project's biases path - and now its frame-count summary too - stayed
  // visible after switching to a different project that hadn't staged
  // any yet. Not just cosmetic: clicking "Stage files" without noticing
  // would have re-staged the WRONG project's calibration frames.
  clearBiases();
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
  // A REAL pre-existing gap, caught while adding cross-row darks auto-fill
  // (autoFillMatchingDarks() - see addNightRow()): wiping the container's
  // innerHTML directly discards the DOM nodes but never called any row's
  // own _cleanup(), so nightRows/sessionWarningUpdaters kept stale entries
  // from the PREVIOUS project's rows around indefinitely. Harmless for
  // sessionWarningUpdaters (it only ever recomputes warnings on detached,
  // invisible nodes) but a real correctness risk for nightRows once it's
  // used to auto-fill one row's darks from another - a stale entry could
  // otherwise bleed a previous project's exposure/darks match into this
  // one's rows.
  nightRows.length = 0;
  sessionWarningUpdaters.length = 0;
  document.getElementById("stage-nights").innerHTML = "";
  addNightRow();
  updateOscMismatchWarning();
  document.getElementById("stage-summary").innerHTML = "";
  document.getElementById("analyze-output").innerHTML = "";
  document.getElementById("analyze-result").innerHTML = "";
  document.getElementById("masters-result").innerHTML = "";
  document.getElementById("masters-previews").innerHTML = "";
  document.getElementById("stack-result").innerHTML = "";
  document.getElementById("register-finals-section").style.display = "none";
  document.getElementById("register-finals-result").innerHTML = "";
  document.getElementById("register-finals-list").innerHTML = "";
  document.getElementById("analyze-reset-btn").style.display = "none";
  document.getElementById("analyze-rerun-btn").style.display = "none";
  document.getElementById("stage-next-btn").style.display = "none";
  document.getElementById("masters-next-btn").style.display = "none";
  document.getElementById("review-next-btn").style.display = "none";
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
  // A running job's pollJob() loop now stops updating these once the user
  // navigates to a different project (see pollJob's ownerProject guard),
  // but it can't retroactively undo DOM it already painted BEFORE that
  // navigation happened - without this, opening a different project's
  // Stack panel could still show another project's leftover progress bar
  // or pipeline-step markers (confirmed as a real bug: Chris saw a mono
  // project's calibrate/register/stack markers already green, painted
  // there by an OSC project's stack job that was still running when he
  // switched away from it). Every project shares these same DOM elements
  // (repainted per switch, not one tree per project - see module intro),
  // so a full reset here is the fix, not just guarding future writes.
  for (const id of ["masters-progress", "analyze-progress", "stack-progress", "stack-pipeline"]) {
    document.getElementById(id).style.display = "none";
  }
  document.getElementById("stack-pipeline").innerHTML = "";
  document.querySelectorAll("[data-log-view]").forEach((el) => { el.textContent = ""; el.classList.remove("open"); });
  showActiveStep();
  if (state.project) await loadProjectStatus();
  // Restore a review session for the INCOMING project - first check this
  // tab's own in-memory cache (covers switching projects without ever
  // leaving the page), then fall back to whatever was last persisted
  // server-side (covers a page reload or a brand new session entirely -
  // see the save side of this above, and app/main.py's run_analyze()/
  // review-state endpoints). After loadProjectStatus(), not before,
  // since frame thumbnails need state.status.is_osc (for debayering) to
  // already be populated.
  const cached = state.project ? reviewCache[state.project] : null;
  let restored = cached
    ? { lastAnalyzeResult: cached.lastAnalyzeResult, excludeFrames: cached.excludeFrames, lastAnomalySigma: cached.lastAnomalySigma }
    : null;
  if (!restored && state.project) {
    try {
      const saved = await api("GET", `/projects/${encodeURIComponent(state.project)}/review-state`);
      restored = { lastAnalyzeResult: saved.result, excludeFrames: new Set(saved.exclude_frames), lastAnomalySigma: saved.anomaly_sigma };
    } catch (e) {
      // 404 (never analyzed) or a genuine network hiccup - either way,
      // nothing to restore, same as no in-memory cache entry.
    }
  }
  if (restored) {
    state.lastAnalyzeResult = restored.lastAnalyzeResult;
    state.excludeFrames = new Set(restored.excludeFrames);
    state.lastAnomalySigma = restored.lastAnomalySigma;
    state.analyzed = true;
    document.getElementById("analyze-anomaly-sigma").value = restored.lastAnomalySigma;
    document.getElementById("anomaly-sigma-value").textContent = restored.lastAnomalySigma.toFixed(1);
    setStepBadge("review-status-badge", "ok", "analyzed");
    document.getElementById("analyze-reset-btn").style.display = "inline-block";
    document.getElementById("review-next-btn").style.display = "inline-block";
    refreshExcludeDisplay();
    renderAnalyzeOutput();
    renderStepper();
    if (!cached) {
      reviewCache[state.project] = {
        lastAnalyzeResult: restored.lastAnalyzeResult,
        excludeFrames: new Set(restored.excludeFrames),
        lastAnomalySigma: restored.lastAnomalySigma,
      };
    }
  }
}

document.getElementById("project-select").addEventListener("change", (e) => switchToProject(e.target.value || null, "stage"));

document.getElementById("brand-link").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("project-select").value = "";
  switchToProject(null, "stage");
});

document.getElementById("create-project-btn").addEventListener("click", async () => {
  const name = (prompt("New project name:") || "").trim();
  if (!name) return;
  // Mirrors config.py's project_dir() validation - a project's directory
  // path gets baked unquoted into every .ssf script's -out=/-dark=/
  // -flat=/-bias= arguments, and Siril's script parser tokenizes those
  // specific options on whitespace with no quoting escape hatch. Caught
  // here so the folder picker doesn't even open for a name that's
  // already doomed to fail.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    alert(
      `Create failed: project names can only contain letters, numbers, hyphens, underscores, and periods (no spaces or other punctuation) - "${name}" isn't valid.`
    );
    return;
  }
  // root_dir is optional (Skip leaves it unset - pickers just fall back
  // to browsing from the full captures root, same as before this
  // existed) but asked for up front since it's meant to seed every
  // picker for the rest of this project's Stage step.
  const rootDir = await pickCapturesFolder(document.getElementById("create-project-btn"));
  try {
    // /stage creates the project directory (and writes root_dir into its
    // meta) even with nothing else to stage yet - see staging.py.
    await api("POST", `/projects/${encodeURIComponent(name)}/stage`, rootDir ? { root_dir: rootDir } : {});
  } catch (e) {
    alert(`Create failed: ${e}`);
    return;
  }
  await loadProjects();
  document.getElementById("project-select").value = name;
  await switchToProject(name, "stage");
  if (rootDir) await autoPopulateFromScan(rootDir);
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
  // A REAL bug Chris hit: delete a project, create a NEW one with the
  // SAME name, and Review already had the OLD project's images. Root
  // cause - state.lastAnalyzeResult (this in-memory tab's current
  // analyze result) was still holding the just-deleted project's data,
  // and the very next line's dispatchEvent triggers switchToProject(),
  // whose OWN "save the outgoing project's review session" logic runs
  // unconditionally whenever state.lastAnalyzeResult is set - it doesn't
  // know or care that the project it's about to save FOR was just
  // deleted, so it immediately re-wrote reviewCache[name] right back,
  // undoing the delete above. Clearing this first means that save block
  // sees nothing to save and skips it entirely.
  state.lastAnalyzeResult = null;
  state.excludeFrames.clear();
  state.lastAnomalySigma = null;
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

// Every job's own log file on disk (project/logs/<job_id>.log - survives
// a server restart, unlike Job history above's in-memory list) - Chris:
// "we need a way to grab project logs through the webui. That way I can
// give you troubleshooting data."
async function renderProjectLogs() {
  const list = document.getElementById("project-logs-list");
  list.innerHTML = "";
  if (!state.project) return;
  let data;
  try {
    data = await api("GET", `/projects/${encodeURIComponent(state.project)}/logs`);
  } catch (e) {
    list.appendChild(el("div", { class: "status-line err" }, [String(e)]));
    return;
  }
  if (!data.logs.length) {
    list.appendChild(el("span", { class: "empty-hint" }, ["No job logs yet."]));
    return;
  }
  for (const logFile of data.logs) {
    const when = new Date(logFile.mtime * 1000).toLocaleString();
    const sizeKb = (logFile.size / 1024).toFixed(1);
    list.appendChild(el("div", { class: "night-row", style: "justify-content:space-between;" }, [
      el("span", { class: "mono" }, [`${logFile.name} — ${when} (${sizeKb} KB)`]),
      el("a", {
        class: "small",
        href: `/projects/${encodeURIComponent(state.project)}/download?path=${encodeURIComponent(`logs/${logFile.name}`)}`,
      }, ["⬇ Download"]),
    ]));
  }
}
document.getElementById("project-logs-btn").addEventListener("click", () => {
  document.getElementById("project-logs-panel").style.display = "block";
  renderProjectLogs();
});
document.getElementById("project-logs-close").addEventListener("click", () => {
  document.getElementById("project-logs-panel").style.display = "none";
});
document.getElementById("project-logs-download-all-btn").addEventListener("click", () => {
  if (!state.project) return;
  window.location.href = `/projects/${encodeURIComponent(state.project)}/logs/download`;
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
    if (health.version) document.getElementById("app-version").textContent = `v${health.version}`;
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
