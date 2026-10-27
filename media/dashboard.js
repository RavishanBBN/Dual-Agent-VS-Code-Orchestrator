(function () {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const kind = byId('kind');
  const objective = byId('objective');
  const allowWrites = byId('allowWrites');
  const writeConsent = byId('writeConsent');
  const start = byId('start');
  const cancel = byId('cancel');
  const stages = byId('stages');
  const status = byId('runStatus');
  const usage = byId('usage');
  const warnings = byId('warnings');
  const activity = byId('activity');
  const errorBox = byId('error');

  const state = vscode.getState() || { objective: '', kind: 'implementation', allowWrites: false };
  objective.value = state.objective || '';
  kind.value = state.kind || 'implementation';
  allowWrites.checked = Boolean(state.allowWrites);

  function persist() {
    vscode.setState({ objective: objective.value, kind: kind.value, allowWrites: allowWrites.checked });
  }

  function updateConsent() {
    writeConsent.hidden = kind.value !== 'implementation';
    if (kind.value !== 'implementation') allowWrites.checked = false;
    persist();
  }

  function addActivity(agent, message, category) {
    const row = document.createElement('div');
    row.className = `activity-row ${category || ''}`;
    const badge = document.createElement('span');
    badge.className = `agent ${agent || 'system'}`;
    badge.textContent = agent || 'system';
    const text = document.createElement('span');
    text.textContent = message;
    row.append(badge, text);
    activity.append(row);
    while (activity.children.length > 250) activity.firstElementChild?.remove();
    activity.scrollTop = activity.scrollHeight;
  }

  function renderWarnings(run) {
    const items = [...(run.warnings || [])];
    if (run.error) items.push(`Error: ${run.error}`);
    warnings.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('li');
        row.textContent = item;
        return row;
      }),
    );
    warnings.hidden = items.length === 0;
  }

  function renderRun(run) {
    if (!run) return;
    status.textContent = run.status;
    status.className = `badge ${run.status}`;
    start.disabled = run.status === 'running';
    cancel.disabled = run.status !== 'running';
    usage.textContent = `Claude ${formatUsage(run.usage.claude)} · Codex ${formatUsage(run.usage.codex)}`;
    renderWarnings(run);
    stages.replaceChildren();
    for (const stage of run.stages) {
      const row = document.createElement('li');
      row.className = `stage ${stage.status}`;
      const marker = document.createElement('span');
      marker.className = 'stage-marker';
      marker.textContent = markerFor(stage.status);
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = stage.title;
      const meta = document.createElement('small');
      meta.textContent = `${stage.assignedAgent} · ${stage.permission}${stage.fallback ? ' · fallback' : ''}`;
      details.append(title, meta);
      row.append(marker, details);
      stages.append(row);
    }
  }

  function markerFor(stageStatus) {
    return { completed: '✓', running: '→', failed: '!', cancelled: '×', skipped: '–', pending: '·' }[stageStatus] || '·';
  }

  function formatUsage(value) {
    return `${value.inputTokens || 0} in / ${value.outputTokens || 0} out`;
  }

  function renderHealth(items) {
    for (const item of items) {
      const card = byId(`${item.agent}Health`);
      if (!card) continue;
      card.querySelector('.dot').className = `dot ${item.available ? 'available' : 'unavailable'}`;
      const detail = card.querySelector('small');
      detail.textContent = item.version || item.detail;
      detail.title = item.detail;
    }
  }

  start.addEventListener('click', () => {
    errorBox.hidden = true;
    // Disabled immediately so a double click cannot send two start requests.
    start.disabled = true;
    persist();
    vscode.postMessage({
      type: 'start',
      kind: kind.value,
      objective: objective.value,
      allowWrites: allowWrites.checked,
    });
  });
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  byId('doctor').addEventListener('click', () => vscode.postMessage({ type: 'doctor' }));
  byId('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  byId('clearActivity').addEventListener('click', () => activity.replaceChildren());
  kind.addEventListener('change', updateConsent);
  objective.addEventListener('input', persist);
  allowWrites.addEventListener('change', persist);

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'initial-state') renderRun(data.latest);
    if (data.type === 'run-updated') renderRun(data.run);
    if (data.type === 'agent-event' && data.agentEvent) {
      addActivity(data.agentEvent.agent, data.agentEvent.message, data.agentEvent.category);
    }
    if (data.type === 'health') renderHealth(data.health);
    if (data.type === 'ui-error') {
      errorBox.textContent = data.detail;
      errorBox.hidden = false;
      start.disabled = false;
    }
  });

  updateConsent();
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'doctor' });
})();
