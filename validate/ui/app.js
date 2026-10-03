import { renderAnsi } from '/ansi.js';
import { activeGroups, editPlan, dropStep } from '/plan.js';

const $ = id => document.getElementById(id);
const renderedOutput = new WeakMap();
let state, planKey = '', projectKey = '', selectedRun = '', historyKey = '', resultKey = '';
let pending = false, polling = false, followLatest = true, expandedHistory = false;
const controls = new Map();
let draggedStep = null;
const openSteps = new Set();
let detectionRequested = true;
let stopped = false;

async function api(path, body) {
  const response = await fetch(location.pathname + path.replace(/^\//, ''), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Validate': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setDisabled() {
  const busy = stopped || !state || pending || state.busy;
  document.querySelectorAll('#stop-server, #run, #use-nix, #project-form button, #project, #steps input, #steps button, #available-steps button').forEach(element => { element.disabled = Boolean(busy) || element.dataset.unavailable === 'true'; });
  $('run').textContent = state?.busy ? 'Running…' : pending ? 'Working…' : 'Run';
}

function render(next) {
  if (stopped) return;
  state = next;
  if (projectKey !== state.cwd) {
    projectKey = state.cwd;
    detectionRequested = true;
    $('project').value = state.cwd;
    planKey = ''; historyKey = ''; resultKey = null; selectedRun = ''; followLatest = true; expandedHistory = false;
  }
  const key = JSON.stringify(state.plan);
  if (key !== planKey) {
    planKey = key;
    $('use-nix').checked = Boolean(state.plan.useNix);
    renderSteps();
    renderCatalog();
  }
  for (const step of state.steps) {
    const detection = controls.get(step.name)?.detection;
    if (!detection) continue;
    detection.textContent = !step.detection ? 'Not checked' : step.detection.error ? `Error: ${step.detection.error}` : step.detection.applicable ? 'Applicable' : 'Not applicable';
    detection.title = step.detection?.checkedAt || '';
  }

  const ids = state.runs.map(run => `${run.id}:${run.finishedAt || ''}`).join(',');
  if (historyKey !== ids) {
    historyKey = ids;
    if (followLatest || !state.runs.some(run => run.id === selectedRun)) {
      selectedRun = state.runs.at(-1)?.id || '';
    }
  }
  renderHistory();
  renderRun();
  setDisabled();
}

function dropTarget(element, index, between) {
  element.addEventListener('dragover', event => {
    if (!draggedStep || pending || state.busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    element.classList.add('drop-target');
  });
  element.addEventListener('dragleave', event => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('drop-target');
  });
  element.addEventListener('drop', event => {
    event.preventDefault();
    element.classList.remove('drop-target');
    if (!draggedStep || pending || state.busy) return;
    const plan = dropStep(state.plan, draggedStep, index, between);
    draggedStep = null;
    action(async () => render(await api('/api/plan', plan)));
  });
}

function renderSteps() {
  controls.clear();
  draggedStep = null;
  $('steps').replaceChildren();
  const groups = activeGroups(state.plan);
  function divider(index) {
    const divider = document.createElement('div');
    divider.className = 'group-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'Drop here to create a sequential group');
    const line = document.createElement('span');
    divider.append(line);
    dropTarget(divider, index, true);
    $('steps').append(divider);
  }
  for (const [index, group] of groups.entries()) {
    divider(index);
    const block = document.createElement('div');
    block.className = 'step-group';
    const rows = document.createElement('div');
    rows.className = 'run-list step-list';
    rows.setAttribute('aria-label', `Group ${index + 1} steps`);
    block.append(rows);
    dropTarget(block, index, false);
    $('steps').append(block);
    for (const stepName of group) {
      const step = state.steps.find(step => step.name === stepName);
      const row = document.createElement('details');
      row.className = 'step-details';
      row.open = openSteps.has(stepName);
      row.addEventListener('toggle', () => {
        if (row.open) openSteps.add(stepName);
        else openSteps.delete(stepName);
      });
      const title = document.createElement('summary');
      title.addEventListener('click', event => {
        if (event.target.closest('button')) event.preventDefault();
      });
      title.className = 'run-row step-row';
      const name = document.createElement('span');
      name.className = 'step-name';
      name.textContent = stepName;
      name.tabIndex = 0;
      name.draggable = true;
      name.title = 'Drag to a row for parallel execution or to a line for sequential execution. Keyboard: arrows reorder groups; Ctrl+Up joins; Ctrl+Down separates.';
      name.addEventListener('dragstart', event => {
        if (pending || state.busy) { event.preventDefault(); return; }
        draggedStep = stepName;
        event.dataTransfer.setData('text/plain', stepName);
        event.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      name.addEventListener('dragend', () => {
        draggedStep = null;
        document.querySelectorAll('.dragging, .drop-target').forEach(element => element.classList.remove('dragging', 'drop-target'));
      });
      name.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        changePlan(stepName, event.ctrlKey ? (event.key === 'ArrowUp' ? 'join' : 'separate') : (event.key === 'ArrowUp' ? 'up' : 'down'));
      });
      const detection = document.createElement('span');
      const policyCell = document.createElement('div');
      const choices = document.createElement('div');
      choices.className = 'policy-choices';
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', `${stepName} policy`);
      for (const [value, text] of [['agent', 'Agent'], ['user', 'User'], ['off', 'Off']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-pressed', String(state.plan.policies[stepName] === value));
        button.addEventListener('click', () => {
          if (state.plan.policies[stepName] !== value) changePlan(stepName, value);
        });
        choices.append(button);
      }
      policyCell.append(choices);
      const details = document.createElement('div');
      details.className = 'step-details-body';
      const parameters = Object.entries(step?.parameters ?? {});
      for (const [key, parameter] of parameters) {
        const label = document.createElement('label');
        label.className = 'step-parameter';
        label.textContent = parameter.label;
        const input = document.createElement('input');
        input.type = 'number';
        input.value = state.plan.configs?.[stepName]?.[key] ?? parameter.default;
        if (parameter.min !== undefined) input.min = parameter.min;
        if (parameter.max !== undefined) input.max = parameter.max;
        if (parameter.step !== undefined) input.step = parameter.step;
        input.addEventListener('change', () => changeConfig(stepName, key, Number(input.value)));
        label.append(input);
        details.append(label);
      }
      if (!parameters.length) details.textContent = 'No parameters.';
      controls.set(stepName, { detection });
      const remove = planButton('×', stepName, 'remove', 'Remove step from plan');
      remove.className = 'remove-step';
      title.append(name, detection, policyCell, remove);
      row.append(title, details);
      rows.append(row);
    }
  }
  divider(groups.length);
}

function renderHistory() {
  const runs = [...state.runs].reverse();
  const visible = expandedHistory ? runs : runs.slice(0, 5);
  // Keep an older selected run visible even while the list is collapsed.
  const selected = runs.find(run => run.id === selectedRun);
  if (selected && !visible.includes(selected)) visible.push(selected);
  const key = JSON.stringify([visible.map(run => [run.id, run.finishedAt]), selectedRun, expandedHistory]);
  if ($('history').dataset.key === key) return;
  $('history').dataset.key = key;
  $('history').replaceChildren();
  for (const run of visible) {
    const row = document.createElement('button'); row.className = 'run-row';
    row.setAttribute('aria-pressed', String(run.id === selectedRun));
    const failed = run.results.filter(result => result.status === 'failed').length;
    const values = [
      new Date(run.startedAt).toLocaleString(),
      run.caller === 'user' ? 'User' : 'Agent',
      run.finishedAt ? `${failed} failed` : 'Running',
      run.id.slice(0, 8),
    ];
    for (const [index, text] of values.entries()) {
      const cell = document.createElement('span');
      cell.textContent = text;
      if (index === 1) {
        cell.className = 'run-caller policy-pill';
        cell.dataset.caller = run.caller;
        cell.dataset.policy = run.caller;
      }
      row.append(cell);
    }
    row.addEventListener('click', () => {
      selectedRun = run.id;
      followLatest = selectedRun === state.runs.at(-1)?.id;
      renderHistory(); renderRun();
    });
    $('history').append(row);
  }
  $('history-more').hidden = runs.length <= 5;
  $('history-more').textContent = expandedHistory ? 'Less' : `More (${runs.length - 5})`;
}

function renderRun() {
  const run = state.runs.find(run => run.id === selectedRun);
  if (resultKey !== selectedRun) {
    resultKey = selectedRun;
    $('results').replaceChildren();
    if (run) for (const result of run.results) {
      const card = document.createElement('details');
      card.className = 'result';
      card.open = result.status === 'failed';
      const title = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'result-name';
      const policy = document.createElement('span');
      policy.className = 'policy-pill';
      title.append(name, policy);
      const output = document.createElement('pre');
      card.append(title, output); $('results').append(card);
    }
  }
  if (!run) { $('summary').textContent = 'No runs yet.'; return; }
  const failed = run.results.filter(result => result.status === 'failed').length;
  const passed = run.results.filter(result => result.status === 'passed').length;
  const caller = document.createElement('span');
  caller.className = 'run-caller';
  caller.dataset.caller = run.caller;
  caller.textContent = run.caller === 'user' ? 'User' : 'Agent';
  $('summary').replaceChildren(caller, document.createTextNode(` · ${run.finishedAt ? 'Finished' : 'Running'} · ${passed} passed · ${failed} failed · ${run.results.filter(result => result.status === 'skipped').length} skipped`));
  run.results.forEach((result, index) => {
    const card = $('results').children[index];
    if (result.status === 'failed' && card.dataset.status !== 'failed') card.open = true;
    card.dataset.status = result.status;
    const title = card.querySelector('summary');
    title.setAttribute('aria-label', `${result.name}: ${result.status}`);
    title.title = `${result.status}${result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}${result.reason ? ` · ${result.reason}` : ''}`;
    title.querySelector('.result-name').textContent = result.name;
    const policy = title.querySelector('.policy-pill');
    const visibility = run.caller === 'user' ? 'user' : result.policy;
    policy.textContent = visibility === 'agent' ? 'Agent' : visibility === 'user' ? 'User' : 'Off';
    policy.dataset.policy = visibility;
    const output = card.querySelector('pre');
    const text = result.output || (result.status === 'running' ? 'Waiting for output…' : 'No output.');
    if (renderedOutput.get(output) !== text) {
      renderAnsi(output, text);
      renderedOutput.set(output, text);
    }
  });
}

function changePlan(name, operation) {
  action(async () => render(await api('/api/plan', editPlan(state.plan, name, operation))));
}

function changeConfig(name, key, value) {
  action(async () => render(await api('/api/plan', {
    ...state.plan,
    configs: { ...state.plan.configs, [name]: { ...(state.plan.configs?.[name] ?? {}), [key]: value } },
  })));
}

function planButton(text, name, operation, title, unavailable = false) {
  const button = document.createElement('button'); button.textContent = text;
  button.title = title; button.setAttribute('aria-label', `${name}: ${title}`);
  button.dataset.unavailable = String(unavailable);
  button.addEventListener('click', () => changePlan(name, operation));
  return button;
}

function renderCatalog() {
  const query = $('step-search').value.trim().toLowerCase();
  const available = state.steps.filter(step => (state.plan.removed ?? []).includes(step.name) && step.name.toLowerCase().includes(query));
  $('available-steps').replaceChildren();
  for (const step of available) {
    const row = document.createElement('div'); row.className = 'catalog-row';
    const name = document.createElement('span'); name.textContent = step.name;
    row.append(name, planButton('Add', step.name, 'add', 'Add this step to the execution plan'));
    $('available-steps').append(row);
  }
  if (!available.length) $('available-steps').textContent = query ? 'No matching available steps.' : 'All installed steps are already in the plan.';
  setDisabled();
}

async function action(operation) {
  if (pending || state?.busy) return;
  pending = true; $('error').textContent = ''; setDisabled();
  try { await operation(); }
  catch (error) {
    planKey = '';
    $('error').textContent = String(error);
  }
  finally {
    pending = false;
    try { render(await api('/api/state')); } catch (error) { $('error').textContent = String(error); }
    setDisabled();
  }
}
$('project-form').addEventListener('submit', event => {
  event.preventDefault();
  const cwd = $('project').value.trim();
  if (!cwd.startsWith('/')) { $('error').textContent = 'Use an absolute project path.'; return; }
  location.assign('/projects' + cwd.replace(/\/+$/, '').split('/').map(encodeURIComponent).join('/') + '/');
});
async function checkAvailability() {
  if (!detectionRequested || !state || pending || state.busy) return;
  detectionRequested = false;
  await action(async () => render(await api('/api/detect', {})));
}
$('catalog').addEventListener('toggle', () => {
  if (!$('catalog').open) return;
  detectionRequested = true;
  checkAvailability();
});
$('use-nix').addEventListener('change', () => {
  const useNix = $('use-nix').checked;
  action(async () => render(await api('/api/plan', { ...state.plan, useNix })));
});
$('step-search').addEventListener('input', renderCatalog);
$('run').addEventListener('click', () => action(async () => {
  followLatest = true;
  await api('/api/run', { caller: 'user' });
}));
$('stop-server').addEventListener('click', async () => {
  if (pending || stopped || !confirm('Stop the server for all projects? Run validate in Pi to start it again.')) return;
  pending = true;
  setDisabled();
  try {
    const response = await fetch('/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Validate': '1' },
      body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    stopped = true;
    $('error').textContent = '';
    $('summary').textContent = 'Server stopped. Run validate in Pi to restart it, then reload this page.';
  } catch (error) { $('error').textContent = String(error); }
  finally { pending = false; setDisabled(); }
});
$('history-more').addEventListener('click', () => {
  expandedHistory = !expandedHistory;
  renderHistory();
});
async function poll() {
  if (polling || stopped) return;
  polling = true;
  try {
    render(await api('/api/state'));
    await checkAvailability();
  }
  catch (error) { if (!stopped) $('error').textContent = String(error); }
  finally { polling = false; }
}
poll();
setInterval(poll, 500);
