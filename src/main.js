
    // ==================== STATE ====================
    var config = null;
    var currentTask = null; // {id,title,notes,projectId,depth}
    var taskMap = {};       // id -> task
    var reqCounter = 0;

    // ==================== HELPERS ====================
    function escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showSnack(msg, type) {
      try {
        PluginAPI.showSnack({ msg: msg, type: type || 'INFO' });
      } catch (e) {
        // ignore
      }
    }

    // ==================== AI INSTRUCTIONS MARKER ====================
    // Persisted per-task in notes as a marker line, like the color plugin pattern.
    const AI_MARKER = '__magic_todo_ai__=';

    function getAiInstructions(notes) {
      if (!notes) return '';
      const idx = notes.indexOf(AI_MARKER);
      if (idx === -1) return '';
      const start = idx + AI_MARKER.length;
      const end = notes.indexOf('\n', start);
      const jsonStr = end === -1 ? notes.substring(start) : notes.substring(start, end);
      try {
        const data = JSON.parse(jsonStr);
        return data.instructions || '';
      } catch (e) {
        return '';
      }
    }

    // Remove plugin metadata lines (e.g. __task_colors__=...) for AI prompts.
    function stripMetadataForAI(notes) {
      return String(notes || '')
        .split('\n')
        .filter(function (line) { return !/^__\w+__\s*=/i.test(line); })
        .join('\n')
        .trim();
    }

    // Append checklist markdown to a note, after the last checklist line if present.
    function setChecklistInNote(note, items) {
      var base = String(note || '');
      var checklist = items.map(function (it) { return '- [ ] ' + it.title; }).join('\n');
      if (!base.trim()) return checklist;
      var lines = base.split('\n');
      var lastChecklistIdx = -1;
      for (var i = lines.length - 1; i >= 0; i--) {
        if (/^\s*-\s*\[[ xX]\]/.test(lines[i])) {
          lastChecklistIdx = i;
          break;
        }
      }
      if (lastChecklistIdx >= 0) {
        var after = lines.slice(lastChecklistIdx + 1).join('\n');
        var before = lines.slice(0, lastChecklistIdx + 1).join('\n');
        return before + '\n' + checklist + (after ? '\n' + after : '');
      }
      return base + '\n' + checklist;
    }

    // Parse `- [ ]` / `- [x]` lines out of a note.
    function parseChecklist(note) {
      var out = [];
      String(note || '').split('\n').forEach(function (l) {
        var m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(l);
        if (m) out.push({ text: m[2], done: m[1].toLowerCase() === 'x' });
      });
      return out;
    }

    // Replace the nth checklist line's text / done state in a note.
    function replaceChecklistLine(note, index, newText, done) {
      var lines = String(note || '').split('\n');
      var seen = 0;
      for (var i = 0; i < lines.length; i++) {
        var m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        if (seen === index) {
          var mark = done ? 'x' : ' ';
          lines[i] = '- [' + mark + '] ' + newText;
          return lines.join('\n');
        }
        seen++;
      }
      return note;
    }

    // Remove the nth checklist line from a note.
    function removeChecklistLine(note, index) {
      var lines = String(note || '').split('\n');
      var seen = 0;
      for (var i = 0; i < lines.length; i++) {
        if (!/^\s*-\s*\[([ xX])\]/.test(lines[i])) continue;
        if (seen === index) {
          lines.splice(i, 1);
          return lines.join('\n');
        }
        seen++;
      }
      return note;
    }

    function setAiInstructionsInNotes(notes, instructions) {
      let before = '';
      let after = '';
      if (notes) {
        const idx = notes.indexOf(AI_MARKER);
        if (idx !== -1) {
          const start = idx + AI_MARKER.length;
          const end = notes.indexOf('\n', start);
          before = notes.substring(0, idx);
          after = end === -1 ? '' : notes.substring(end + 1);
        } else {
          before = notes;
        }
      }
      const markerLine = AI_MARKER + JSON.stringify({ instructions: instructions });
      const combined = (before + after).trim();
      return combined ? combined + '\n' + markerLine : markerLine;
    }

    // postMessage to host with reqId, resolve on matching reply (30s timeout)
    function postToHost(msg) {
      return new Promise(function (resolve) {
        var reqId = ++reqCounter;
        msg.reqId = reqId;
        var handler = function (event) {
          if (event.data && event.data.reqId === reqId) {
            window.removeEventListener('message', handler);
            resolve(event.data);
          }
        };
        window.addEventListener('message', handler);
        try {
          window.parent.postMessage(msg, '*');
        } catch (e) {
          window.removeEventListener('message', handler);
          resolve(null);
        }
        setTimeout(function () {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 30000);
      });
    }

    // ==================== TASK DATA ====================
    async function buildTaskMap() {
      try {
        var tasks = await PluginAPI.getTasks();
        taskMap = {};
        tasks.forEach(function (t) { taskMap[t.id] = t; });
      } catch (e) {
        taskMap = {};
      }
    }

    function getChildren(taskId) {
      var kids = [];
      Object.keys(taskMap).forEach(function (id) {
        if (taskMap[id].parentId === taskId) kids.push(taskMap[id]);
      });
      var parent = taskMap[taskId];
      if (parent && parent.subTaskIds && parent.subTaskIds.length) {
        var order = {};
        parent.subTaskIds.forEach(function (sid, i) { order[sid] = i; });
        kids.sort(function (a, b) {
          var ia = order[a.id] !== undefined ? order[a.id] : 999;
          var ib = order[b.id] !== undefined ? order[b.id] : 999;
          return ia - ib;
        });
      }
      return kids;
    }

    function computeDepthOf(taskId) {
      var depth = 0;
      var cur = taskMap[taskId];
      while (cur && cur.parentId && taskMap[cur.parentId]) {
        depth++;
        cur = taskMap[cur.parentId];
        if (depth >= 3) break;
      }
      return depth;
    }

    // ==================== RENDER ====================
    function renderCurrentTask() {
      var el = document.getElementById('currentTaskInfo');
      var btn = document.getElementById('btnBreakDown');
      var aiInput = document.getElementById('aiInstructions');
      if (!currentTask) {
        el.innerHTML = '<div class="empty-state">No task selected.</div>';
        btn.disabled = true;
        if (aiInput) { aiInput.value = ''; aiInput.disabled = true; }
        document.getElementById('btnSaveAiInstructions').disabled = true;
        return;
      }
      var depth = currentTask.depth !== undefined ? currentTask.depth : computeDepthOf(currentTask.id);
      var badge = depth === 0 ? 'Main task' : depth === 1 ? 'Subtask' : 'Sub-subtask — max depth';
      var badgeCls = depth >= 2 ? 'ct-badge max' : 'ct-badge';
      el.innerHTML =
        '<div class="ct-title editable" id="ctTitleClickable" title="Click to rename this task">' + escapeHtml(currentTask.title) + '</div>' +
        '<span class="' + badgeCls + '">' + badge + '</span>';
      btn.disabled = depth >= 2;
      if (aiInput) {
        aiInput.disabled = false;
        aiInput.value = getAiInstructions(taskMap[currentTask.id] ? taskMap[currentTask.id].notes : (currentTask.notes || ''));
      }
      document.getElementById('btnSaveAiInstructions').disabled = false;
      var titleEl = document.getElementById('ctTitleClickable');
      if (titleEl) {
        titleEl.onclick = function () { editCurrentTask(); };
      }
    }

    async function editCurrentTask() {
      if (!currentTask) return;
      var res = await showEditModal(currentTask);
      if (res) {
        await doCrud('update', currentTask.id, { title: res.title, notes: res.note });
        currentTask.title = res.title;
        currentTask.notes = res.note;
        await renderAll();
        showSnack('Task renamed', 'SUCCESS');
      }
    }

    async function saveAiInstructions() {
      if (!currentTask) return;
      var instructions = document.getElementById('aiInstructions').value.trim();
      var task = taskMap[currentTask.id] || currentTask;
      var newNotes = setAiInstructionsInNotes(task.notes || '', instructions);
      await doCrud('update', currentTask.id, { notes: newNotes });
      await renderAll();
      showSnack('AI instructions saved', 'SUCCESS');
    }

    function renderChecklistHtml(task) {
      var items = parseChecklist(task.notes || '');
      if (!items.length) return '';
      var html = '<div class="clist">';
      items.forEach(function (it, i) {
        html += '<div class="cl-row' + (it.done ? ' done' : '') + '" data-id="' + task.id + '" data-clidx="' + i + '">' +
          '<span class="cl-box" data-act="cl-toggle" title="Toggle done">' + (it.done ? '☑' : '☐') + '</span>' +
          '<span class="cl-text">' + escapeHtml(it.text) + '</span>' +
          '<span class="cl-actions">' +
            '<button class="act" data-act="cl-regen" title="Rewrite this item with AI">↻</button>' +
            '<button class="act" data-act="cl-edit" title="Edit item">✎</button>' +
            '<button class="act" data-act="cl-del" title="Remove item">🗑</button>' +
          '</span>' +
        '</div>';
      });
      html += '</div>';
      return html;
    }

    function renderNode(task, depth, isGrand) {
      var canBreak = depth <= 1;
      var canAddSubtask = depth === 0;
      var cls = isGrand ? 'node grand' : 'node';
      var bullet = isGrand ? '☐' : '•';
      var actions = '';
      if (canBreak) actions += '<button class="act" data-act="break" title="Break down with AI">🤖</button>';
      if (depth === 1) actions += '<button class="act" data-act="rewrite" title="Rewrite this step with AI">↻</button>';
      actions += '<button class="act" data-act="edit" title="Edit">✎</button>';
      actions += '<button class="act" data-act="delete" title="Delete">🗑</button>';
      if (canAddSubtask) actions += '<button class="act" data-act="add" title="Add subtask">➕</button>';
      return '<div class="' + cls + '" data-id="' + task.id + '">' +
        '<div class="node-main">' +
          '<span class="node-bullet">' + bullet + '</span>' +
          '<div class="node-text">' +
            '<div class="node-title">' + escapeHtml(task.title) + '</div>' +
            (task.notes ? '<div class="node-note">' + escapeHtml(task.notes) + '</div>' : '') +
          '</div>' +
          '<div class="node-actions">' + actions + '</div>' +
        '</div>' +
        renderChecklistHtml(task) +
      '</div>';
    }

    function renderTree() {
      var tree = document.getElementById('tree');
      var regenBtn = document.getElementById('btnRegenerateAll');
      if (!currentTask) {
        tree.innerHTML = '<div class="empty-state">Select a task to see its breakdown.</div>';
        regenBtn.style.display = 'none';
        return;
      }
      var children = getChildren(currentTask.id);
      regenBtn.style.display = children.length ? '' : 'none';
      var leafOnly = document.getElementById('chkLeafOnly').checked;
      if (children.length === 0) {
        // No subtasks — still show the current task's own checklist/note if present.
        var ownCl = renderChecklistHtml(taskMap[currentTask.id] || currentTask);
        var ownEmpty = '<div class="empty-state">No subtasks yet. Click "🤖 Break down" to let AI create them.</div>';
        tree.innerHTML = ownCl ? '<div class="node root"><div class="node-main">' +
          '<span class="node-bullet">•</span>' +
          '<div class="node-text"><div class="node-title">' + escapeHtml((taskMap[currentTask.id] || currentTask).title) + '</div></div>' +
          '</div>' + ownCl + '</div>' : ownEmpty;
        return;
      }
      var html = '';
      children.forEach(function (child) {
        var depth = computeDepthOf(child.id);
        var grand = getChildren(child.id);
        if (!(leafOnly && grand.length > 0)) {
          html += renderNode(child, depth, false);
        }
        // Grandchildren are always leaves (depth 2 is max), so they stay visible
        // even when their parent is hidden by the "no subtasks" filter.
        grand.forEach(function (g) {
          html += renderNode(g, 2, true);
        });
      });
      tree.innerHTML = html;
    }

    async function renderAll() {
      await buildTaskMap();
      renderCurrentTask();
      renderTree();
    }

    // ==================== CRUD (via host) ====================
    async function doCrud(action, idOrData, changes) {
      var msg = { type: 'magic-task-crud', action: action };
      if (action === 'add') msg.data = idOrData;
      else if (action === 'update') { msg.id = idOrData; msg.changes = changes; }
      else if (action === 'delete') msg.id = idOrData;
      var res = await postToHost(msg);
      if (!res || !res.ok) {
        showSnack('Operation failed: ' + (res && res.error ? res.error : 'no reply'), 'ERROR');
        return false;
      }
      return true;
    }

    // ==================== AI CALL ====================
    async function callOpenAI(systemPrompt, userPrompt) {
      if (!config || !config.baseUrl) {
        throw new Error('Configure the AI endpoint first (⚙️ Settings)');
      }
      var resp = await postToHost({
        type: 'magic-ai-request',
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        model: config.model || 'gpt-4o',
        maxTokens: config.maxTokens || '2048',
        temperature: config.temperature
      });
      if (!resp || resp.error) {
        throw new Error(resp && resp.error ? resp.error : 'AI request failed');
      }
      return resp.content || '';
    }

    // Parse AI response into [{title, note}]. Robust: strip fences, find first [...] block.
    function parseSubtasks(raw) {
      var text = String(raw || '').trim();
      text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
      var start = text.indexOf('[');
      var end = text.lastIndexOf(']');
      if (start === -1 || end === -1 || end <= start) {
        throw new Error('No JSON array in AI response: ' + text.slice(0, 200));
      }
      var arr;
      try {
        arr = JSON.parse(text.substring(start, end + 1));
      } catch (e) {
        throw new Error('AI response is not valid JSON: ' + text.slice(0, 200));
      }
      if (!Array.isArray(arr)) throw new Error('AI response is not an array');
      return arr.map(function (item) {
        return {
          title: String(item.title || '').trim(),
          note: String(item.note || '').trim()
        };
      }).filter(function (item) { return item.title; });
    }

    // ==================== OVERLAYS ====================
    function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
    function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }

    function showConfirm(title, msg) {
      return new Promise(function (resolve) {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMsg').textContent = msg;
        showOverlay('confirmOverlay');
        var ok = document.getElementById('btnConfirmOk');
        var cancel = document.getElementById('btnConfirmCancel');
        var done = function (val) {
          hideOverlay('confirmOverlay');
          ok.onclick = null;
          cancel.onclick = null;
          resolve(val);
        };
        ok.onclick = function () { done(true); };
        cancel.onclick = function () { done(false); };
      });
    }

    function showChoice(msg) {
      return new Promise(function (resolve) {
        document.getElementById('choiceMsg').textContent = msg;
        showOverlay('choiceOverlay');
        var regen = document.getElementById('btnChoiceRegen');
        var edit = document.getElementById('btnChoiceEdit');
        var cancel = document.getElementById('btnChoiceCancel');
        var done = function (val) {
          hideOverlay('choiceOverlay');
          regen.onclick = null;
          edit.onclick = null;
          cancel.onclick = null;
          resolve(val);
        };
        regen.onclick = function () { done('regenerate'); };
        edit.onclick = function () { done('edit'); };
        cancel.onclick = function () { done('cancel'); };
      });
    }

    // ==================== PREVIEW MODAL ====================
    // Shows ASCII tree + editable rows. Resolves with array of {title,note} or null.
    function showPreview(task, subtasks, isRewrite, noteDefaultChecked, showIncludeNote, includeNoteChecked, showKeepSubtasks, keepSubtasksChecked) {
      return new Promise(function (resolve) {
        var list = subtasks.map(function (s) { return { title: s.title, note: s.note }; });
        var asciiEl = document.getElementById('previewAscii');
        var rowsEl = document.getElementById('previewRows');
        var statusEl = document.getElementById('previewStatus');
        var createBtn = document.getElementById('btnPreviewCreate');
        var titleEl = document.getElementById('previewTitle');
        var noteField = document.getElementById('previewNoteField');
        var noteChk = document.getElementById('chkStoreNote');
        var includeField = document.getElementById('previewIncludeField');
        var includeChk = document.getElementById('chkIncludeNote');
        var keepField = document.getElementById('previewKeepSubtasksField');
        var keepChk = document.getElementById('chkKeepSubtasks');

        titleEl.textContent = isRewrite ? 'Rewrite step' : 'Preview breakdown';
        statusEl.innerHTML = '';
        if (noteField) noteField.style.display = isRewrite ? 'none' : '';
        if (noteChk) noteChk.checked = !!noteDefaultChecked;
        if (includeField) includeField.style.display = showIncludeNote ? '' : 'none';
        if (includeChk) includeChk.checked = !!includeNoteChecked;
        if (keepField) keepField.style.display = showKeepSubtasks ? '' : 'none';
        if (keepChk) keepChk.checked = !!keepSubtasksChecked;

        function renderAscii() {
          var lines = [];
          var taskLabel = task.title || 'Task';
          lines.push('┌─ ' + taskLabel);
          list.forEach(function (s, i) {
            var last = i === list.length - 1;
            var prefix = last ? '└─ ' : '├─ ';
            var label = (i + 1) + '. ' + (s.title || '(untitled)');
            if (s.note) label += ' — ' + s.note;
            lines.push(prefix + label);
          });
          asciiEl.textContent = lines.join('\n');
        }

        function renderRows() {
          var html = '';
          list.forEach(function (s, i) {
            html += '<div class="preview-row" data-idx="' + i + '">' +
              '<input class="pv-title" value="' + escapeHtml(s.title) + '" placeholder="Title" />' +
              '<input class="pv-note" value="' + escapeHtml(s.note) + '" placeholder="Note (optional)" />' +
              '<button class="pv-remove" title="Remove">✕</button>' +
            '</div>';
          });
          rowsEl.innerHTML = html;
          createBtn.textContent = isRewrite ? 'Save step' : 'Create ' + list.length + ' subtask' + (list.length === 1 ? '' : 's');
        }

        function syncFromDom() {
          var rows = rowsEl.querySelectorAll('.preview-row');
          var newList = [];
          rows.forEach(function (row) {
            newList.push({
              title: row.querySelector('.pv-title').value.trim(),
              note: row.querySelector('.pv-note').value.trim()
            });
          });
          list = newList;
        }

        function rerender() {
          renderAscii();
          renderRows();
        }

        renderAscii();
        renderRows();
        showOverlay('previewOverlay');

        var onRowsInput = function () {
          syncFromDom();
          renderAscii();
        };

        var onRowsClick = function (e) {
          if (e.target.classList.contains('pv-remove')) {
            var row = e.target.closest('.preview-row');
            if (row) {
              syncFromDom();
              var idx = parseInt(row.getAttribute('data-idx'), 10);
              list.splice(idx, 1);
              rerender();
            }
          }
        };

        rowsEl.addEventListener('input', onRowsInput);
        rowsEl.addEventListener('click', onRowsClick);

        var addBtn = document.getElementById('btnAddStep');
        var cancelBtn = document.getElementById('btnPreviewCancel');
        var done = function (val) {
          hideOverlay('previewOverlay');
          rowsEl.removeEventListener('input', onRowsInput);
          rowsEl.removeEventListener('click', onRowsClick);
          addBtn.onclick = null;
          cancelBtn.onclick = null;
          createBtn.onclick = null;
          resolve(val);
        };

        addBtn.onclick = function () {
          syncFromDom();
          list.push({ title: '', note: '' });
          rerender();
        };

        cancelBtn.onclick = function () { done(null); };

        createBtn.onclick = function () {
          syncFromDom();
          var valid = list.filter(function (s) { return s.title; });
          if (valid.length === 0) {
            showSnack('Add at least one subtask title', 'WARNING');
            return;
          }
          done({ items: valid, storeInNote: isRewrite ? false : !!noteChk.checked, includeNote: !!includeChk?.checked, keepSubtasks: !!keepChk?.checked });
        };
      });
    }

    // ==================== BREAKDOWN FLOW ====================
    function buildSystemPrompt(depth) {
      if (depth >= 1) {
        return 'You are a task decomposition assistant. Break this sub-step into a small checklist of 2-5 concrete micro-steps. Respond with ONLY a JSON array (no markdown, no code fences) of objects with keys "title" (short action-oriented, at most 8 words) and "note" (one short sentence, at most 20 words). Be specific and executable.';
      }
      return 'You are a task decomposition assistant. Break the given task into 3-8 concrete, actionable subtasks. Respond with ONLY a JSON array (no markdown, no code fences) of objects with keys "title" (short action-oriented, at most 8 words) and "note" (one short sentence, at most 20 words). Be specific and executable.';
    }

    // Extra per-task guidance stored in notes marker, appended to every AI prompt.
    function getPromptInstructions(task) {
      var t = taskMap[task.id] || task;
      var instr = getAiInstructions(t.notes || '');
      return instr ? '\n\nAdditional user instructions for this breakdown:\n' + instr : '';
    }

    // Ensure the module-level config is populated from storage before use.
    // The saved config may exist even if init()'s async load or the host's
    // magic-init message did not reach us, which previously caused the settings
    // panel to open on every breakdown despite settings being saved.
    async function ensureConfig() {
      if (config && config.baseUrl) return config;
      try {
        if (typeof PluginAPI?.loadSyncedData === 'function') {
          const saved = await PluginAPI.loadSyncedData('magicTodoConfig');
          if (saved) {
            config = JSON.parse(saved);
          }
        }
      } catch (e) {
        console.warn('[MagicToDo] lazy config load failed', e);
      }
      return config;
    }

    async function runBreakdown(task, mode) {
      // mode: 'create' | 'regenerate' | 'rewrite'
      try {
        await ensureConfig();
        if (!config || !config.baseUrl) {
          showSnack('Configure the AI endpoint first (⚙️ Settings)', 'WARNING');
          openSettings();
          return;
        }
        var depth = task.depth !== undefined ? task.depth : computeDepthOf(task.id);
        if (depth >= 2) {
          showSnack('This is a sub-subtask — max depth reached (3 levels).', 'WARNING');
          return;
        }

        // Hierarchy check: subtasks can only get a checklist; main tasks can
        // get subtasks or a checklist.
        // Main tasks default to subtasks; subtasks stay checklist-only.
        var kind = 'subtasks';
        if (mode === 'rewrite') {
          // single-step rewrite, unaffected by hierarchy choice
        } else if (depth === 1) {
          kind = 'checklist'; // subtask → checklist only
        }

        var children = getChildren(task.id);

        if (mode === 'create' && kind === 'subtasks' && children.length > 0) {
          var choice = await showChoice('This task already has ' + children.length + ' subtask(s). What do you want to do?');
          if (choice === 'cancel') return;
          if (choice === 'edit') {
            renderTree();
            return;
          }
        }

        if (mode === 'rewrite') {
          var sysR = 'Rewrite this single step to be clearer and more actionable. Respond with ONLY a JSON array containing exactly one object with keys "title" (short action-oriented, at most 8 words) and "note" (one short sentence, at most 20 words).';
          var userR = 'Step: ' + task.title + (task.notes ? '\nNote: ' + stripMetadataForAI(task.notes) : '') + getPromptInstructions(task);
          var rawR = await callOpenAI(sysR, userR);
          var parsedR = parseSubtasks(rawR);
          if (parsedR.length === 0) throw new Error('AI returned no steps');
          var confirmedR = await showPreview(task, parsedR, true, false, !!(task.notes && task.notes.trim()), !!(task.notes && task.notes.trim()), false, false);
          if (!confirmedR) return;
          var upd = { title: confirmedR.items[0].title, notes: confirmedR.includeNote ? (task.notes || confirmedR.items[0].note) : confirmedR.items[0].note };
          await doCrud('update', task.id, upd);
          showSnack('Step rewritten', 'SUCCESS');
          await renderAll();
          return;
        }

        // create / regenerate — prompt depends on what we're adding
        var sys = kind === 'checklist' ? buildSystemPrompt(1) : buildSystemPrompt(0);
        var user = 'Task: ' + task.title + (task.notes ? '\nNotes: ' + stripMetadataForAI(task.notes) : '') +
          (kind === 'checklist' ? '\n\nBreak it down into a checklist of micro-steps.' : '\n\nBreak it down into subtasks.') +
          getPromptInstructions(task);
        var statusEl = document.getElementById('previewStatus');
        statusEl.innerHTML = '<span class="spinner"></span>Asking AI…';
        showOverlay('previewOverlay');
        document.getElementById('previewTitle').textContent = 'Preview breakdown';
        document.getElementById('previewAscii').textContent = '';
        document.getElementById('previewRows').innerHTML = '';

        var raw;
        try {
          raw = await callOpenAI(sys, user);
        } catch (e) {
          hideOverlay('previewOverlay');
          showSnack('AI call failed: ' + e.message, 'ERROR');
          return;
        }

        var parsed;
        try {
          parsed = parseSubtasks(raw);
        } catch (e) {
          hideOverlay('previewOverlay');
          showSnack('Parse failed: ' + e.message, 'ERROR');
          return;
        }
        if (parsed.length === 0) {
          hideOverlay('previewOverlay');
          showSnack('AI returned no items', 'WARNING');
          return;
        }

        // Preview always offers the "store as checklist in note" checkbox.
        var hasExistingChildren = children.length > 0;
        var confirmed = await showPreview(task, parsed, false, kind === 'checklist', !!(task.notes && task.notes.trim()), !!(task.notes && task.notes.trim()), hasExistingChildren, false);
        if (!confirmed) return;

        if (confirmed.storeInNote) {
          // Append checklist to the task note after the last checklist line if present.
          var fullTask = taskMap[task.id] || task;
          var newNotes = setChecklistInNote(fullTask.notes || '', confirmed.items);
          await doCrud('update', task.id, { notes: newNotes });
          showSnack('Checklist added to "' + task.title + '"', 'SUCCESS');
        } else {
          if (!confirmed.keepSubtasks) {
            for (var i = 0; i < children.length; i++) {
              await doCrud('delete', children[i].id);
            }
            await buildTaskMap();
          }
          var addedIds = [];
          for (var j = 0; j < confirmed.items.length; j++) {
            var addRes = await doCrud('add', {
              title: confirmed.items[j].title,
              notes: confirmed.items[j].note,
              parentId: task.id,
              projectId: task.projectId || null
            });
            if (addRes && addRes.id) {
              taskMap[addRes.id] = {
                id: addRes.id,
                title: confirmed.items[j].title,
                notes: confirmed.items[j].note,
                parentId: task.id,
                projectId: task.projectId || null
              };
              addedIds.push(addRes.id);
            }
          }
          showSnack('Created ' + addedIds.length + ' subtask(s)', 'SUCCESS');
          if (addedIds.length) {
            renderCurrentTask();
            renderTree();
          }
        }
        await renderAll();
      } catch (e) {
        hideOverlay('previewOverlay');
        showSnack('Breakdown failed: ' + e.message, 'ERROR');
      }
    }

    // ==================== EDIT MODAL ====================
    function showEditModal(task) {
      return new Promise(function (resolve) {
        document.getElementById('editTitle').textContent = task ? 'Edit task' : 'Add subtask';
        document.getElementById('editTitleInput').value = task ? task.title : '';
        document.getElementById('editNoteInput').value = task ? (task.notes || '') : '';
        showOverlay('editOverlay');
        var save = document.getElementById('btnEditSave');
        var cancel = document.getElementById('btnEditCancel');
        var done = function (val) {
          hideOverlay('editOverlay');
          save.onclick = null;
          cancel.onclick = null;
          resolve(val);
        };
        save.onclick = function () {
          var title = document.getElementById('editTitleInput').value.trim();
          var note = document.getElementById('editNoteInput').value.trim();
          if (!title) {
            showSnack('Title is required', 'WARNING');
            return;
          }
          done({ title: title, note: note });
        };
        cancel.onclick = function () { done(null); };
      });
    }

    // ==================== SETTINGS ====================
    async function openSettings() {
      var cfg = null;
      try {
        if (typeof PluginAPI?.loadSyncedData === 'function') {
          const saved = await PluginAPI.loadSyncedData('magicTodoConfig');
          if (saved) cfg = JSON.parse(saved);
        }
      } catch (e) {
        console.warn('[MagicToDo] iframe PluginAPI load failed', e);
      }
      if (!cfg) {
        cfg = config;
      }
      document.getElementById('cfgBaseUrl').value = (cfg && cfg.baseUrl) || 'http://localhost:8080/v1';
      document.getElementById('cfgApiKey').value = (cfg && cfg.apiKey) || '';
      document.getElementById('cfgModel').value = (cfg && cfg.model) || 'gpt-4o';
      document.getElementById('cfgMaxTokens').value = (cfg && cfg.maxTokens) || 2048;
      document.getElementById('cfgTemperature').value = (cfg && cfg.temperature !== undefined) ? cfg.temperature : 0.7;
      showOverlay('settingsOverlay');
    }

    function closeSettings() {
      hideOverlay('settingsOverlay');
    }

    async function saveSettings() {
      var cfg = {
        baseUrl: document.getElementById('cfgBaseUrl').value.trim() || 'http://localhost:8080/v1',
        apiKey: document.getElementById('cfgApiKey').value.trim(),
        model: document.getElementById('cfgModel').value.trim() || 'gpt-4o',
        maxTokens: parseInt(document.getElementById('cfgMaxTokens').value, 10) || 2048,
        temperature: parseFloat(document.getElementById('cfgTemperature').value)
      };
      var saved = false;
      try {
        if (typeof PluginAPI?.persistDataSynced === 'function') {
          await PluginAPI.persistDataSynced(JSON.stringify(cfg), 'magicTodoConfig');
          saved = true;
        }
      } catch (e) {
        console.warn('[MagicToDo] iframe PluginAPI save failed', e);
      }
      if (!saved) {
        try {
          localStorage.setItem('magicTodoConfig', JSON.stringify(cfg));
        } catch (e) {
          console.warn('[MagicToDo] iframe localStorage save failed', e);
        }
      }
      config = cfg;

      try {
        const hostResult = await postToHost({ type: 'magic-save-config', config: cfg });
        if (hostResult && hostResult.error) {
          throw new Error(hostResult.error);
        }
      } catch (e) {
        console.warn('[MagicToDo] host config refresh failed', e);
      }

      showSnack('Settings saved', 'SUCCESS');
      closeSettings();
    }

    async function testConnection() {
      try {
        var baseUrl = (document.getElementById('cfgBaseUrl').value.trim() || 'http://localhost:8080/v1').replace(/\/+$/, '');
        var apiKey = document.getElementById('cfgApiKey').value.trim();
        var headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
        var resp = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            model: document.getElementById('cfgModel').value.trim() || 'gpt-4o',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1
          })
        });
        if (!resp.ok) {
          var t = '';
          try { t = await resp.text(); } catch (e) {}
          throw new Error('API ' + resp.status + ': ' + t.slice(0, 200));
        }
        showSnack('Connection OK', 'SUCCESS');
      } catch (e) {
        showSnack('Connection failed: ' + e.message, 'ERROR');
      }
    }

    // ==================== EVENT WIRING ====================
    document.getElementById('btnSettings').addEventListener('click', openSettings);
    document.getElementById('btnSettingsSave').addEventListener('click', saveSettings);
    document.getElementById('btnSettingsCancel').addEventListener('click', closeSettings);
    document.getElementById('btnTestConn').addEventListener('click', testConnection);

    document.getElementById('btnBreakDown').addEventListener('click', function () {
      if (currentTask) runBreakdown(currentTask, 'create');
    });

    document.getElementById('btnChangeTask').addEventListener('click', async function () {
      var res = await postToHost({ type: 'magic-open-task-picker' });
      if (res && res.task && res.task.id) {
        currentTask = {
          id: res.task.id,
          title: res.task.title,
          notes: res.task.notes || '',
          projectId: res.task.projectId || null,
          depth: res.task.depth !== undefined ? res.task.depth : 0
        };
        await renderAll();
      } else {
      }
    });

    document.getElementById('btnEditTask').addEventListener('click', editCurrentTask);
    document.getElementById('btnSaveAiInstructions').addEventListener('click', saveAiInstructions);

    document.getElementById('btnRegenerateAll').addEventListener('click', function () {
      if (currentTask) runBreakdown(currentTask, 'regenerate');
    });

    document.getElementById('chkLeafOnly').addEventListener('change', function () {
      renderTree();
    });

    document.getElementById('tree').addEventListener('click', async function (e) {
      // Checklist item actions (toggle / regen / edit / remove single item)
      var clRow = e.target.closest('.cl-row');
      if (clRow) {
        var clTask = taskMap[clRow.getAttribute('data-id')];
        var clIdx = parseInt(clRow.getAttribute('data-clidx'), 10);
        var clActEl = e.target.closest('[data-act]');
        var clAct = clActEl ? clActEl.getAttribute('data-act') : null;
        if (clTask && clAct) {
          var clItems = parseChecklist(clTask.notes || '');
          var clItem = clItems[clIdx];
          if (!clItem) return;
          if (clAct === 'cl-toggle') {
            var toggled = replaceChecklistLine(clTask.notes || '', clIdx, clItem.text, !clItem.done);
            await doCrud('update', clTask.id, { notes: toggled });
            await renderAll();
            return;
          }
          if (clAct === 'cl-del') {
            var okDel = await showConfirm('Remove item', 'Remove "' + clItem.text + '"?');
            if (okDel) {
              var without = removeChecklistLine(clTask.notes || '', clIdx);
              await doCrud('update', clTask.id, { notes: without });
              await renderAll();
            }
            return;
          }
          if (clAct === 'cl-edit') {
            var resCl = await showEditModal({ title: clItem.text, notes: '' });
            if (resCl && resCl.title) {
              var edited = replaceChecklistLine(clTask.notes || '', clIdx, resCl.title, clItem.done);
              await doCrud('update', clTask.id, { notes: edited });
              await renderAll();
            }
            return;
          }
          if (clAct === 'cl-regen') {
            var sysCl = 'Rewrite this single checklist item to be clearer and more actionable. Respond with ONLY a JSON array containing exactly one object with key "title" (short action-oriented, at most 8 words).';
            var userCl = 'Checklist item: ' + clItem.text + getPromptInstructions(clTask);
            var rawCl;
            try {
              rawCl = await callOpenAI(sysCl, userCl);
            } catch (err) {
              showSnack('AI call failed: ' + err.message, 'ERROR');
              return;
            }
            var parsedCl;
            try {
              parsedCl = parseSubtasks(rawCl);
            } catch (err) {
              showSnack('Parse failed: ' + err.message, 'ERROR');
              return;
            }
            if (parsedCl.length === 0 || !parsedCl[0].title) {
              showSnack('AI returned no item', 'WARNING');
              return;
            }
            var regenerated = replaceChecklistLine(clTask.notes || '', clIdx, parsedCl[0].title, clItem.done);
            await doCrud('update', clTask.id, { notes: regenerated });
            await renderAll();
            showSnack('Checklist item rewritten', 'SUCCESS');
            return;
          }
        }
      }

      var btn = e.target.closest('.act');
      if (!btn) return;
      var node = btn.closest('.node');
      if (!node) return;
      var id = node.getAttribute('data-id');
      var task = taskMap[id];
      if (!task) return;
      var act = btn.getAttribute('data-act');
      var depth = computeDepthOf(id);

      if (act === 'break') {
        await runBreakdown({ id: task.id, title: task.title, notes: task.notes || '', projectId: task.projectId || null, depth: depth }, 'create');
      } else if (act === 'rewrite') {
        await runBreakdown({ id: task.id, title: task.title, notes: task.notes || '', projectId: task.projectId || null, depth: depth }, 'rewrite');
      } else if (act === 'edit') {
        var res = await showEditModal(task);
        if (res) {
          await doCrud('update', task.id, { title: res.title, notes: res.note });
          await renderAll();
        }
      } else if (act === 'delete') {
        var ok = await showConfirm('Delete', 'Delete "' + task.title + '"?');
        if (ok) {
          await doCrud('delete', task.id);
          await renderAll();
        }
      } else if (act === 'add') {
        var res2 = await showEditModal(null);
        if (res2) {
          await doCrud('add', {
            title: res2.title,
            notes: res2.note,
            parentId: task.id,
            projectId: task.projectId || null
          });
          await renderAll();
        }
      }
    });

    // ==================== HOST MESSAGES ====================
    window.addEventListener('message', async function (event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'magic-init') {
        if (data.config) {
          config = data.config;
        }
        if (data.currentTaskId) {
          currentTask = { id: data.currentTaskId };
        }
        await renderAll();
        return;
      }

      if (data.type === 'magic-current-task-changed') {
        if (data.taskId) {
          currentTask = { id: data.taskId };
        } else {
          currentTask = null;
        }
        await renderAll();
        return;
      }

      if (data.type === 'magic-task-picked') {
        if (data && data.task && data.task.id) {
          currentTask = {
            id: data.task.id,
            title: data.task.title,
            notes: data.task.notes || '',
            projectId: data.task.projectId || null,
            depth: data.task.depth !== undefined ? data.task.depth : 0
          };
          await renderAll();
        } else {
        }
        return;
      }

      if (data.type === 'magic-task-updated') {
        await renderAll();
        return;
      }

      if (data.type === 'magic-breakdown-request') {
        currentTask = {
          id: data.taskId,
          title: data.title,
          notes: data.notes || '',
          projectId: data.projectId || null,
          depth: data.depth !== undefined ? data.depth : 0
        };
        await renderAll();
        runBreakdown(currentTask, 'create');
        return;
      }

      if (data.type === 'magic-request-panel') {
        // Panel is already visible if this iframe is loaded; nothing else to do.
        return;
      }
    });

    // ==================== BOOTSTRAP ====================
    async function init() {
      try {
        // Load config directly from PluginAPI first, like sp-autoplan-plugin.
        try {
          if (typeof PluginAPI !== 'undefined' && typeof PluginAPI?.loadSyncedData === 'function') {
            const saved = await PluginAPI.loadSyncedData('magicTodoConfig');
            if (saved) {
              config = JSON.parse(saved);
            }
          }
        } catch (e) {
          console.warn('[MagicToDo] init PluginAPI load failed', e);
        }

        window.parent.postMessage({ type: 'magic-iframe-ready' }, '*');
        await renderAll();
      } catch (e) {
        console.error('[MagicToDo] init failed:', e);
      }
    }

    if (typeof PluginAPI !== 'undefined') {
      if (PluginAPI.onReady) {
        PluginAPI.onReady(init);
      } else {
        init();
      }
    } else {
      console.warn('[MagicToDo] PluginAPI not available at bootstrap, deferring init');
      setTimeout(function () {
        if (typeof PluginAPI !== 'undefined') {
          if (PluginAPI.onReady) {
            PluginAPI.onReady(init);
          } else {
            init();
          }
        } else {
          console.error('[MagicToDo] PluginAPI still not available after defer');
        }
      }, 50);
    }
