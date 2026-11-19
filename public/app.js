// 前端逻辑：鉴权、笔记列表、自动保存、Markdown 预览与 Typora 风格编辑器
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SAVE_DELAY = 800;

  var els = {
    appShell: document.querySelector('.app-shell'),
    editorWrap: document.querySelector('.editor-wrap'),
    authView: $('authView'), mainView: $('mainView'),
    authForm: $('authForm'), authUsername: $('authUsername'),
    authPassword: $('authPassword'),
    authError: $('authError'), authSubmit: $('authSubmit'),
    who: $('who'), userInitial: $('userInitial'),
    newNoteBtn: $('newNoteBtn'), noteList: $('noteList'),
    searchInput: $('searchInput'), exportBtn: $('exportBtn'),
    logoutBtn: $('logoutBtn'), emptyState: $('emptyState'),
    docCrumb: $('docCrumb'), sidebarToggle: $('sidebarToggle'),
    themeToggle: $('themeToggle'),
    editorPane: $('editorPane'), noteTitle: $('noteTitle'),
    noteContent: $('noteContent'), activeLine: $('activeLine'),
    preview: $('preview'), splitPreview: $('splitPreview'),
    deleteBtn: $('deleteBtn'),
    saveStatus: $('saveStatus'), wordCount: $('wordCount'),
    lineCount: $('lineCount'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab'))
  };

  var state = {
    me: null,
    notes: [],
    current: null,
    mode: 'edit',
    query: '',
    pending: false,
    timer: null,
    saving: false
  };

  // DOMPurify 钩子：外链统一新标签打开并阻断 window.opener
  if (window.DOMPurify) {
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.nodeName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  // ---------- 主题 ----------
  function applyTheme(theme) {
    var selected = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = selected;
    els.themeToggle.textContent = selected === 'light' ? '深色' : '浅色';
    try { localStorage.setItem('mdnotes-theme', selected); } catch (ignore) { /* 隐私模式下忽略 */ }
  }
  function storedTheme() {
    try { return localStorage.getItem('mdnotes-theme'); } catch (ignore) { return null; }
  }
  applyTheme(storedTheme() || 'light');
  els.themeToggle.addEventListener('click', function () {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  els.sidebarToggle.addEventListener('click', function () {
    els.appShell.classList.toggle('sidebar-collapsed');
  });

  function showAuth() {
    els.authView.hidden = false;
    els.mainView.hidden = true;
  }

  function showMain() {
    els.authView.hidden = true;
    els.mainView.hidden = false;
  }

  function setStatus(kind, text) {
    els.saveStatus.textContent = text;
    els.saveStatus.dataset.kind = kind;
  }

  async function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    var response;
    try {
      response = await fetch(path, init);
    } catch (networkError) {
      throw new Error('网络连接失败，请检查网络后重试');
    }

    var payload;
    try {
      payload = await response.json();
    } catch (parseError) {
      throw new Error('服务器返回了无法解析的内容');
    }

    if (!response.ok) {
      if (response.status === 401 && state.me) {
        state.me = null;
        state.current = null;
        showAuth();
      }
      var error = new Error((payload.error && payload.error.message) || '请求失败');
      error.status = response.status;
      error.code = payload.error && payload.error.code;
      throw error;
    }
    return payload.data;
  }

  function formatTime(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return '今天 ' + date.toTimeString().slice(0, 5);
    }
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  // ---------- 编辑器元信息：字数、行数、当前行 ----------
  function updateCounts() {
    var text = els.noteContent.value;
    var chars = text.replace(/\s/g, '').length;
    var lines = text ? text.split('\n').length : 0;
    els.wordCount.textContent = '字数 ' + chars;
    els.lineCount.textContent = '行数 ' + lines;
  }

  function updateActiveLine() {
    var textarea = els.noteContent;
    if (textarea.hidden || state.mode === 'preview') {
      els.activeLine.hidden = true;
      return;
    }
    var lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 26;
    var before = textarea.value.slice(0, textarea.selectionStart);
    var line = before.split('\n').length;
    var top = (line - 1) * lineHeight - textarea.scrollTop;
    if (top < -lineHeight || top > textarea.clientHeight) {
      els.activeLine.hidden = true;
      return;
    }
    els.activeLine.hidden = false;
    els.activeLine.style.transform = 'translateY(' + top + 'px)';
  }

  function refreshEditorMeta() {
    updateCounts();
    updateActiveLine();
  }

  // ---------- 列表 ----------
  function renderList() {
    els.noteList.textContent = '';
    var query = state.query.trim().toLowerCase();
    var visible = query
      ? state.notes.filter(function (note) {
          return ((note.title || '') + ' ' + (note.excerpt || '')).toLowerCase().indexOf(query) !== -1;
        })
      : state.notes;

    if (!visible.length) {
      var hint = document.createElement('p');
      hint.className = 'list-hint';
      hint.textContent = query ? '没有匹配的笔记' : '还没有笔记';
      els.noteList.appendChild(hint);
      return;
    }

    visible.forEach(function (note) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-item' + (state.current && state.current.id === note.id ? ' selected' : '');
      button.dataset.id = String(note.id);

      var title = document.createElement('span');
      title.className = 'note-title';
      title.textContent = note.title || '未命名笔记';

      var excerpt = document.createElement('span');
      excerpt.className = 'note-excerpt';
      excerpt.textContent = (note.excerpt || '空笔记').replace(/\s+/g, ' ').slice(0, 60);

      var time = document.createElement('span');
      time.className = 'note-time';
      time.textContent = formatTime(note.updated_at);

      button.appendChild(title);
      button.appendChild(excerpt);
      button.appendChild(time);
      button.addEventListener('click', function () { openNote(note.id); });
      els.noteList.appendChild(button);
    });
  }

  function updateListEntry(note) {
    var index = -1;
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === note.id) { index = i; break; }
    }
    var summary = {
      id: note.id,
      title: note.title,
      excerpt: note.content.slice(0, 160),
      updated_at: note.updated_at
    };
    if (index >= 0) state.notes[index] = summary;
    else state.notes.unshift(summary);
    renderList();
  }

  function addCodeCopyButtons(target) {
    Array.prototype.forEach.call(target.querySelectorAll('pre'), function (pre) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy-code';
      button.textContent = '复制';
      button.addEventListener('click', async function () {
        var code = pre.querySelector('code');
        var text = code ? code.textContent : pre.textContent;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = '已复制';
        } catch (clipboardError) {
          button.textContent = '复制失败';
        }
        setTimeout(function () { button.textContent = '复制'; }, 1500);
      });
      pre.appendChild(button);
    });
  }

  function renderMarkdown(target) {
    if (!state.current || !target) return;
    if (!window.marked || !window.DOMPurify) {
      target.textContent = 'Markdown 组件加载失败，请检查静态资源。';
      return;
    }
    var rawHtml = window.marked.parse(state.current.content || '', { gfm: true, breaks: true });
    target.innerHTML = window.DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style']
    });
    addCodeCopyButtons(target);
  }

  function renderPreview() {
    renderMarkdown(els.preview);
  }

  function setMode(mode) {
    state.mode = mode;
    els.tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    var editing = mode !== 'preview';
    var splitting = mode === 'split';
    els.editorWrap.classList.toggle('split', splitting);
    els.noteContent.hidden = !editing;
    els.preview.hidden = mode !== 'preview';
    els.splitPreview.hidden = !splitting;
    if (mode === 'preview') renderMarkdown(els.preview);
    if (splitting) renderMarkdown(els.splitPreview);
    updateActiveLine();
  }

  function openNote(id) {
    if (state.pending) flushSave();
    api('/api/notes/' + id).then(function (data) {
      state.current = data.note;
      els.editorPane.hidden = false;
      els.emptyState.hidden = true;
      els.noteTitle.value = state.current.title;
      els.noteContent.value = state.current.content;
      els.noteContent.selectionStart = 0;
      els.noteContent.selectionEnd = 0;
      els.docCrumb.textContent = '我的笔记 / ' + state.current.title;
      renderPreview();
      renderList();
      setStatus('saved', '所有更改已保存');
      setMode(state.mode);
      refreshEditorMeta();
    }).catch(function (error) {
      setStatus('error', '打开失败：' + error.message);
    });
  }

  function loadNotes() {
    return api('/api/notes').then(function (data) {
      state.notes = data.notes || [];
      renderList();
      if (state.notes.length) {
        openNote(state.notes[0].id);
      } else {
        state.current = null;
        els.editorPane.hidden = true;
        els.emptyState.hidden = false;
        els.docCrumb.textContent = '未选择笔记';
        refreshEditorMeta();
      }
    });
  }

  function createNote() {
    if (state.pending) flushSave();
    api('/api/notes', {
      method: 'POST',
      body: { title: '未命名笔记', content: '' }
    }).then(function (data) {
      state.notes.unshift({
        id: data.note.id,
        title: data.note.title,
        excerpt: '',
        updated_at: data.note.updated_at
      });
      openNote(data.note.id);
    }).catch(function (error) {
      setStatus('error', '新建失败：' + error.message);
    });
  }

  function flushSave() {
    if (!state.current || !state.pending || state.saving) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }

    var id = state.current.id;
    var title = els.noteTitle.value;
    var content = els.noteContent.value;
    state.saving = true;
    state.pending = false;
    setStatus('saving', '保存中…');

    api('/api/notes/' + id, {
      method: 'PUT',
      body: { title: title, content: content }
    }).then(function (data) {
      state.saving = false;
      state.current = data.note;
      els.docCrumb.textContent = '我的笔记 / ' + data.note.title;
      updateListEntry(data.note);
      setStatus('saved', '已保存 · ' + new Date(data.note.updated_at).toTimeString().slice(0, 8));
      if (state.mode === 'preview') renderMarkdown(els.preview);
      if (state.mode === 'split') renderMarkdown(els.splitPreview);
    }).catch(function (error) {
      state.saving = false;
      state.pending = true;
      setStatus('error', '保存失败，点击重试（' + error.message + '）');
    });
  }

  function scheduleSave() {
    if (!state.current) return;
    state.pending = true;
    setStatus('unsaved', '有未保存的更改…');
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(flushSave, SAVE_DELAY);
  }

  function deleteNote() {
    if (!state.current) return;
    if (!window.confirm('确定删除这条笔记吗？此操作不可恢复。')) return;
    var id = state.current.id;
    api('/api/notes/' + id, { method: 'DELETE' }).then(function () {
      state.notes = state.notes.filter(function (note) { return note.id !== id; });
      state.current = null;
      state.pending = false;
      els.editorPane.hidden = true;
      els.emptyState.hidden = false;
      els.docCrumb.textContent = '未选择笔记';
      refreshEditorMeta();
      renderList();
      if (state.notes.length) openNote(state.notes[0].id);
    }).catch(function (error) {
      setStatus('error', '删除失败：' + error.message);
    });
  }

  async function enterApp(user) {
    state.me = user;
    els.who.textContent = user.username;
    els.userInitial.textContent = (user.username || '?').charAt(0);
    showMain();
    try {
      await loadNotes();
    } catch (error) {
      setStatus('error', '加载笔记失败：' + error.message);
    }
  }

  els.authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    els.authError.textContent = '';
    els.authSubmit.disabled = true;
    var payload = {
      username: els.authUsername.value.trim(),
      password: els.authPassword.value
    };

    try {
      var data = await api('/api/auth/login', {
        method: 'POST',
        body: payload
      });
      els.authPassword.value = '';
      await enterApp(data.user);
    } catch (error) {
      els.authError.textContent = error.message;
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async function () {
    if (state.pending) flushSave();
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (ignore) { /* 本地状态仍需清理 */ }
    state.me = null;
    state.current = null;
    state.notes = [];
    els.noteContent.value = '';
    els.noteTitle.value = '';
    refreshEditorMeta();
    showAuth();
  });

  els.newNoteBtn.addEventListener('click', createNote);
  els.deleteBtn.addEventListener('click', deleteNote);
  els.noteTitle.addEventListener('input', scheduleSave);

  els.noteContent.addEventListener('input', function () {
    refreshEditorMeta();
    if (state.mode === 'split') renderMarkdown(els.splitPreview);
    scheduleSave();
  });
  ['click', 'keyup', 'select'].forEach(function (eventName) {
    els.noteContent.addEventListener(eventName, updateActiveLine);
  });
  els.noteContent.addEventListener('scroll', updateActiveLine);

  els.saveStatus.addEventListener('click', function () {
    if (els.saveStatus.dataset.kind === 'error' || els.saveStatus.dataset.kind === 'unsaved') flushSave();
  });

  els.searchInput.addEventListener('input', function () {
    state.query = els.searchInput.value;
    renderList();
  });

  els.exportBtn.addEventListener('click', function () {
    if (!state.current) return;
    var name = (els.noteTitle.value || '未命名笔记')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80);
    var blob = new Blob([els.noteContent.value], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name + '.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  els.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { setMode(tab.dataset.mode); });
  });

  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      flushSave();
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (state.pending) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  api('/api/auth/me').then(function (data) {
    enterApp(data.user);
  }).catch(function () {
    showAuth();
  });
})();
