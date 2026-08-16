const tokenInput = document.getElementById("adminToken");
tokenInput.value = localStorage.getItem("adminToken") || "";
tokenInput.addEventListener("change", () => {
  localStorage.setItem("adminToken", tokenInput.value.trim());
});

const VIEWS = {
  overview: { title: "Overview", kicker: "Status ao vivo" },
  sync: { title: "Sync & agenda", kicker: "Automação" },
  jobs: { title: "Jobs", kicker: "Execução" },
  databases: { title: "Databases", kicker: "Destino CouchDB" },
  settings: { title: "Settings", kicker: "Ambiente" },
};

function headers(json = false) {
  const h = {};
  const token = tokenInput.value.trim();
  if (token) {
    h.Authorization = `Bearer ${token}`;
    h["x-admin-token"] = token;
  }
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("pt-BR");
}

function daysBehind(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setView(name) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });
  const meta = VIEWS[name] || VIEWS.overview;
  document.getElementById("viewTitle").textContent = meta.title;
  document.getElementById("viewKicker").textContent = meta.kicker;
  localStorage.setItem("gosacSyncView", name);
}

document.getElementById("nav").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
});

let watchJobId = null;
let watchTimer = null;

function setBadges(text, status) {
  for (const id of ["jobBadge", "jobBadge2"]) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `badge ${status || ""}`.trim();
  }
}

function setLogs(text) {
  document.getElementById("jobLog").textContent = text;
  document.getElementById("jobLog2").textContent = text;
}

async function refreshStatus() {
  const live = document.getElementById("livePill");
  const label = document.getElementById("liveLabel");

  try {
    const status = await api("/api/status");
    live.className = "live-pill ok";
    label.textContent = "online";

    const eff = status.effective;
    const sample = status.database?.sample;
    const info = status.database?.info;
    const lag = daysBehind(sample?.newestMigratedAt || sample?.newestCreatedAt);

    document.getElementById("statDb").textContent = eff.messageDatabase || "—";
    document.getElementById("statDbEnv").textContent =
      `env: ${status.env?.couchdbDatabaseEnv || "—"}`;
    document.getElementById("statDocs").textContent =
      info?.docCount?.toLocaleString?.("pt-BR") ??
      status.database?.error ??
      "—";
    document.getElementById("statNewest").textContent = fmtDate(
      sample?.newestCreatedAt,
    );
    document.getElementById("statMigrated").textContent = fmtDate(
      sample?.newestMigratedAt,
    );
    document.getElementById("statLag").textContent =
      lag == null ? "sem amostra" : lag <= 1 ? "em dia" : `${lag} dias atrás`;

    const alert = document.getElementById("lagAlert");
    const wrongDb =
      status.env?.couchdbDatabaseEnv &&
      status.env.couchdbDatabaseEnv !== "gosac_messages" &&
      eff.messageDatabase === status.env.couchdbDatabaseEnv;

    if (status.database?.error) {
      alert.hidden = false;
      alert.textContent = `Erro CouchDB: ${status.database.error}`;
    } else if (wrongDb) {
      alert.hidden = false;
      alert.textContent = `Database do .env é "${status.env.couchdbDatabaseEnv}". O destino correto das mensagens costuma ser gosac_messages — ajuste em Databases.`;
    } else if (lag != null && lag > 2) {
      alert.hidden = false;
      alert.textContent = `Sync parece parado há ~${lag} dias (última migração ${fmtDate(sample?.newestMigratedAt)}). Ligue o sync contínuo ou rode incremental.`;
    } else {
      alert.hidden = true;
    }

    const s = status.settings;
    document.getElementById("cfgMessageDb").value =
      s.couchdbDatabase || eff.messageDatabase || "";
    document.getElementById("cfgMediaDb").value =
      s.couchdbMediaDatabase || eff.mediaDatabase || "";
    document.getElementById("cfgContinuous").checked = Boolean(
      s.continuousSync?.enabled,
    );
    document.getElementById("cfgInterval").value =
      s.continuousSync?.intervalMinutes ?? 5;
    document.getElementById("cfgMaxTickets").value =
      s.continuousSync?.maxTickets ?? 40;
    document.getElementById("cfgMsgPages").value =
      s.continuousSync?.messagePages ?? 3;
    document.getElementById("cfgContinuousMedia").checked = Boolean(
      s.continuousMedia?.enabled,
    );
    document.getElementById("cfgMediaInterval").value =
      s.continuousMedia?.intervalMinutes ?? 15;
    document.getElementById("cfgMediaMax").value =
      s.continuousMedia?.maxPerCycle ?? 80;
    document.getElementById("cfgDaily").checked = Boolean(
      s.dailyCheck?.enabled,
    );
    document.getElementById("cfgDailyHour").value = s.dailyCheck?.hour ?? 6;
    document.getElementById("cfgDailyMinute").value = s.dailyCheck?.minute ?? 0;
    document.getElementById("cfgDailyMedia").checked =
      s.dailyCheck?.includeMedia !== false;

    const sch = status.scheduler;
    document.getElementById("scheduleHint").textContent =
      `msgs=${sch.continuousTimer ? "on" : "off"} · mídia=${sch.continuousMediaTimer ? "on" : "off"} · diário=${sch.dailyTimer ? "agendado" : "off"}` +
      (sch.lastContinuousAt
        ? ` · último sync msgs ${fmtDate(sch.lastContinuousAt)}`
        : "") +
      (sch.lastContinuousMediaAt
        ? ` · último sync mídia ${fmtDate(sch.lastContinuousMediaAt)}`
        : "") +
      (sch.lastDailyAt ? ` · último daily ${fmtDate(sch.lastDailyAt)}` : "");

    document.getElementById("envDbHint").textContent =
      `fallback .env mensagens=${status.env?.couchdbDatabaseEnv || "—"} · mídia=${status.env?.couchdbMediaDatabaseEnv || "—"}`;

    const active = status.jobs?.active;
    if (active) {
      setBadges(`${active.status} · ${active.type}`, active.status);
      if (!watchJobId) watchJob(active.id);
    } else if (!watchJobId) {
      setBadges("idle");
    }

    const list = document.getElementById("jobList");
    list.innerHTML = "";
    for (const job of status.jobs?.recent || []) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(job.type)} · ${escapeHtml(job.status)}</span><span>${fmtDate(job.createdAt)}</span>`;
      li.addEventListener("click", () => {
        setView("jobs");
        watchJob(job.id);
      });
      list.appendChild(li);
    }

    const tbody = document.getElementById("msgTable");
    tbody.innerHTML = "";
    for (const row of sample?.latest || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(row.createdAt)}</td>
        <td>${escapeHtml(row.contactName || row.contactId || "—")}</td>
        <td>${row.ticketId ?? "—"}</td>
        <td>${escapeHtml(row.bodyPreview || row.mediaType || "")}</td>
      `;
      tbody.appendChild(tr);
    }

    const envKv = document.getElementById("envKv");
    envKv.innerHTML = "";
    const envRows = {
      gosacBaseUrl: status.env?.gosacBaseUrl,
      couchUrl: status.couchUrl,
      couchdbDatabaseEnv: status.env?.couchdbDatabaseEnv,
      messageDatabaseEffective: eff.messageDatabase,
      mediaDatabaseEffective: eff.mediaDatabase,
      migrateEnabledEnv: String(status.env?.migrateEnabledEnv),
      mediaMigrateEnabledEnv: String(status.env?.mediaMigrateEnabledEnv),
    };
    for (const [k, v] of Object.entries(envRows)) {
      envKv.innerHTML += `<dt>${k}</dt><dd>${escapeHtml(v ?? "—")}</dd>`;
    }

    const cp = status.checkpoint || {};
    const checkpointKv = document.getElementById("checkpointKv");
    checkpointKv.innerHTML = Object.entries(cp)
      .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
      .join("");

    document.getElementById("footMeta").textContent =
      `${status.couchUrl} · ${fmtDate(status.now)} · mídia=${eff.mediaDatabase || "n/d"}`;

    return status;
  } catch (error) {
    live.className = "live-pill bad";
    label.textContent = "offline";
    throw error;
  }
}

async function loadDatabases() {
  try {
    const { databases } = await api("/api/databases");
    const list = document.getElementById("dbList");
    list.innerHTML = "";
    for (const name of databases) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    }
  } catch {
    // ignore
  }
}

async function watchJob(id) {
  watchJobId = id;
  if (watchTimer) clearInterval(watchTimer);

  const render = async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      setBadges(`${job.status} · ${job.type}`, job.status);
      const lines = (job.logs || []).map(
        (l) => `[${l.at.slice(11, 19)}] ${l.level}: ${l.message}`,
      );
      setLogs(lines.join("\n") || "Sem logs ainda…");
      if (["completed", "failed", "stopped"].includes(job.status)) {
        clearInterval(watchTimer);
        watchTimer = null;
        watchJobId = null;
        toast(`Job ${job.status}`);
        await refreshStatus();
      }
    } catch (error) {
      setLogs(error.message);
    }
  };

  await render();
  watchTimer = setInterval(render, 1500);
}

async function saveDatabases() {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      couchdbDatabase:
        document.getElementById("cfgMessageDb").value.trim() || null,
      couchdbMediaDatabase:
        document.getElementById("cfgMediaDb").value.trim() || null,
    }),
  });
  toast("Databases salvos");
  await refreshStatus();
}

async function saveSchedule() {
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      continuousSync: {
        enabled: document.getElementById("cfgContinuous").checked,
        intervalMinutes:
          Number(document.getElementById("cfgInterval").value) || 5,
        maxTickets:
          Number(document.getElementById("cfgMaxTickets").value) || 40,
        messagePages: Number(document.getElementById("cfgMsgPages").value) || 3,
      },
      continuousMedia: {
        enabled: document.getElementById("cfgContinuousMedia").checked,
        intervalMinutes:
          Number(document.getElementById("cfgMediaInterval").value) || 15,
        maxPerCycle: Number(document.getElementById("cfgMediaMax").value) || 80,
      },
      dailyCheck: {
        enabled: document.getElementById("cfgDaily").checked,
        hour: Number(document.getElementById("cfgDailyHour").value) || 0,
        minute: Number(document.getElementById("cfgDailyMinute").value) || 0,
        includeMedia: document.getElementById("cfgDailyMedia").checked,
      },
    }),
  });
  toast("Agenda salva");
  await refreshStatus();
}

async function runAction(action) {
  try {
    if (action === "stop") {
      await api("/api/jobs/stop", { method: "POST", body: "{}" });
      toast("Parada solicitada");
      return;
    }
    if (action === "reset-checkpoint") {
      if (!confirm("Zerar checkpoint local de contatos?")) return;
      await api("/api/checkpoint/reset", { method: "POST", body: "{}" });
      toast("Checkpoint zerado");
      await refreshStatus();
      return;
    }

    let path = "";
    let body = {};
    if (action === "incremental") {
      path = "/api/jobs/incremental-sync";
      body = {
        maxTickets:
          Number(document.getElementById("cfgMaxTickets").value) || 40,
        messagePages: Number(document.getElementById("cfgMsgPages").value) || 3,
      };
    } else if (action === "daily") {
      path = "/api/jobs/daily-check";
      body = { includeMedia: document.getElementById("cfgDailyMedia").checked };
    } else if (action === "media") {
      path = "/api/jobs/migrate-media";
      body = {};
    } else if (action === "full") {
      path = "/api/jobs/migrate-messages";
      const max = document.getElementById("maxContacts").value;
      body = {
        reset: document.getElementById("resetOnFull").checked,
        maxContacts: max ? Number(max) : undefined,
      };
    } else if (action === "ticket") {
      path = "/api/jobs/migrate-ticket";
      body = {
        ticketId: document.getElementById("ticketId").value.trim(),
        onlyTicket: document.getElementById("onlyTicket").checked,
      };
      if (!body.ticketId) throw new Error("Informe o ticketId");
    }

    const job = await api(path, { method: "POST", body: JSON.stringify(body) });
    setView(action === "full" ? "jobs" : "overview");
    await watchJob(job.id);
    toast(`Job ${job.type} iniciado`);
  } catch (error) {
    toast(error.message);
  }
}

document.getElementById("btnRefresh").addEventListener("click", () => {
  refreshStatus()
    .then(() => toast("Atualizado"))
    .catch((e) => toast(e.message));
});
document
  .getElementById("btnQuickSync")
  .addEventListener("click", () => runAction("incremental"));
document.getElementById("btnSaveDb").addEventListener("click", () => {
  saveDatabases().catch((e) => toast(e.message));
});
document.getElementById("btnSaveSchedule").addEventListener("click", () => {
  saveSchedule().catch((e) => toast(e.message));
});
document.getElementById("btnCompare").addEventListener("click", async () => {
  const box = document.getElementById("compareBox");
  const metrics = document.getElementById("compareMetrics");
  box.hidden = false;
  box.textContent = "Comparando…";
  try {
    const data = await api("/api/compare?a=gosac_geral&b=gosac_messages");
    metrics.hidden = false;
    document.getElementById("cmpGeralDocs").textContent =
      data.a?.info?.docCount?.toLocaleString?.("pt-BR") ??
      data.a?.info?.error ??
      "—";
    document.getElementById("cmpMsgDocs").textContent =
      data.b?.info?.docCount?.toLocaleString?.("pt-BR") ??
      data.b?.info?.error ??
      "—";
    document.getElementById("cmpGeralMig").textContent =
      `migrated ${fmtDate(data.a?.sample?.newestMigratedAt)}`;
    document.getElementById("cmpMsgMig").textContent =
      `migrated ${fmtDate(data.b?.sample?.newestMigratedAt)}`;
    box.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    box.textContent = error.message;
  }
});

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => runAction(btn.dataset.action));
});

const POLL_SECONDS_KEY = "gosacStatusPollSeconds";
const POLL_ENABLED_KEY = "gosacStatusPollEnabled";
let statusPollTimer = null;

function getPollSeconds() {
  const n = Number(localStorage.getItem(POLL_SECONDS_KEY) || 30);
  return Math.min(600, Math.max(5, Number.isFinite(n) ? n : 30));
}

function isPollEnabled() {
  const raw = localStorage.getItem(POLL_ENABLED_KEY);
  return raw === null ? true : raw === "1" || raw === "true";
}

function applyPollForm() {
  document.getElementById("cfgStatusPoll").value = getPollSeconds();
  document.getElementById("cfgStatusPollEnabled").checked = isPollEnabled();
  document.getElementById("pollHint").textContent = isPollEnabled()
    ? `Atualiza sozinho a cada ${getPollSeconds()}s. Use "Atualizar" para forçar.`
    : "Automático desligado — só atualiza ao clicar em Atualizar.";
}

function restartStatusPoll() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  applyPollForm();
  if (!isPollEnabled()) return;
  statusPollTimer = setInterval(() => {
    refreshStatus().catch(() => {});
  }, getPollSeconds() * 1000);
}

document.getElementById("btnSavePoll").addEventListener("click", () => {
  const seconds = Number(document.getElementById("cfgStatusPoll").value) || 30;
  const enabled = document.getElementById("cfgStatusPollEnabled").checked;
  localStorage.setItem(POLL_SECONDS_KEY, String(Math.min(600, Math.max(5, seconds))));
  localStorage.setItem(POLL_ENABLED_KEY, enabled ? "1" : "0");
  restartStatusPoll();
  toast(enabled ? `Status a cada ${getPollSeconds()}s` : "Auto-refresh desligado");
});

setView(localStorage.getItem("gosacSyncView") || "overview");

loadDatabases()
  .then(() => refreshStatus())
  .catch((e) => toast(e.message));

restartStatusPoll();
