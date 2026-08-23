// Magic ToDo - AI task breakdown plugin for Super Productivity
// Host-side logic: header button, shortcut, hooks, task picker, config persistence,
// and message bridge to the side panel iframe.

const CONFIG_KEY = 'magicTodoConfig';

let iframeWindow = null;
let lastCurrentTaskId = null;
let config = null;
let iframeReady = false;
let pendingBreakdown = null;

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendToIframe(msg) {
  if (iframeWindow) {
    try {
      iframeWindow.postMessage(msg, '*');
    } catch (e) {
      // ignore
    }
  }
}

async function loadConfig() {
  let loaded = false;
  try {
    if (typeof PluginAPI?.loadSyncedData === 'function') {
      const saved = await PluginAPI.loadSyncedData(CONFIG_KEY);
      if (saved) {
        config = JSON.parse(saved);
        loaded = true;
        console.log('[MagicToDo] config loaded via PluginAPI');
      }
    }
  } catch (e) {
    console.warn('[MagicToDo] PluginAPI.loadSyncedData failed, falling back to localStorage', e);
  }
  if (!loaded) {
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (saved) {
        config = JSON.parse(saved);
        console.log('[MagicToDo] config loaded via localStorage');
      } else {
        config = null;
      }
    } catch (e) {
      config = null;
    }
  }
}

async function saveConfig(cfg) {
  config = cfg;
  let apiOk = false;
  try {
    if (typeof PluginAPI?.persistDataSynced === 'function') {
      await PluginAPI.persistDataSynced(JSON.stringify(cfg), CONFIG_KEY);
      apiOk = true;
      console.log('[MagicToDo] config saved via PluginAPI');
    }
  } catch (e) {
    console.warn('[MagicToDo] PluginAPI.persistDataSynced failed', e);
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    if (apiOk) {
      console.log('[MagicToDo] config also saved via localStorage for fallback');
    } else {
      console.log('[MagicToDo] config saved via localStorage');
    }
  } catch (e) {
    console.warn('[MagicToDo] localStorage save failed', e);
  }
}

// Resolve the target task: selected -> focused -> last current -> null
async function resolveTargetTask() {
  let task = null;
  try {
    task = await PluginAPI.getSelectedTask();
  } catch (e) {
    // ignore
  }
  if (!task) {
    try {
      task = await PluginAPI.getFocusedTask();
    } catch (e) {
      // ignore
    }
  }
  if (!task && lastCurrentTaskId) {
    try {
      const tasks = await PluginAPI.getTasks();
      task = tasks.find(t => t.id === lastCurrentTaskId) || null;
    } catch (e) {
      // ignore
    }
  }
  return task;
}

// Depth: 0 = main task, 1 = subtask, 2 = sub-subtask (max, checklist level)
async function computeDepth(taskId) {
  try {
    const tasks = await PluginAPI.getTasks();
    const map = {};
    tasks.forEach(t => { map[t.id] = t; });
    let depth = 0;
    let cur = map[taskId];
    while (cur && cur.parentId && map[cur.parentId]) {
      depth++;
      cur = map[cur.parentId];
      if (depth >= 3) break;
    }
    return depth;
  } catch (e) {
    return 0;
  }
}

// Opens the plugin's side panel. Host PluginAPI exposes no supported way to open
// the panel programmatically (showIndexHtmlInSidePanel is iframe-bridge only,
// and togglePluginPanel is not whitelisted), so we click the app's auto-registered
// side-panel toggle button (class .plugin-side-panel-btn, tooltip = plugin label),
// which dispatches the internal togglePluginPanel action. Never use
// showIndexHtmlAsView — that opens a full-screen route, which is not what we want.
function openSidePanel() {
  try {
    const candidates = document.querySelectorAll('button.plugin-side-panel-btn, [class*="side-panel"] button, [class*="sidePanel"] button, [class*="plugin-panel"] button');
    for (const btn of candidates) {
      const tooltip = (btn.getAttribute('matTooltip') || '').toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const text = (btn.textContent || '').toLowerCase();
      if (tooltip.indexOf('magic todo') !== -1 || tooltip.indexOf('magic-todo') !== -1 ||
          ariaLabel.indexOf('magic todo') !== -1 || ariaLabel.indexOf('magic-todo') !== -1 ||
          text.indexOf('magic todo') !== -1 || text.indexOf('magic-todo') !== -1) {
        btn.click();
        iframeReady = false;
        iframeWindow = null;
        return true;
      }
    }
  } catch (e) {
    // ignore
  }
  return false;
}

function sendBreakdownRequest(task) {
  const msg = {
    type: 'magic-breakdown-request',
    taskId: task.id,
    title: task.title,
    notes: task.notes || '',
    projectId: task.projectId || null,
    depth: task.depth !== undefined ? task.depth : 0
  };
  if (iframeReady) {
    sendToIframe(msg);
  } else {
    // Iframe not loaded yet (panel was closed): flush once it signals ready.
    pendingBreakdown = msg;
  }
}

async function handleHeaderClick() {
  try {
    let task = await resolveTargetTask();
    if (!task) {
      // No task selected: open the task picker first (same as task-color plugin).
      task = await openTaskPicker();
      if (!task) return;
    }
    task.depth = await computeDepth(task.id);

    sendBreakdownRequest(task);
    PluginAPI.showSnack({ msg: 'Open the Magic ToDo sidebar to see the picked task.', type: 'INFO' });
  } catch (e) {
    PluginAPI.showSnack({ msg: 'Magic ToDo: ' + e.message, type: 'ERROR' });
  }
}

// ---- Host-side task picker dialog (proven pattern from task-color-plugin) ----
async function openTaskPicker() {
  try {
    const tasks = await PluginAPI.getTasks();
    const activeTasks = tasks.filter(t => !t.isDone);
    if (activeTasks.length === 0) {
      PluginAPI.showSnack({ msg: 'No active tasks available', type: 'WARNING' });
      return null;
    }

    const projects = await PluginAPI.getAllProjects();
    const projectMap = {};
    projects.forEach(p => { projectMap[p.id] = p.title; });

    // Build a map of parentId -> child ids for depth computation
    const parentMap = {};
    const taskMap = {};
    activeTasks.forEach(t => {
      taskMap[t.id] = t;
      if (t.parentId) {
        if (!parentMap[t.parentId]) parentMap[t.parentId] = [];
        parentMap[t.parentId].push(t.id);
      }
    });

    function computeDepth(taskId) {
      let depth = 0;
      let cur = taskMap[taskId];
      while (cur && cur.parentId && taskMap[cur.parentId]) {
        depth++;
        cur = taskMap[cur.parentId];
        if (depth >= 3) break;
      }
      return depth;
    }

    const sortedTasks = activeTasks.slice().sort((a, b) => {
      const timeA = a.updated || a.created || 0;
      const timeB = b.updated || b.created || 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.title.localeCompare(b.title);
    });

    const projectOptions = ['<option value="">All projects</option>'];
    projects.forEach(p => {
      projectOptions.push('<option value="' + p.id + '">' + escapeHtml(p.title) + '</option>');
    });

    const levelOptions = [
      { value: '0', label: '1st level (main tasks)' },
      { value: '1', label: '2nd level (+ subtasks)' },
      { value: '2', label: '3rd level (+ checklist)' }
    ];
    const levelOptionHtml = levelOptions.map(o => '<option value="' + o.value + '">' + escapeHtml(o.label) + '</option>').join('');

    function buildTaskListHtml(taskList, projectId, maxDepth) {
      let filtered = taskList.slice();
      if (projectId) {
        filtered = filtered.filter(t => t.projectId === projectId);
      }
      if (maxDepth !== '') {
        filtered = filtered.filter(t => computeDepth(t.id) <= parseInt(maxDepth, 10));
      }
      if (filtered.length === 0) {
        return '<div style="padding:12px;color:var(--text-color-muted);text-align:center;">No tasks match</div>';
      }
      return filtered.map(t => {
        const projectTitle = t.projectId ? (projectMap[t.projectId] || '') : '';
        const depth = computeDepth(t.id);
        const indent = depth > 0 ? 'margin-left:' + (depth * 16) + 'px;' : '';
        const badge = depth > 0 ? ' <span style="color:var(--text-color-muted);font-size:0.8em;">(' + ['main','subtask','checklist'][depth] + ')</span>' : '';
        const label = escapeHtml(t.title) + badge + (projectTitle ? ' <span style="color:var(--text-color-muted);font-size:0.85em;">(' + escapeHtml(projectTitle) + ')</span>' : '');
        return '<div class="mt-pick-item" data-task-id="' + t.id + '" style="padding:8px;cursor:pointer;border-bottom:1px solid var(--divider-color);' + indent + '">' + label + '</div>';
      }).join('');
    }

    const pickerHtml = '<div id="mt-picker-dialog" style="padding:8px 0;">' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">' +
        '<input type="text" id="mt-search-input" placeholder="Search tasks..." style="flex:2;min-width:140px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);" />' +
        '<select id="mt-project-filter" style="flex:1;min-width:100px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);">' + projectOptions.join('') + '</select>' +
        '<select id="mt-level-filter" style="flex:1;min-width:120px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);">' + levelOptionHtml + '</select>' +
        '<label style="flex:1;min-width:180px;font-size:0.9em;color:var(--text-color);cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);">' +
          '<input type="checkbox" id="mt-leaf-only" style="width:auto;margin:0;" /> Only main tasks without subtasks' +
        '</label>' +
      '</div>' +
      '<div id="mt-picker-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--divider-color);border-radius:4px;background:var(--card-bg);">' +
        buildTaskListHtml(sortedTasks, '', '') +
      '</div>' +
    '</div>';

    let selectedTaskId = null;

    const clickHandler = (e) => {
      const item = e.target.closest('.mt-pick-item');
      if (!item) return;
      const list = document.getElementById('mt-picker-list');
      if (!list || !list.contains(item)) return;
      e.preventDefault();
      e.stopPropagation();
      list.querySelectorAll('.mt-pick-item').forEach(el => {
        el.style.background = '';
        el.classList.remove('selected');
      });
      item.style.background = 'var(--bg-lighter)';
      item.classList.add('selected');
      selectedTaskId = item.getAttribute('data-task-id');
    };

    const inputHandler = () => {
      const searchInput = document.getElementById('mt-search-input');
      const projectFilter = document.getElementById('mt-project-filter');
      const levelFilter = document.getElementById('mt-level-filter');
      const leafOnly = document.getElementById('mt-leaf-only');
      const list = document.getElementById('mt-picker-list');
      if (!searchInput || !projectFilter || !list) return;
      const query = searchInput.value.toLowerCase().trim();
      const projectId = projectFilter.value;
      const maxDepth = levelFilter ? levelFilter.value : '';
      const onlyLeaf = leafOnly ? leafOnly.checked : false;
      const filtered = sortedTasks.filter(t => {
        const matchesSearch = !query || t.title.toLowerCase().includes(query);
        const matchesProject = !projectId || t.projectId === projectId;
        const matchesLevel = maxDepth === '' || computeDepth(t.id) <= parseInt(maxDepth, 10);
        const matchesLeaf = !onlyLeaf || (computeDepth(t.id) === 0 && !parentMap[t.id]);
        return matchesSearch && matchesProject && matchesLevel && matchesLeaf;
      });
      list.innerHTML = buildTaskListHtml(filtered, projectId, maxDepth);
    };

    document.addEventListener('mousedown', clickHandler, true);
    document.addEventListener('input', inputHandler);
    document.addEventListener('change', inputHandler);

    await PluginAPI.openDialog({
      title: 'Pick a task',
      htmlContent: pickerHtml,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Pick',
          color: 'primary',
          raised: true,
          onClick: () => {
            if (!selectedTaskId) {
              const selectedEl = document.querySelector('#mt-picker-list .mt-pick-item.selected');
              selectedTaskId = selectedEl ? selectedEl.getAttribute('data-task-id') : null;
            }
          }
        }
      ]
    });

    document.removeEventListener('mousedown', clickHandler, true);
    document.removeEventListener('input', inputHandler);
    document.removeEventListener('change', inputHandler);

    if (selectedTaskId) {
      const task = activeTasks.find(t => t.id === selectedTaskId);
      if (task) {
        const depth = computeDepth(task.id);
        return {
          id: task.id,
          title: task.title,
          notes: task.notes || '',
          projectId: task.projectId || null,
          depth: depth
        };
      }
    }
    return null;
  } catch (e) {
    PluginAPI.showSnack({ msg: 'Task picker failed: ' + e.message, type: 'ERROR' });
    return null;
  }
}

function register() {
  PluginAPI.registerHeaderButton({
    label: 'Magic ToDo',
    icon: 'auto_awesome',
    onClick: handleHeaderClick
  });

  PluginAPI.registerShortcut({
    id: 'magic-todo-shortcut',
    label: 'Break down task with AI',
    keys: 'ctrl+shift+m',
    onExec: handleHeaderClick
  });

  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, (payload) => {
    lastCurrentTaskId = payload.current ? payload.current.id : null;
    sendToIframe({ type: 'magic-current-task-changed', taskId: lastCurrentTaskId });
  });

  let updateTimer = null;
  PluginAPI.registerHook(PluginAPI.Hooks.ANY_TASK_UPDATE, () => {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      sendToIframe({ type: 'magic-task-updated' });
    }, 300);
  });

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (!event.source) return;
    var targetOrigin = event.origin && event.origin !== 'null' ? event.origin : '*';

    if (data.type === 'magic-get-config') {
      if (event.source !== iframeWindow) return;
      if (event.source) {
        const safeConfig = { ...(config || {}) };
        delete safeConfig.apiKey;
        event.source.postMessage({ type: 'magic-config-response', config: safeConfig }, targetOrigin);
      }
      return;
    }

    if (data.type === 'magic-iframe-ready') {
      iframeWindow = event.source;
      iframeReady = true;
      sendToIframe({ type: 'magic-init', config: config, currentTaskId: lastCurrentTaskId });
      if (pendingBreakdown) {
        const p = pendingBreakdown;
        pendingBreakdown = null;
        sendToIframe(p);
      }
      return;
    }

    if (data.type === 'magic-save-config') {
      if (event.source !== iframeWindow) return;
      try {
        await saveConfig(data.config || {});
        PluginAPI.showSnack({ msg: 'Magic ToDo settings saved', type: 'SUCCESS' });
        if (event.source) {
          event.source.postMessage({ type: 'magic-config-saved', reqId: data.reqId, config: config }, targetOrigin);
        }
      } catch (e) {
        PluginAPI.showSnack({ msg: 'Failed to save settings: ' + e.message, type: 'ERROR' });
        if (event.source) {
          event.source.postMessage({ type: 'magic-config-saved', reqId: data.reqId, config: null, error: e.message }, targetOrigin);
        }
      }
      return;
    }

    if (data.type === 'magic-get-current-task') {
      if (event.source !== iframeWindow) return;
      const task = await resolveTargetTask();
      let depth = 0;
      if (task) depth = await computeDepth(task.id);
      if (event.source) {
        event.source.postMessage({
          type: 'magic-current-task-resolved',
          reqId: data.reqId,
          task: task ? { id: task.id, title: task.title, notes: task.notes || '', projectId: task.projectId || null, depth: depth } : null
        }, targetOrigin);
      }
      return;
    }

    if (data.type === 'magic-open-task-picker') {
      if (event.source !== iframeWindow) return;
      let task = null;
      try {
        task = await openTaskPicker();
      } catch (e) {
        console.error('[MagicToDo] openTaskPicker threw:', e);
      }
      if (event.source) {
        event.source.postMessage({ type: 'magic-task-picked', reqId: data.reqId, task: task }, targetOrigin);
      }
      return;
    }

    if (data.type === 'magic-task-crud') {
      if (event.source !== iframeWindow) return;
      try {
        let id = null;
        if (data.action === 'add') {
          id = await PluginAPI.addTask(data.data);
        } else if (data.action === 'update') {
          await PluginAPI.updateTask(data.id, data.changes);
          id = data.id;
        } else if (data.action === 'delete') {
          await PluginAPI.deleteTask(data.id);
          id = data.id;
        }
        if (event.source) {
          event.source.postMessage({ type: 'magic-task-crud-result', reqId: data.reqId, ok: true, id: id }, targetOrigin);
        }
      } catch (e) {
        if (event.source) {
          event.source.postMessage({ type: 'magic-task-crud-result', reqId: data.reqId, ok: false, error: e.message }, targetOrigin);
        }
      }
      return;
    }

    if (data.type === 'magic-ai-request') {
      if (event.source !== iframeWindow) return;
      try {
        if (!config || !config.baseUrl) {
          throw new Error('Configure the AI endpoint first');
        }
        var baseUrl = String(config.baseUrl).replace(/\/+$/, '');
        var headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;
        var body = {
          model: config.model || 'gpt-4o',
          messages: [
            { role: 'system', content: data.systemPrompt || '' },
            { role: 'user', content: data.userPrompt || '' }
          ],
          max_tokens: parseInt(data.maxTokens || config.maxTokens || '2048', 10) || 2048,
          temperature: data.temperature !== undefined ? parseFloat(data.temperature) : (config.temperature !== undefined ? parseFloat(config.temperature) : 0.7)
        };
        var resp = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body)
        });
        if (!resp.ok) {
          var t = '';
          try { t = await resp.text(); } catch (e) {}
          throw new Error('API ' + resp.status + ': ' + t.slice(0, 300));
        }
        var result = await resp.json();
        if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
        var content = result.choices && result.choices[0] && result.choices[0].message ? result.choices[0].message.content : '';
        if (event.source) {
          event.source.postMessage({ type: 'magic-ai-response', reqId: data.reqId, content: content }, targetOrigin);
        }
      } catch (e) {
        if (event.source) {
          event.source.postMessage({ type: 'magic-ai-response', reqId: data.reqId, content: null, error: e.message }, targetOrigin);
        }
      }
      return;
    }
  });
}

async function init() {
  try {
    // Preload config synchronously so we never send magic-init with null.
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (saved) {
        config = JSON.parse(saved);
        console.log('[MagicToDo] config preloaded from localStorage before register');
      }
    } catch (e) {
      // ignore
    }

    register();
    await loadConfig();

    if (iframeReady && iframeWindow) {
      sendToIframe({ type: 'magic-init', config: config, currentTaskId: lastCurrentTaskId });
    }
  } catch (e) {
    console.error('Magic ToDo plugin init failed:', e);
  }
}

if (typeof plugin !== 'undefined' && plugin.onReady) {
  plugin.onReady(init);
} else if (PluginAPI.onReady) {
  PluginAPI.onReady(init);
} else {
  init();
}