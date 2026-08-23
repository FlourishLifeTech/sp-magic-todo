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

    function buildTaskListHtml(taskList, projectId) {
      let filtered = taskList.slice();
      if (projectId) {
        filtered = filtered.filter(t => t.projectId === projectId);
      }
      if (filtered.length === 0) {
        return '<div style="padding:12px;color:var(--text-color-muted);text-align:center;">No tasks match</div>';
      }
      return filtered.map(t => {
        const projectTitle = t.projectId ? (projectMap[t.projectId] || '') : '';
        const label = escapeHtml(t.title) + (projectTitle ? ' <span style="color:var(--text-color-muted);font-size:0.85em;">(' + escapeHtml(projectTitle) + ')</span>' : '');
        return '<div class="mt-pick-item" data-task-id="' + t.id + '" style="padding:8px;cursor:pointer;border-bottom:1px solid var(--divider-color);">' + label + '</div>';
      }).join('');
    }

    const pickerHtml = '<div id="mt-picker-dialog" style="padding:8px 0;">' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">' +
        '<input type="text" id="mt-search-input" placeholder="Search tasks..." style="flex:2;min-width:140px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);" />' +
        '<select id="mt-project-filter" style="flex:1;min-width:100px;padding:6px;border-radius:4px;border:1px solid var(--divider-color);background:var(--card-bg);color:var(--text-color);font-family:var(--font-primary-stack);">' + projectOptions.join('') + '</select>' +
      '</div>' +
      '<div id="mt-picker-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--divider-color);border-radius:4px;background:var(--card-bg);">' +
        buildTaskListHtml(sortedTasks, '') +
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
      const list = document.getElementById('mt-picker-list');
      if (!searchInput || !projectFilter || !list) return;
      const query = searchInput.value.toLowerCase().trim();
      const projectId = projectFilter.value;
      const filtered = sortedTasks.filter(t => {
        const matchesSearch = !query || t.title.toLowerCase().includes(query);
        const matchesProject = !projectId || t.projectId === projectId;
        return matchesSearch && matchesProject;
      });
      list.innerHTML = buildTaskListHtml(filtered, projectId);
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
        const depth = await computeDepth(task.id);
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

    if (data.type === 'magic-get-config') {
      if (event.source !== iframeWindow) return;
      if (event.source) {
        event.source.postMessage({ type: 'magic-config-response', config: config }, event.origin);
      }
      return;
    }

    if (data.type === 'magic-iframe-ready') {
      if (iframeWindow !== null && event.source !== iframeWindow) return;
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
          event.source.postMessage({ type: 'magic-config-saved', reqId: data.reqId, config: config }, event.origin);
        }
      } catch (e) {
        PluginAPI.showSnack({ msg: 'Failed to save settings: ' + e.message, type: 'ERROR' });
        if (event.source) {
          event.source.postMessage({ type: 'magic-config-saved', reqId: data.reqId, config: null, error: e.message }, event.origin);
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
        }, event.origin);
      }
      return;
    }

    if (data.type === 'magic-open-task-picker') {
      if (event.source !== iframeWindow) return;
      const task = await openTaskPicker();
      if (event.source) {
        event.source.postMessage({ type: 'magic-task-picked', reqId: data.reqId, task: task }, event.origin);
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
          event.source.postMessage({ type: 'magic-task-crud-result', reqId: data.reqId, ok: true, id: id }, event.origin);
        }
      } catch (e) {
        if (event.source) {
          event.source.postMessage({ type: 'magic-task-crud-result', reqId: data.reqId, ok: false, error: e.message }, event.origin);
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