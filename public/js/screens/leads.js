/* Leads: lists (folders), CSV / paste import, on-demand email checker, stats bar, and the do-not-email list.
   Everything the server decides (valid / invalid, limits, who is suppressed) is only DISPLAYED here;
   the server stays the authority. All text goes through SB.h, so lead data can never become markup. */
(function () {
  'use strict';
  var h = SB.h, fmt = SB.fmt, ui = SB.ui, S = SB.S.leads;
  SB.screens = SB.screens || {};

  var EMAIL_RE = /[^\s,;<>"'()\[\]]+@[^\s,;<>"'()\[\]]+/g;   // same shape the server uses for pasted text
  var MAX_XLSX = 8 * 1024 * 1024;
  function toBase64(buf) {
    var bytes = new Uint8Array(buf), bin = '', i;
    for (i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  var MAX_FILE = 12 * 1000 * 1000;                            // the server accepts 12M characters per import
  var CHUNK = 500;                                            // the server checks at most 500 emails per request
  var selectedFolder = null;                                  // remembered while the app is open (no browser storage is used)
  var busy = false;                                           // only one email-checking run at a time

  // ---- small helpers ---------------------------------------------------------------------------
  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] !== null && o[k] !== undefined && o[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  function countEmails(text) { var m = String(text || '').match(EMAIL_RE); return m ? m.length : 0; }
  function field(label, input, hint, id) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint', text: hint }) : null);
  }
  function showErr(box, e) {
    var msg = SB.api.friendly(e);
    if (e && e.details && typeof e.details === 'object') { var parts = Object.keys(e.details).map(function (k) { return e.details[k]; }); if (parts.length) msg = parts.join(' · '); }
    box.textContent = msg; box.classList.remove('hidden');
  }
  function pill(map, key, fallback) {
    var m = map[key] || fallback;
    return h('span', { class: 'pill pill-' + m.cls, tip: m.tip || null }, m.label);
  }
  function setProgress(bar, pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    bar.firstChild.style.width = p + '%'; bar.setAttribute('aria-valuenow', String(Math.round(p)));
  }
  function widen(node) { var m = node.closest ? node.closest('.modal') : null; if (m) m.classList.add('wide'); }
  function pager(page, size, total, go) {
    var pages = Math.max(1, Math.ceil(total / size));
    var from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
    return h('div', { class: 'pager' },
      h('span', { class: 'small muted', text: 'Showing ' + fmt.num(from) + '–' + fmt.num(to) + ' of ' + fmt.num(total) }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, on: { click: function () { go(page - 1); } } }, 'Previous'),
        h('span', { class: 'small muted pager-n', text: 'Page ' + page + ' of ' + pages }),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= pages, on: { click: function () { go(page + 1); } } }, 'Next')));
  }

  // ---- list (folder) dialogs ---------------------------------------------------------------------
  function nameModal(o) {   // { title, value, label, confirmLabel, onSave(name) -> Promise }
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var input = h('input', { class: 'input', id: 'ln-name', maxlength: 80, value: o.value || '', placeholder: 'e.g. Domain buyers - US' });
    ui.modal({ title: o.title, body: h('div', null, err, field(o.label, input, 'Use a name you will recognise later: a niche, market or location.', 'ln-name')), actions: [
      { label: 'Cancel' },
      { label: o.confirmLabel, kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        if (!input.value.trim()) { err.textContent = 'Please enter a name.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
        return o.onSave(input.value).then(close, function (e) { showErr(err, e); throw e; });
      } }
    ] });
  }

  // ---- import ------------------------------------------------------------------------------------
  function importModal(folders, currentId, onDone) {
    var format = 'csv', fileKind = 'csv', fileText = '', fileName = '', createdId = null;
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var folderSel = h('select', { class: 'input', id: 'im-folder' });
    folders.forEach(function (f) { folderSel.appendChild(h('option', { value: String(f.id) }, f.name + ' (' + fmt.num(f.lead_count) + ')')); });
    folderSel.appendChild(h('option', { value: 'new' }, '＋ New list…'));
    folderSel.value = currentId && folders.some(function (f) { return f.id === currentId; }) ? String(currentId) : (folders.length ? String(folders[0].id) : 'new');
    var newName = h('input', { class: 'input', id: 'im-new', maxlength: 80, placeholder: 'Name of the new list' });
    var newBox = h('div', { class: 'hidden' }, field('New list name', newName, null, 'im-new'));
    function syncFolder() { newBox.classList.toggle('hidden', folderSel.value !== 'new'); }
    folderSel.addEventListener('change', syncFolder); syncFolder();

    var tabCsv = h('button', { class: 'seg active', type: 'button' }, 'Upload CSV or Excel file'), tabPaste = h('button', { class: 'seg', type: 'button' }, 'Paste emails');
    var picker = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'hidden', id: 'im-file' });
    var dropMsg = h('div', { class: 'drop-msg' }, h('b', { text: 'Drop a CSV or Excel (.xlsx) file here' }), h('div', { class: 'small muted', text: 'or click to choose one' }));
    var drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Choose a CSV or Excel file' }, SB.icon('upload', 'icon-lg'), dropMsg);
    var csvBox = h('div', null, drop, picker,
      h('div', { class: 'hint', text: 'Needs a column named "email". Optional columns: first name, last name, company. Any other columns are kept and can be used in your email text. Using Excel? Choose File → Save As → CSV first.' }));
    var paste = h('textarea', { class: 'input', id: 'im-paste', rows: 8, placeholder: 'alex@acme.com\njamie@globex.com, sam@initech.io' });
    var count = h('div', { class: 'small muted pad-b', text: '0 emails found' });
    var pasteField = field('Paste emails', paste, 'Any mix of commas, spaces and new lines works. Names and other text around the emails are ignored.', 'im-paste'); pasteField.classList.add('tight');
    var pasteBox = h('div', { class: 'hidden' }, pasteField, count);
    paste.addEventListener('input', function () { var n = countEmails(paste.value); count.textContent = fmt.num(n) + (n === 1 ? ' email found' : ' emails found'); });

    function setFormat(f) { format = f; tabCsv.classList.toggle('active', f === 'csv'); tabPaste.classList.toggle('active', f === 'paste'); csvBox.classList.toggle('hidden', f !== 'csv'); pasteBox.classList.toggle('hidden', f !== 'paste'); }
    tabCsv.addEventListener('click', function () { setFormat('csv'); }); tabPaste.addEventListener('click', function () { setFormat('paste'); });

    function takeFile(file) {
      err.classList.add('hidden');
      if (!file) return;
      var isX = /\.xlsx$/i.test(file.name);
      if (/\.(xls|xlsm|xlsb|ods)$/i.test(file.name)) { err.textContent = 'Only .xlsx and .csv files can be imported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV.'; err.classList.remove('hidden'); return; }
      if (isX && file.size > MAX_XLSX) { err.textContent = 'That Excel file is larger than 8 MB. Save it as CSV, or split it into smaller files.'; err.classList.remove('hidden'); return; }
      if (!isX && file.size > MAX_FILE) { err.textContent = 'That file is larger than 12 MB. Split it into smaller files and import them one by one.'; err.classList.remove('hidden'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        fileKind = isX ? 'xlsx' : 'csv'; fileText = isX ? toBase64(rd.result) : String(rd.result || ''); fileName = file.name;
        SB.clear(dropMsg); dropMsg.appendChild(h('b', { text: file.name })); dropMsg.appendChild(h('div', { class: 'small muted', text: (file.size / 1024 < 1000 ? Math.max(1, Math.round(file.size / 1024)) + ' KB' : (file.size / 1048576).toFixed(1) + ' MB') + ' · click to choose another' }));
      };
      rd.onerror = function () { err.textContent = 'Could not read that file.'; err.classList.remove('hidden'); };
      if (isX) rd.readAsArrayBuffer(file); else rd.readAsText(file);
    }
    drop.addEventListener('click', function () { picker.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    picker.addEventListener('change', function () { takeFile(picker.files && picker.files[0]); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });

    var body = h('div', { class: 'import-body' }, err, field('Add to list', folderSel, null, 'im-folder'), newBox, h('div', { class: 'segs' }, tabCsv, tabPaste), csvBox, pasteBox,
      h('div', { class: 'callout' }, 'Duplicates, badly written addresses and people on your do-not-email list are skipped automatically. Nothing is emailed by importing.'));
    ui.modal({ title: 'Import leads', body: body, actions: [
      { label: 'Cancel' },
      { label: 'Import', kind: 'primary', onClick: function (close) {
        err.classList.add('hidden');
        var data = format === 'csv' ? fileText : paste.value, sendFormat = format === 'csv' ? fileKind : format;
        if (format === 'csv' && !data) { err.textContent = 'Choose a CSV or Excel file first.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
        if (format === 'paste' && !countEmails(data)) { err.textContent = 'No email addresses found in the text you pasted.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
        var prep;
        if (folderSel.value === 'new') {
          if (!newName.value.trim()) { err.textContent = 'Please name the new list.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
          prep = createdId ? Promise.resolve(createdId) : SB.api.post('/api/folders', { name: newName.value }).then(function (r) { createdId = r.folder.id; return createdId; });
        } else prep = Promise.resolve(parseInt(folderSel.value, 10));
        return prep.then(function (folderId) {
          return SB.api.post('/api/folders/' + folderId + '/import', { format: sendFormat, data: data }).then(function (r) { close(); onDone(folderId); importResult(r.result, folderId); });
        }).catch(function (e) { showErr(err, e); throw e; });
      } }
    ] });
    widen(body);
  }

  function importResult(r, folderId) {
    function row(label, n, tip, cls) { return h('div', { class: 'res-row' + (cls ? ' ' + cls : ''), tip: tip }, h('b', { text: fmt.num(n) }), h('span', { text: label })); }
    var list = null;
    if (r.errors && r.errors.length) {
      var shown = r.errors.length, extra = (r.invalid + r.suppressed) - shown;
      list = h('div', null, h('h3', { class: 'sub-h', text: 'Rows that were skipped' }),
        h('div', { class: 'err-list' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Row' }), h('th', { text: 'Email' }), h('th', { text: 'Why' }))),
          h('tbody', null, r.errors.map(function (x) { return h('tr', null, h('td', { text: String(x.row) }), h('td', { class: 'break', text: x.email || '(empty)' }), h('td', { text: S.reason(x.reason) })); })))),
        extra > 0 ? h('div', { class: 'small muted', text: 'Showing the first ' + shown + '. ' + fmt.num(extra) + ' more were skipped for similar reasons.' }) : null);
    }
    var body = h('div', null,
      h('div', { class: 'res-grid' }, row('added', r.imported, 'New leads saved to the list.', 'good'), row('already in the list', r.duplicates, 'Repeated addresses are only added once.'),
        row('not valid addresses', r.invalid, 'Not written like an email address.', r.invalid ? 'warn' : ''), row('on your do-not-email list', r.suppressed, 'People who unsubscribed, bounced or that you blocked.')),
      h('p', { class: 'muted', text: r.imported ? 'Next, check the new emails so campaigns only target addresses that can receive mail.' : 'Nothing new was added.' }), list);
    var close = ui.modal({ title: 'Import finished', body: body, actions: [
      { label: 'Close' },
      r.imported ? { label: 'Check emails now', kind: 'primary', onClick: function (c) { c(); importResult.after(folderId); return Promise.resolve(); } } : null
    ].filter(Boolean) });
    widen(body); return close;
  }
  importResult.after = function () {};

  // ---- email checker ---------------------------------------------------------------------------
  function verifyFlow(ids, finished) {
    if (busy) { ui.toast('A check is already running.', true); return; }
    if (!ids.length) { ui.toast('There is nothing to check.'); return; }
    busy = true;
    var total = ids.length, i = 0, stopped = false, tries = 0, sum = { valid: 0, invalid: 0, risky: 0, retry_later: 0 };
    var bar = ui.progress(0), line = h('div', { class: 'small muted', text: 'Starting…' });
    var stopBtn = h('button', { class: 'btn', type: 'button' }, 'Stop'), actions = h('div', { class: 'modal-actions' }, stopBtn);
    var result = h('div');
    var close = ui.modal({ title: 'Checking ' + fmt.num(total) + (total === 1 ? ' email' : ' emails'), body: h('div', null, h('p', { class: 'muted', text: S.verifyNote }), bar, line, result, actions), actions: [] });
    function open() { return document.body.contains(bar); }
    stopBtn.addEventListener('click', function () { stopped = true; stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; });

    function end(problem) {
      busy = false;
      var checked = sum.valid + sum.invalid + sum.risky;
      line.textContent = problem ? '' : (stopped || !open() ? 'Stopped after ' + fmt.num(i) + ' of ' + fmt.num(total) + '.' : 'Finished.');
      setProgress(bar, total ? i / total * 100 : 100);
      SB.clear(result);
      if (problem) result.appendChild(h('div', { class: 'form-error', text: problem }));
      result.appendChild(h('div', { class: 'res-grid' },
        h('div', { class: 'res-row good' }, h('b', { text: fmt.num(sum.valid) }), h('span', { text: 'valid' })), h('div', { class: 'res-row warn' }, h('b', { text: fmt.num(sum.risky) }), h('span', { text: 'risky' })),
        h('div', { class: 'res-row bad' }, h('b', { text: fmt.num(sum.invalid) }), h('span', { text: 'invalid' })),
        h('div', { class: 'res-row', tip: 'A temporary network or DNS problem. These stay "not checked": run the check again later.' }, h('b', { text: fmt.num(sum.retry_later) }), h('span', { text: 'could not be checked' }))));
      if (checked && sum.invalid) result.appendChild(h('p', { class: 'small muted', text: 'Invalid addresses are skipped by campaigns automatically.' }));
      SB.clear(actions); actions.appendChild(h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { close(); } } }, 'Done'));
      finished();
    }
    function wait(sec) {
      return new Promise(function (resolve) {
        var left = sec;
        (function loop() {
          if (!open() || stopped) return resolve();
          line.textContent = 'Pausing for ' + left + 's to stay within the checking limit…';
          if (left <= 0) return resolve();
          left--; setTimeout(loop, 1000);
        })();
      });
    }
    function step() {
      if (stopped || !open() || i >= total) return end(null);
      var chunk = ids.slice(i, i + CHUNK);
      line.textContent = 'Checked ' + fmt.num(i) + ' of ' + fmt.num(total) + '…';
      return SB.api.post('/api/leads/verify', { ids: chunk }).then(function (r) {
        tries = 0; i += chunk.length;
        sum.valid += r.valid; sum.invalid += r.invalid; sum.risky += r.risky; sum.retry_later += r.retry_later;
        setProgress(bar, i / total * 100); return step();
      }, function (e) {
        if (e.status === 429 && tries < 10) { tries++; return wait(Math.min(120, e.retryAfter || 30)).then(step); }
        return end(SB.api.friendly(e));
      });
    }
    return step();
  }

  function checkModal(folderId, stats, selectedIds, onFinish) {
    var opts = [];
    if (stats.unverified > 0) opts.push({ key: 'unverified', label: 'Only emails not checked yet', n: stats.unverified });
    if (stats.total > 0) opts.push({ key: 'all', label: 'Every email in this list (checks them again)', n: stats.total });
    if (selectedIds.length) opts.push({ key: 'selected', label: 'Only the ' + fmt.num(selectedIds.length) + ' selected', n: selectedIds.length });
    if (!opts.length) { ui.toast('This list has no emails to check.'); return; }
    var chosen = selectedIds.length ? 'selected' : opts[0].key;
    var err = h('div', { class: 'form-error hidden', role: 'alert' });
    var radios = opts.map(function (o) {
      var r = h('input', { type: 'radio', name: 'scope', value: o.key, id: 'sc-' + o.key }); r.checked = o.key === chosen;
      r.addEventListener('change', function () { chosen = o.key; });
      return h('label', { class: 'radio-row', for: 'sc-' + o.key }, r, h('span', null, o.label, h('b', { class: 'muted', text: ' · ' + fmt.num(o.n) })));
    });
    ui.modal({ title: 'Check emails', body: h('div', null, err, h('p', { class: 'muted pad-b', text: S.verifyNote }), h('div', { class: 'radios' }, radios)), actions: [
      { label: 'Cancel' },
      { label: 'Start checking', kind: 'primary', onClick: function (close) {
        if (busy) { err.textContent = 'A check is already running.'; err.classList.remove('hidden'); return Promise.reject(new Error('busy')); }
        var get = chosen === 'selected' ? Promise.resolve({ ids: selectedIds }) : SB.api.get('/api/folders/' + folderId + '/lead-ids' + (chosen === 'unverified' ? '?status=unverified' : ''));
        return get.then(function (r) { close(); if (r.truncated) ui.toast('Only the first 50,000 emails are checked in one go. Run it again for the rest.'); verifyFlow(r.ids, onFinish); },
          function (e) { showErr(err, e); throw e; });
      } }
    ] });
  }

  // ---- lists tab -------------------------------------------------------------------------------
  function listsTab(box, shared) {
    var st = { folders: [], id: null, stats: null, rows: [], total: 0, page: 1, size: 50, q: '', status: 'all', sort: 'created_at', dir: 'desc', sel: {}, req: 0, f: { role: '', missing: '', in_campaign: '', domain: '' } };
    var foldersBox = h('div', { class: 'folder-list' }), main = h('div', { class: 'leads-main' });
    var headBox = h('div'), statsBox = h('div'), toolBox = h('div'), tableBox = h('div');
    main.appendChild(headBox); main.appendChild(statsBox); main.appendChild(toolBox); main.appendChild(tableBox);
    var newBtn = h('button', { class: 'btn btn-sm', type: 'button', on: { click: createFolder } }, SB.icon('plus'), 'New list');
    var side = h('div', { class: 'card folders-card' }, h('div', { class: 'folders-head' }, h('h2', { text: 'Lists' }), newBtn), foldersBox);
    SB.mount(box, h('div', { class: 'leads-layout' }, side, main));

    function current() { for (var i = 0; i < st.folders.length; i++) if (st.folders[i].id === st.id) return st.folders[i]; return null; }
    function selIds() { return Object.keys(st.sel).map(Number); }

    function createFolder() {
      nameModal({ title: 'New list', label: 'List name', confirmLabel: 'Create list', onSave: function (name) {
        return SB.api.post('/api/folders', { name: name }).then(function (r) { ui.toast('List created'); return loadFolders(r.folder.id); });
      } });
    }
    function openImport(folderId) {
      importModal(st.folders, folderId === undefined ? st.id : folderId, function (id) { loadFolders(id); });
    }
    importResult.after = function (folderId) {
      if (shared.destroyed) return;
      selectFolder(folderId).then(function () { if (st.stats && st.stats.unverified) checkModal(st.id, st.stats, [], afterCheck); });
    };
    shared.openImport = function () { openImport(); };

    function renderFolders() {
      SB.clear(foldersBox);
      if (!st.folders.length) { foldersBox.appendChild(h('div', { class: 'small muted pad', text: 'No lists yet.' })); return; }
      st.folders.forEach(function (f) {
        foldersBox.appendChild(h('button', { class: 'folder-item' + (f.id === st.id ? ' active' : ''), type: 'button', tip: fmt.num(f.valid_count) + ' of ' + fmt.num(f.lead_count) + ' are valid', on: { click: function () { if (f.id !== st.id) selectFolder(f.id); } } },
          SB.icon('folder'), h('span', { class: 'f-name', text: f.name }), h('span', { class: 'f-count', text: fmt.num(f.lead_count) })));
      });
    }

    function loadFolders(thenSelect) {
      return SB.api.get('/api/folders').then(function (r) {
        st.folders = r.items; renderFolders();
        var want = thenSelect || st.id || selectedFolder, ok = st.folders.some(function (f) { return f.id === want; });
        var id = ok ? want : (st.folders.length ? st.folders[0].id : null);
        if (id === null) { st.id = null; selectedFolder = null; renderEmpty(); return; }
        if (id !== st.id || thenSelect) return selectFolder(id);
        renderHead();      // the name may have changed (rename)
        return refresh();
      }, function (e) { if (e.code !== 'offline') SB.mount(box, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }

    function renderEmpty() {
      SB.clear(headBox); SB.clear(statsBox); SB.clear(toolBox);
      SB.mount(tableBox, h('div', { class: 'card empty' }, h('h2', { text: 'Create your first list' }),
        h('p', { text: 'A list is a folder of contacts, for example one niche, market or location. Import a CSV file or paste emails to fill it.' }),
        h('div', { class: 'actions center' }, h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { openImport(); } } }, SB.icon('upload'), 'Import leads'),
          h('button', { class: 'btn', type: 'button', on: { click: createFolder } }, SB.icon('plus'), 'Create empty list'))));
    }

    function selectFolder(id) {
      st.id = id; selectedFolder = id; st.page = 1; st.q = ''; st.status = 'all'; st.sort = 'created_at'; st.dir = 'desc'; st.sel = {}; st.f = { role: '', missing: '', in_campaign: '', domain: '' };
      renderFolders(); renderHead(); renderToolbar();
      return refresh();
    }

    function renderHead() {
      var f = current(); if (!f) return;
      var ren = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Rename this list', on: { click: function () {
        nameModal({ title: 'Rename list', label: 'List name', value: f.name, confirmLabel: 'Save', onSave: function (n) { return SB.api.patch('/api/folders/' + f.id, { name: n }).then(function () { ui.toast('Renamed'); return loadFolders(); }); } });
      } } }, SB.icon('edit'), 'Rename');
      var exp = h('a', { class: 'btn btn-ghost btn-sm', href: '/api/folders/' + f.id + '/export', download: 'leads.csv', tip: 'Download this list as a CSV file (opens in Excel).' }, SB.icon('download'), 'Export');
      var del = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', tip: 'Delete this list and everything in it', on: { click: function () {
        ui.confirm({ title: 'Delete "' + f.name + '"?', message: 'This permanently deletes the list and its ' + fmt.num(f.lead_count) + ' lead' + (f.lead_count === 1 ? '' : 's') + '. People already emailed are not affected. This cannot be undone.', confirmLabel: 'Delete list', danger: true,
          onConfirm: function () { return SB.api.del('/api/folders/' + f.id).then(function () { ui.toast('List deleted'); st.id = null; return loadFolders(); }); } });
      } } }, SB.icon('trash'), 'Delete');
      SB.mount(headBox, h('div', { class: 'list-head' }, h('div', { class: 'who' }, h('h2', { text: f.name }), h('div', { class: 'small muted', text: 'Created ' + fmt.ago(f.created_at) })), h('div', { class: 'actions' }, ren, exp, del)));
    }

    function renderStats() {
      var s = st.stats; if (!s) return;
      var risky = s.risky + s.catch_all, checked = s.total - s.unverified;
      // Tiles with a status act as one-click filters. ("Risky" filters 'risky' only: the checker never produces 'catch_all'.)
      function t(label, value, note, tip, status) {
        var el = ui.tile(label, value, note, null);
        el.setAttribute('data-tip', tip); el.setAttribute('tabindex', '0');      // the whole tile explains itself on hover / focus
        if (!status) return el;
        el.classList.add('clickable'); el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
        if (st.status === status) el.classList.add('selected');
        function go() { st.status = status; st.page = 1; st.sel = {}; if (st.statusSel) st.statusSel.value = status; loadLeads(); renderStats(); }
        el.addEventListener('click', go); el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        return el;
      }
      SB.mount(statsBox, h('div', { class: 'grid-tiles stats-bar' },
        t('Total leads', fmt.num(s.total), null, S.tips.total, 'all'),
        t('Valid rate', s.valid_rate === null ? '—' : fmt.pct(s.valid_rate), s.valid_rate === null ? 'Nothing checked yet' : fmt.num(checked) + ' checked', S.tips.rate, null),
        t('Valid', fmt.num(s.valid), null, S.tips.valid, 'valid'),
        t('Invalid', fmt.num(s.invalid), null, S.tips.invalid, 'invalid'),
        t('Risky', fmt.num(risky), null, S.tips.risky, 'risky'),
        t('Not checked', fmt.num(s.unverified), null, S.tips.unchecked, 'unverified')));
    }

    function renderToolbar() {
      var search = h('input', { class: 'input', type: 'search', placeholder: 'Search email, name or company', maxlength: 100, 'aria-label': 'Search leads' });
      search.value = st.q || ''; var timer = null;
      search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { st.q = search.value.trim(); st.page = 1; loadLeads(); }, 300); });
      var sel = h('select', { class: 'input', 'aria-label': 'Filter by status' },
        h('option', { value: 'all' }, 'All statuses'), h('option', { value: 'valid' }, 'Valid'), h('option', { value: 'invalid' }, 'Invalid'),
        h('option', { value: 'risky' }, 'Risky'), h('option', { value: 'catch_all' }, 'Catch-all'), h('option', { value: 'unverified' }, 'Not checked'));
      sel.value = st.status; st.statusSel = sel;
      sel.addEventListener('change', function () { st.status = sel.value; st.page = 1; st.sel = {}; loadLeads(); renderStats(); });
      var check = h('button', { class: 'btn btn-primary', type: 'button', tip: S.verifyNote, on: { click: function () { if (st.stats) checkModal(st.id, st.stats, selIds(), afterCheck); } } }, SB.icon('shield'), 'Check emails');
      var imp = h('button', { class: 'btn', type: 'button', on: { click: function () { openImport(); } } }, SB.icon('upload'), 'Import');
      function pickSel(label, key, opts) {
        var el = h('select', { class: 'input', 'aria-label': label }, opts.map(function (o) { return h('option', { value: o[0] }, o[1]); }));
        el.value = st.f[key]; el.addEventListener('change', function () { st.f[key] = el.value; st.page = 1; st.sel = {}; loadLeads(); renderFilterTags(); }); return el;
      }
      var SORT_OPTS = [['created_at|desc', 'Newest first'], ['created_at|asc', 'Oldest first'], ['email|asc', 'Email (A-Z)'], ['domain|asc', 'Domain (A-Z)'], ['company|asc', 'Company (A-Z)'], ['name|asc', 'Name (A-Z)'], ['verify_status|asc', 'Status'], ['verified_at|desc', 'Recently checked']];
      var sortSel = h('select', { class: 'input', 'aria-label': 'Sort by' }, SORT_OPTS.map(function (o) { return h('option', { value: o[0] }, o[1]); }));
      sortSel.value = st.sort + '|' + st.dir; if (sortSel.value !== st.sort + '|' + st.dir) sortSel.value = 'created_at|desc';
      sortSel.addEventListener('change', function () { var p = sortSel.value.split('|'); st.sort = p[0]; st.dir = p[1]; st.page = 1; loadLeads(); });
      st.sortSel = sortSel;
      var domain = h('input', { class: 'input', type: 'search', placeholder: 'Domain contains...', maxlength: 100, 'aria-label': 'Filter by domain' }); domain.value = st.f.domain;
      var dt = null; domain.addEventListener('input', function () { clearTimeout(dt); dt = setTimeout(function () { st.f.domain = domain.value.trim().replace(/^@/, ''); st.page = 1; loadLeads(); renderFilterTags(); }, 300); });
      st.domainEl = domain;
      var filters = h('div', { class: 'toolbar filter-row' },
        pickSel('Mailbox type', 'role', [['', 'All mailboxes'], ['exclude', 'Personal mailboxes only'], ['only', 'Shared mailboxes (info@, sales@)']]),
        pickSel('Missing information', 'missing', [['', 'Any details'], ['name', 'Missing first name'], ['company', 'Missing company'], ['any', 'Missing name or company']]),
        pickSel('Campaign usage', 'in_campaign', [['', 'In any campaign or not'], ['0', 'Not in a campaign'], ['1', 'In a campaign']]),
        domain, sortSel);
      st.bulkBox = h('div'); st.tagBox = h('div');
      SB.mount(toolBox, h('div', null, h('div', { class: 'toolbar' }, h('div', { class: 'search' }, SB.icon('search'), search), sel, h('div', { class: 'actions' }, imp, check)), filters, st.tagBox, st.bulkBox));
      renderFilterTags();
    }

    var FLABEL = { role: { exclude: 'Personal mailboxes', only: 'Shared mailboxes' }, missing: { name: 'Missing first name', company: 'Missing company', any: 'Missing name or company' }, in_campaign: { '0': 'Not in a campaign', '1': 'In a campaign' } };
    function activeFilters() {
      var out = [];
      ['role', 'missing', 'in_campaign'].forEach(function (k) { if (st.f && st.f[k]) out.push({ key: k, label: FLABEL[k][st.f[k]] }); });
      if (st.f && st.f.domain) out.push({ key: 'domain', label: 'Domain: ' + st.f.domain });
      return out;
    }
    function renderFilterTags() {
      if (!st.tagBox) return;
      var tags = activeFilters().map(function (f) { return { label: f.label, onRemove: function () { st.f[f.key] = ''; if (f.key === 'domain' && st.domainEl) st.domainEl.value = ''; renderToolbar(); st.page = 1; loadLeads(); } }; });
      SB.mount(st.tagBox, h('div', null, SB.lists.tags(tags, function () { st.f = { role: '', missing: '', in_campaign: '', domain: '' }; renderToolbar(); st.page = 1; loadLeads(); })));
    }
    function afterCheck() { if (shared.destroyed) return; st.sel = {}; refresh(); loadFoldersQuiet(); }
    function loadFoldersQuiet() { return SB.api.get('/api/folders').then(function (r) { st.folders = r.items; renderFolders(); }, function () {}); }

    function moveModal(ids) {
      var others = st.folders.filter(function (f) { return f.id !== st.id; });
      if (!others.length) { ui.toast('Create another list first (use the + next to Lists).', true); return; }
      var sel = h('select', { class: 'input', id: 'mvl-folder', 'aria-label': 'Destination list' }, others.map(function (f) { return h('option', { value: f.id }, f.name + ' (' + fmt.num(f.lead_count) + ')'); }));
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      ui.modal({ title: 'Move ' + fmt.num(ids.length) + ' lead' + (ids.length === 1 ? '' : 's'), body: h('div', null, err, h('div', { class: 'field' }, h('label', { for: 'mvl-folder' }, 'Move to'), sel)),
        actions: [{ label: 'Cancel' }, { label: 'Move', kind: 'primary', onClick: function (close) {
          return SB.api.post('/api/leads/move', { ids: ids, folder_id: Number(sel.value) }).then(function (r) {
            close(); ui.toast(fmt.num(r.moved) + ' moved' + (r.skipped ? '. ' + fmt.num(r.skipped) + ' skipped because the email is already in that list.' : ''));
            st.sel = {}; return refresh().then(loadFoldersQuiet);
          }, function (e) { err.textContent = SB.api.friendly(e); err.classList.remove('hidden'); throw e; });
        } }] });
    }

    function renderBulk() {
      var ids = selIds(); SB.clear(st.bulkBox); if (!ids.length) return;
      var emails = ids.map(function (id) { return st.sel[id]; });
      var sup = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Never email these people again, in any list or campaign.', on: { click: function () {
        ui.confirm({ title: 'Add ' + fmt.num(ids.length) + ' to the do-not-email list?', message: 'These people will never be emailed again by any campaign. You can remove them from the do-not-email list later.', confirmLabel: 'Add to do-not-email list',
          onConfirm: function () { return SB.api.post('/api/suppression', { emails: emails, reason: 'manual' }).then(function (r) { ui.toast(fmt.num(r.added) + ' added to the do-not-email list'); }); } });
      } } }, SB.icon('shield'), 'Do not email');
      var del = h('button', { class: 'btn btn-sm btn-danger', type: 'button', on: { click: function () {
        ui.confirm({ title: 'Delete ' + fmt.num(ids.length) + ' lead' + (ids.length === 1 ? '' : 's') + '?', message: 'They are removed from this list permanently. Leads that are waiting in a running or paused campaign cannot be deleted.', confirmLabel: 'Delete', danger: true,
          onConfirm: function () { return SB.api.post('/api/leads/delete', { ids: ids }).then(function (r) { ui.toast(fmt.num(r.deleted) + ' deleted'); st.sel = {}; return refresh().then(loadFoldersQuiet); }); } });
      } } }, SB.icon('trash'), 'Delete');
      var mv = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Move the selected people into another list. People already in that list are left where they are.', on: { click: function () { moveModal(ids); } } }, 'Move to list');
      st.bulkBox.appendChild(h('div', { class: 'bulk' }, h('b', { text: fmt.num(ids.length) + ' selected' }), h('div', { class: 'actions' }, mv, sup, del,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: function () { st.sel = {}; renderTable(); renderBulk(); } } }, 'Clear'))));
    }

    function sortTh(label, key) {
      var on = st.sort === key;
      return h('th', null, h('button', { class: 'th-sort' + (on ? ' on' : ''), type: 'button', on: { click: function () {
        if (on) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = key; st.dir = key === 'created_at' ? 'desc' : 'asc'; }
        st.page = 1; loadLeads(); if (st.sortSel) st.sortSel.value = st.sort + '|' + st.dir;
      } } }, label, on ? h('span', { text: st.dir === 'asc' ? ' ↑' : ' ↓' }) : null));
    }

    function renderTable() {
      var f = current();
      if (!st.rows.length) {
        var filtered = st.q || st.status !== 'all' || activeFilters().length;
        SB.mount(tableBox, filtered
          ? h('div', { class: 'card empty' }, h('h2', { text: 'No leads match' }), h('p', { text: 'Try a different search or status.' }))
          : h('div', { class: 'card empty' }, h('h2', { text: 'This list is empty' }), h('p', { text: 'Import a CSV file or paste emails to add people to "' + (f ? f.name : 'this list') + '".' }),
            h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { openImport(); } } }, SB.icon('upload'), 'Import leads')));
        return;
      }
      var all = h('input', { type: 'checkbox', 'aria-label': 'Select all on this page' });
      all.checked = st.rows.every(function (r) { return !!st.sel[r.id]; });
      all.addEventListener('change', function () { st.rows.forEach(function (r) { if (all.checked) st.sel[r.id] = r.email; else delete st.sel[r.id]; }); renderTable(); renderBulk(); });
      var body = st.rows.map(function (r) {
        var cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + r.email }); cb.checked = !!st.sel[r.id];
        cb.addEventListener('change', function () { if (cb.checked) st.sel[r.id] = r.email; else delete st.sel[r.id]; renderBulk(); all.checked = st.rows.every(function (x) { return !!st.sel[x.id]; }); });
        var name = [r.first_name, r.last_name].filter(Boolean).join(' ');
        var note = r.verify_error ? S.reason(r.verify_error) : '';
        return h('tr', null,
          h('td', { class: 'c-check' }, cb),
          h('td', { class: 'c-email', tip: 'Added ' + fmt.ago(r.created_at) + ' · ' + fmt.full(r.created_at) },
            h('div', null, h('span', { class: 'break', text: r.email }), r.is_role ? h('span', { class: 'chip chip-warn role', tip: 'A shared mailbox like info@ or sales@. These get fewer replies and are often filtered, so you can exclude them from campaigns.' }, 'Role') : null),
            name ? h('div', { class: 'small muted', text: name }) : null),
          h('td', { text: r.company || '—', class: 'break' + (r.company ? '' : ' faint') }),
          h('td', null, pill(S.status, r.verify_status, S.status.unverified)),
          h('td', { class: 'c-note small' }, note ? h('span', { class: 'muted', tip: r.verified_at ? 'Checked ' + fmt.ago(r.verified_at) : null, text: note }) : h('span', { class: 'faint', text: '—' })));
      });
      var sizeSel = h('select', { class: 'input size-sel', 'aria-label': 'Rows per page' }, h('option', { value: '50' }, '50 per page'), h('option', { value: '100' }, '100 per page'), h('option', { value: '200' }, '200 per page'));
      sizeSel.value = String(st.size); sizeSel.addEventListener('change', function () { st.size = parseInt(sizeSel.value, 10); st.page = 1; loadLeads(); });
      SB.mount(tableBox, h('div', { class: 'card flush' },
        h('div', { class: 'table-wrap' }, h('table', { class: 'table leads-table' },
          h('thead', null, h('tr', null, h('th', { class: 'c-check' }, all), sortTh('Email', 'email'), sortTh('Company', 'company'), sortTh('Status', 'verify_status'), h('th', { text: 'Details' }))),
          h('tbody', null, body))),
        h('div', { class: 'table-foot' }, pager(st.page, st.size, st.total, function (p) { st.page = p; loadLeads(); }), sizeSel)));
    }

    function loadLeads() {
      var my = ++st.req;
      return SB.api.get('/api/folders/' + st.id + '/leads?' + qs({ page: st.page, pageSize: st.size, search: st.q, status: st.status === 'all' ? '' : st.status, role: st.f.role, missing: st.f.missing, in_campaign: st.f.in_campaign, domain: st.f.domain, sort: st.sort, dir: st.dir })).then(function (r) {
        if (my !== st.req || shared.destroyed) return;
        if (!r.items.length && r.total > 0 && st.page > 1) { st.page = Math.ceil(r.total / st.size); return loadLeads(); }   // rows were deleted from the last page
        st.rows = r.items; st.total = r.total; renderTable(); renderBulk();
      }, function (e) { if (my === st.req && e.code !== 'offline') SB.mount(tableBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    function refresh() {
      if (st.id === null) return Promise.resolve();
      return Promise.all([SB.api.get('/api/folders/' + st.id + '/stats'), loadLeads()]).then(function (r) { if (shared.destroyed) return; st.stats = r[0].stats; renderStats(); }, function (e) {
        if (e.status === 404) { st.id = null; return loadFolders(); }
      });
    }

    return loadFolders();
  }

  // ---- do-not-email list tab -----------------------------------------------------------------------
  function suppressionTab(box, shared) {
    var st = { page: 1, size: 50, total: 0, items: [], req: 0 };
    var listBox = h('div');
    SB.mount(box, h('div', null,
      h('div', { class: 'callout' }, h('b', { text: 'People on this list are never emailed. ' }),
        'Anyone who unsubscribes, bounces, or replies "stop" is added automatically. Campaigns also check this list again right before every send, so late additions are respected.'), listBox));

    function addModal() {
      var err = h('div', { class: 'form-error hidden', role: 'alert' });
      var ta = h('textarea', { class: 'input', id: 'sp-emails', rows: 7, placeholder: 'alex@acme.com\njamie@globex.com, sam@initech.io' });
      var count = h('div', { class: 'small muted', text: '0 emails found' });
      ta.addEventListener('input', function () { var n = countEmails(ta.value); count.textContent = fmt.num(n) + (n === 1 ? ' email found' : ' emails found'); });
      var why = h('select', { class: 'input', id: 'sp-why' }, h('option', { value: 'manual' }, 'Do not contact (my decision)'), h('option', { value: 'unsubscribed' }, 'Unsubscribed'),
        h('option', { value: 'complaint' }, 'Complained or reported spam'), h('option', { value: 'bounced' }, 'Bounced'));
      ui.modal({ title: 'Add to do-not-email list', body: h('div', null, err, field('Email addresses', ta, 'Paste as many as you like (up to 5,000 at a time). Commas, spaces and new lines all work.', 'sp-emails'), count, h('div', { class: 'pad-t' }), field('Reason', why, null, 'sp-why')), actions: [
        { label: 'Cancel' },
        { label: 'Add to list', kind: 'primary', onClick: function (close) {
          err.classList.add('hidden');
          var found = String(ta.value).match(EMAIL_RE) || [];
          if (!found.length) { err.textContent = 'No email addresses found in the text.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
          if (found.length > 5000) { err.textContent = 'Please add at most 5,000 addresses at a time.'; err.classList.remove('hidden'); return Promise.reject(new Error('v')); }
          return SB.api.post('/api/suppression', { emails: found, reason: why.value }).then(function (r) {
            close(); var skipped = found.length - r.added;
            ui.toast(fmt.num(r.added) + ' added' + (skipped ? ' · ' + fmt.num(skipped) + ' were already on the list or not valid' : '')); st.page = 1; load();
          }, function (e) { showErr(err, e); throw e; });
        } }
      ] });
    }
    shared.openAdd = addModal;

    function render() {
      if (!st.items.length && st.total === 0) {
        SB.mount(listBox, h('div', { class: 'card empty' }, h('h2', { text: 'Nobody is blocked yet' }), h('p', { text: 'Unsubscribes and bounces will appear here automatically. You can also add addresses yourself.' }),
          h('button', { class: 'btn btn-primary', type: 'button', on: { click: addModal } }, SB.icon('plus'), 'Add emails')));
        return;
      }
      var rows = st.items.map(function (r) {
        var rm = h('button', { class: 'btn btn-sm', type: 'button', tip: 'Allow this address to be emailed again', on: { click: function () {
          ui.confirm({ title: 'Remove ' + r.email + '?', message: 'This address can be emailed again by future campaigns. Only do this if the person asked to hear from you again: emailing people who opted out can get your accounts reported.', confirmLabel: 'Remove', danger: true,
            onConfirm: function () { return SB.api.post('/api/suppression/remove', { email: r.email }).then(function () { ui.toast('Removed'); return load(); }); } });
        } } }, 'Remove');
        return h('tr', null, h('td', { class: 'break', text: r.email }), h('td', null, pill(S.suppression, r.reason, S.suppression.manual)), h('td', { class: 'small muted nowrap', tip: fmt.full(r.created_at) }, fmt.ago(r.created_at)), h('td', { class: 'right' }, rm));
      });
      SB.mount(listBox, h('div', { class: 'card flush' },
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Email' }), h('th', { text: 'Reason' }), h('th', { text: 'Added' }), h('th', null))), h('tbody', null, rows))),
        h('div', { class: 'table-foot' }, pager(st.page, st.size, st.total, function (p) { st.page = p; load(); }))));
    }
    function load() {
      var my = ++st.req;
      return SB.api.get('/api/suppression?' + qs({ page: st.page, pageSize: st.size })).then(function (r) {
        if (my !== st.req || shared.destroyed) return;
        if (!r.items.length && r.total > 0 && st.page > 1) { st.page = Math.ceil(r.total / st.size); return load(); }
        st.items = r.items; st.total = r.total; render();
      }, function (e) { if (e.code !== 'offline') SB.mount(listBox, h('div', { class: 'form-error', text: SB.api.friendly(e) })); });
    }
    return load();
  }

  // ---- screen -----------------------------------------------------------------------------------
  SB.screens.leads = function (opts) {
    var tab = opts && opts.tab === 'suppression' ? 'suppression' : 'lists';
    var shared = { destroyed: false }, body = h('div', null, h('div', { class: 'skeleton' })), root = h('div');
    var action = tab === 'lists'
      ? h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { if (shared.openImport) shared.openImport(); } } }, SB.icon('upload'), 'Import leads')
      : h('button', { class: 'btn btn-primary', type: 'button', on: { click: function () { if (shared.openAdd) shared.openAdd(); } } }, SB.icon('plus'), 'Add emails');
    root.appendChild(h('div', { class: 'page-head' },
      h('div', null, h('h1', { text: 'Leads' }), h('p', { class: 'sub', text: 'Your contacts, organised in lists. Import them, check which addresses are safe to email, and keep a do-not-email list.' })), action));
    root.appendChild(h('div', { class: 'segs tabs' },
      h('a', { class: 'seg' + (tab === 'lists' ? ' active' : ''), href: '#/leads' }, 'Lists'),
      h('a', { class: 'seg' + (tab === 'suppression' ? ' active' : ''), href: '#/leads/suppression', tip: 'Addresses that must never be emailed' }, 'Do-not-email list')));
    root.appendChild(body);
    (tab === 'lists' ? listsTab : suppressionTab)(body, shared);
    return { el: root, destroy: function () { shared.destroyed = true; } };
  };
})();
