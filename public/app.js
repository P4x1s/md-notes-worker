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
    tsWidget: $('tsWidget'),
    authError: $('authError'), authSubmit: $('authSubmit'),
    displayName: $('displayName'), displayNameInput: $('displayNameInput'),
    userInitial: $('userInitial'), langPopup: $('langPopup'),
    newNoteBtn: $('newNoteBtn'), noteList: $('noteList'),
    searchInput: $('searchInput'), exportBtn: $('exportBtn'),
    logoutBtn: $('logoutBtn'), emptyState: $('emptyState'),
    docCrumb: $('docCrumb'), sidebarToggle: $('sidebarToggle'),
    sidebarBackdrop: $('sidebarBackdrop'),
    themeToggle: $('themeToggle'),
    settingsBtn: $('settingsBtn'), settingsOverlay: $('settingsOverlay'),
    settingsReset: $('settingsReset'), settingsClose: $('settingsClose'),
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

  // ---------- 主题（三态循环：自动 → 浅色 → 深色） ----------
  // 「自动」按时段切换：19:00–次日 07:00 深色，其余浅色；每分钟复查一次
  var THEME_KEY = 'mdnotes-theme';
  var themePref = 'auto';

  function autoTheme() {
    var hour = new Date().getHours();
    return (hour >= 19 || hour < 7) ? 'dark' : 'light';
  }
  function setThemePref(pref) {
    if (pref !== 'auto' && pref !== 'light' && pref !== 'dark') pref = 'auto';
    themePref = pref;
    applyTheme();
  }
  function applyTheme() {
    var resolved = themePref === 'auto' ? autoTheme() : themePref;
    document.documentElement.dataset.theme = resolved;
    els.themeToggle.textContent = themePref === 'auto' ? '自动' : (resolved === 'light' ? '浅色' : '深色');
    els.themeToggle.dataset.mode = themePref;
    try { localStorage.setItem(THEME_KEY, themePref); } catch (ignore) { /* 隐私模式下忽略 */ }
    syncSettingsControls();
  }
  try { themePref = localStorage.getItem(THEME_KEY) || 'auto'; } catch (ignore) { themePref = 'auto'; }
  if (themePref !== 'auto' && themePref !== 'light' && themePref !== 'dark') themePref = 'auto';
  applyTheme();
  els.themeToggle.addEventListener('click', function () {
    setThemePref(themePref === 'auto' ? 'light' : (themePref === 'light' ? 'dark' : 'auto'));
  });
  setInterval(function () {
    if (themePref === 'auto') applyTheme();
  }, 60000);

  // ---------- 偏好设置（Typora 风格） ----------
  var SETTINGS_KEY = 'mdnotes-settings';
  var DEFAULT_SETTINGS = {
    sidebar: 'visible', activeLine: true,
    bodyFont: 'sans', bodySize: 16, bodyLine: 1.8,
    codeFont: 'cascadia', codeSize: 14,
    lineNumbers: false, langLabel: true, copyButton: true
  };
  var settings = loadSettings();

  function loadSettings() {
    var base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      var raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (var key in base) {
          if (key in raw) base[key] = raw[key];
        }
      }
    } catch (ignore) { /* 解析失败按默认处理 */ }
    return base;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (ignore) { /* 隐私模式下忽略 */ }
  }

  // 移动端抽屉瞬态状态；null 表示未交互（默认收起），桌面端忽略此值
  var mobileMq = window.matchMedia('(max-width: 680px)');
  var drawerOpen = null;
  function syncDrawer() {
    if (mobileMq.matches) {
      var open = drawerOpen === true;
      els.appShell.classList.toggle('sidebar-collapsed', !open);
      els.sidebarBackdrop.hidden = !open;
    } else {
      drawerOpen = null;
      els.sidebarBackdrop.hidden = true;
      els.appShell.classList.toggle('sidebar-collapsed', settings.sidebar === 'hidden');
    }
  }
  function applySettings() {
    var root = document.documentElement;
    root.dataset.bodyFont = settings.bodyFont;
    root.dataset.codeFont = settings.codeFont;
    root.style.setProperty('--body-size', String(settings.bodySize));
    root.style.setProperty('--body-line', String(settings.bodyLine));
    root.style.setProperty('--code-size', String(settings.codeSize));
    syncDrawer();
    if (!settings.activeLine || els.noteContent.hidden) els.activeLine.hidden = true;
    // 行号 / 语言标签 / 复制按钮变动需要重建预览 DOM（两个容器都重建，与可见性无关）
    if (state.current) {
      renderMarkdown(els.preview);
      renderMarkdown(els.splitPreview);
    }
    syncSettingsControls();
  }

  function syncSettingsControls() {
    if (!settings) return; // 初始化早期 settings 尚未就绪
    Array.prototype.forEach.call(document.querySelectorAll('.seg-group'), function (group) {
      var key = group.dataset.seg;
      var current = String(key === 'theme' ? themePref : settings[key]);
      Array.prototype.forEach.call(group.querySelectorAll('.seg'), function (btn) {
        btn.classList.toggle('active', btn.dataset.value === current);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-check]'), function (input) {
      var key = input.dataset.check;
      if (key === 'sidebarVisible') input.checked = settings.sidebar === 'visible';
      else input.checked = !!settings[key];
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.seg-group .seg'), function (btn) {
    btn.addEventListener('click', function () {
      var group = btn.closest('.seg-group');
      var key = group.dataset.seg;
      var value = btn.dataset.value;
      if (key === 'theme') setThemePref(value);
      else {
        settings[key] = group.dataset.num ? Number(value) : parseFloat(value) || value;
        if (key === 'bodyLine') settings.bodyLine = parseFloat(value);
        applySettings();
        saveSettings();
      }
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-check]'), function (input) {
    input.addEventListener('change', function () {
      var key = input.dataset.check;
      if (key === 'sidebarVisible') {
        settings.sidebar = input.checked ? 'visible' : 'hidden';
        applySettings();
      } else {
        settings[key] = input.checked;
        applySettings();
      }
      saveSettings();
    });
  });

  function openSettings() {
    els.settingsOverlay.hidden = false;
    syncSettingsControls();
  }
  function closeSettings() {
    els.settingsOverlay.hidden = true;
    saveSettings();
  }
  els.settingsBtn.addEventListener('click', openSettings);
  els.settingsClose.addEventListener('click', closeSettings);
  els.settingsOverlay.addEventListener('mousedown', function (event) {
    if (event.target === els.settingsOverlay) closeSettings();
  });
  els.settingsReset.addEventListener('click', function () {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    setThemePref('auto');
    applySettings();
    saveSettings();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.settings-nav [data-panel]'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.settings-nav [data-panel]'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.settings-panel'), function (panel) {
        panel.classList.toggle('active', panel.dataset.panel === btn.dataset.panel);
      });
    });
  });

  els.sidebarToggle.addEventListener('click', function () {
    if (mobileMq.matches) {
      drawerOpen = els.appShell.classList.contains('sidebar-collapsed');
      syncDrawer();
      return;
    }
    settings.sidebar = settings.sidebar === 'hidden' ? 'visible' : 'hidden';
    applySettings();
    saveSettings();
  });
  els.sidebarBackdrop.addEventListener('click', function () {
    drawerOpen = false;
    syncDrawer();
  });
  function onMobileChange() { syncDrawer(); }
  if (mobileMq.addEventListener) mobileMq.addEventListener('change', onMobileChange);
  else if (mobileMq.addListener) mobileMq.addListener(onMobileChange);
  applySettings();

  function showAuth() {
    els.authView.hidden = false;
    els.mainView.hidden = true;
    initTurnstile();
  }

  function showMain() {
    els.authView.hidden = true;
    els.mainView.hidden = false;
  }

  // ---------- Turnstile 人机验证 ----------
  // 就绪通知三重保险：api.js?onload 回调 + script.onload + 定时器探测；
  // 容器必须可见后再 render（iframe 在 display:none 容器中会拿到 0 尺寸而显示异常）。
  var ts = { enabled: false, siteKey: '', widgetId: null, scriptAdded: false, rendered: false };

  function tsVisible() {
    return !!(els.tsWidget.offsetWidth || els.tsWidget.offsetHeight || els.tsWidget.getClientRects().length);
  }

  function tsRender() {
    if (ts.rendered || !window.turnstile || !tsVisible()) return;
    try {
      ts.widgetId = window.turnstile.render(els.tsWidget, {
        sitekey: ts.siteKey,
        callback: function () { /* token 就绪，提交时读取 */ },
        'expired-callback': function () { tsReset(); },
        'error-callback': function () { tsReset(); }
      });
      ts.rendered = true;
    } catch (renderError) {
      // 渲染失败按未启用处理，不阻塞登录（服务端仍有凭证校验与限流）
      ts.enabled = false;
      els.tsWidget.hidden = true;
    }
  }

  function tsReset() {
    if (ts.widgetId !== null && window.turnstile) {
      try { window.turnstile.reset(ts.widgetId); } catch (ignore) { /* 已失效则忽略 */ }
    }
  }

  function tsGetToken() {
    if (!ts.enabled) return '';
    if (ts.widgetId !== null && window.turnstile) {
      try { return window.turnstile.getResponse(ts.widgetId) || ''; } catch (ignore) { return ''; }
    }
    return '';
  }

  function tsTryRenderLoop() {
    tsRender();
    var retries = 0;
    var timer = setInterval(function () {
      if (ts.rendered || ++retries > 100) { clearInterval(timer); return; }
      tsRender();
    }, 50);
  }

  function onTsReady() {
    if (!ts.enabled) return;
    tsTryRenderLoop();
  }

  function loadTurnstileScript() {
    if (ts.scriptAdded) { onTsReady(); return; }
    ts.scriptAdded = true;
    window.onTsLoad = onTsReady; // 官方 onload 回调（显式渲染模式）
    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTsLoad&render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = onTsReady;  // 兜底一
    script.onerror = function () { ts.enabled = false; els.tsWidget.hidden = true; };
    document.head.appendChild(script);
    setTimeout(onTsReady, 3000); // 兜底二：定时器探测
  }

  function initTurnstile() {
    if (ts.scriptAdded) { onTsReady(); return; }
    api('/api/auth/config').then(function (config) {
      var t = config && config.turnstile;
      if (!t || !t.enabled || !t.siteKey) return;
      ts.enabled = true;
      ts.siteKey = t.siteKey;
      els.tsWidget.hidden = false;
      loadTurnstileScript();
    }).catch(function () { /* 拉取失败按未启用处理 */ });
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
    if (!settings.activeLine) {
      els.activeLine.hidden = true;
      return;
    }
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

  // ---------- 代码块语言自动补全（Typora 风格） ----------
  // 在 ``` / ~~~ 围栏行输入语言前缀时弹出候选列表；↑↓ 选择、Enter 确认、Esc 关闭
  var LANGS = (window.hljs && typeof window.hljs.listLanguages === 'function')
    ? window.hljs.listLanguages().slice() : [];
  var langState = { open: false, items: [], index: 0, info: null };

  // 测量光标像素位置：镜像 div 复刻文本域排版，光标处放置零宽标记
  var langMirror = document.createElement('div');
  langMirror.className = 'lang-mirror';
  document.body.appendChild(langMirror);

  function caretPixel() {
    var ta = els.noteContent;
    langMirror.style.width = ta.clientWidth + 'px';
    langMirror.textContent = ta.value.slice(0, ta.selectionStart);
    var marker = document.createElement('span');
    marker.textContent = '\u200b';
    langMirror.appendChild(marker);
    return { left: marker.offsetLeft, top: marker.offsetTop };
  }

  function fenceLineInfo() {
    var ta = els.noteContent;
    var value = ta.value;
    var lineStart = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    var lineEnd = value.indexOf('\n', ta.selectionStart);
    if (lineEnd === -1) lineEnd = value.length;
    var match = value.slice(lineStart, lineEnd).match(/^(`{3,}|~{3,})([A-Za-z0-9_+#.\-]*)$/);
    if (!match) return null;
    return { lineStart: lineStart, lineEnd: lineEnd, fence: match[1], prefix: match[2] };
  }

  function hideLangPopup() {
    langState.open = false;
    els.langPopup.hidden = true;
  }

  function renderLangItems() {
    els.langPopup.textContent = '';
    langState.items.forEach(function (lang, i) {
      var item = document.createElement('div');
      item.className = 'lang-item' + (i === langState.index ? ' active' : '');
      item.textContent = lang;
      item.addEventListener('mousedown', function (event) {
        event.preventDefault(); // 防止文本域失焦
        applyLangChoice(lang);
      });
      els.langPopup.appendChild(item);
    });
    var active = els.langPopup.querySelector('.lang-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function positionLangPopup() {
    var ta = els.noteContent;
    var lineH = parseFloat(window.getComputedStyle(ta).lineHeight) || 26;
    var pixel = caretPixel();
    var left = pixel.left - ta.scrollLeft;
    var top = pixel.top - ta.scrollTop + lineH + 4;
    var popupW = 230;
    left = Math.min(Math.max(left, 0), Math.max(ta.clientWidth - popupW - 4, 0));
    var popupH = els.langPopup.offsetHeight || 200;
    if (top + popupH > ta.clientHeight - 4) {
      top = Math.max(pixel.top - ta.scrollTop - popupH - 4, 0); // 下方放不下则上翻
    }
    els.langPopup.style.left = left + 'px';
    els.langPopup.style.top = top + 'px';
  }

  function updateLangPopup() {
    var ta = els.noteContent;
    if (ta.hidden || !LANGS.length) { hideLangPopup(); return; }
    var info = fenceLineInfo();
    if (!info || ta.selectionStart < info.lineStart + info.fence.length) {
      hideLangPopup();
      return;
    }
    var query = info.prefix.toLowerCase();
    var items = query
      ? LANGS.filter(function (lang) { return lang.indexOf(query) === 0; })
      : LANGS;
    if (!items.length) { hideLangPopup(); return; }
    langState.open = true;
    langState.items = items;
    langState.index = 0;
    langState.info = info;
    renderLangItems();
    els.langPopup.hidden = false;
    positionLangPopup();
  }

  function applyLangChoice(lang) {
    var ta = els.noteContent;
    var info = langState.info;
    if (!info) { hideLangPopup(); return; }
    var value = ta.value;
    var before = value.slice(0, info.lineStart);
    var after = value.slice(info.lineEnd);
    var rest = value.slice(info.lineEnd);
    var nl = rest.indexOf('\n');
    var nextLine = (nl === -1 ? '' : rest.slice(nl + 1).split('\n')[0]).trim();
    var closeRe = info.fence.charAt(0) === '`' ? /^`{3,}$/ : /^~{3,}$/;
    var hasClose = closeRe.test(nextLine);

    var openLine = info.fence + lang.toLowerCase();
    // 与 Typora 一致：自动补全配对围栏，光标落到块内空行
    var replacement = hasClose ? openLine : openLine + '\n\n' + info.fence;
    ta.value = before + replacement + after;
    var caret = hasClose
      ? before.length + openLine.length
      : before.length + openLine.length + 1;
    ta.selectionStart = ta.selectionEnd = caret;
    hideLangPopup();
    refreshEditorMeta();
    if (state.mode === 'split') renderMarkdown(els.splitPreview);
    scheduleSave();
    ta.focus();
  }

  els.noteContent.addEventListener('keydown', function (event) {
    if (!langState.open) return;
    var total = langState.items.length;
    if (event.key === 'ArrowDown' && total) {
      event.preventDefault();
      langState.index = (langState.index + 1) % total;
      renderLangItems();
    } else if (event.key === 'ArrowUp' && total) {
      event.preventDefault();
      langState.index = (langState.index - 1 + total) % total;
      renderLangItems();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      applyLangChoice(langState.items[langState.index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideLangPopup();
    }
  });

  document.addEventListener('mousedown', function (event) {
    if (langState.open && !els.langPopup.contains(event.target)) hideLangPopup();
  });

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
    if (!settings.copyButton) return;
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
    highlightCodeBlocks(target);
    beautifyCodeBlocks(target);
    addCodeCopyButtons(target);
  }

  // ---------- 代码高亮（highlight.js，191 种语言，随主题切换配色） ----------
  function highlightCodeBlocks(target) {
    if (!window.hljs || typeof window.hljs.highlightElement !== 'function') return;
    Array.prototype.forEach.call(target.querySelectorAll('pre code'), function (block) {
      try { window.hljs.highlightElement(block); } catch (ignore) { /* 单块失败不影响整体 */ }
    });
  }

  // 代码块美化：底部语言标签 + 可选行号列（滚动同步）
  function beautifyCodeBlocks(target) {
    Array.prototype.forEach.call(target.querySelectorAll('pre'), function (pre) {
      var code = pre.querySelector('code');
      if (!code) return;

      if (settings.langLabel) {
        var langMatch = (code.className || '').match(/language-([\w+#.-]+)/);
        if (langMatch && !pre.querySelector('.code-lang')) {
          var chip = document.createElement('span');
          chip.className = 'code-lang';
          chip.textContent = langMatch[1].toLowerCase();
          pre.appendChild(chip);
        }
      }

      if (settings.lineNumbers && !pre.dataset.ln) {
        pre.dataset.ln = '1';
        var lineCount = code.textContent.replace(/\n$/, '').split('\n').length;
        var gutter = document.createElement('div');
        gutter.className = 'code-ln';
        gutter.setAttribute('aria-hidden', 'true');
        for (var i = 1; i <= lineCount; i++) {
          var num = document.createElement('div');
          num.textContent = i;
          gutter.appendChild(num);
        }
        var codeStyle = window.getComputedStyle(code);
        var preStyle = window.getComputedStyle(pre);
        gutter.style.fontSize = codeStyle.fontSize;
        gutter.style.lineHeight = preStyle.lineHeight;
        pre.appendChild(gutter);
        pre.addEventListener('scroll', function () {
          gutter.style.transform = 'translateY(' + (-pre.scrollTop) + 'px)';
        });
      }
    });
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
      hideLangPopup();
      els.docCrumb.textContent = '我的笔记 / ' + state.current.title;
      renderPreview();
      renderList();
      // 移动端：选中笔记后自动收起抽屉
      if (mobileMq.matches && drawerOpen) {
        drawerOpen = false;
        syncDrawer();
      }
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

  // ---------- 底部用户区：显示名渲染与内联编辑 ----------
  function renderFootUser() {
    var name = (state.me && (state.me.display_name || state.me.username)) || '?';
    els.displayName.textContent = name;
    els.userInitial.textContent = name.charAt(0);
  }

  var nameEditing = false;

  function startNameEdit() {
    if (nameEditing || !state.me) return;
    nameEditing = true;
    els.displayNameInput.value = state.me.display_name || '';
    els.displayName.hidden = true;
    els.displayNameInput.hidden = false;
    els.displayNameInput.focus();
    els.displayNameInput.select();
  }

  function finishNameEdit() {
    nameEditing = false;
    els.displayNameInput.hidden = true;
    els.displayName.hidden = false;
    renderFootUser();
  }

  async function commitNameEdit() {
    if (!nameEditing) return;
    var value = els.displayNameInput.value.trim();
    var previous = state.me.display_name || '';
    if (!value || value === previous) { finishNameEdit(); return; }
    try {
      var data = await api('/api/auth/profile', {
        method: 'PUT',
        body: { display_name: value }
      });
      state.me = data.user;
      finishNameEdit();
      setStatus('saved', '显示名已更新');
    } catch (error) {
      finishNameEdit();
      setStatus('error', '显示名保存失败：' + error.message);
    }
  }

  async function enterApp(user) {
    state.me = user;
    renderFootUser();
    showMain();
    try {
      await loadNotes();
    } catch (error) {
      setStatus('error', '加载笔记失败：' + error.message);
    }
  }

  els.displayName.addEventListener('click', startNameEdit);
  els.displayName.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startNameEdit();
    }
  });
  els.displayNameInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitNameEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishNameEdit();
    }
  });
  els.displayNameInput.addEventListener('blur', commitNameEdit);

  els.authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    els.authError.textContent = '';

    if (ts.enabled && !tsGetToken()) {
      els.authError.textContent = '请先完成人机验证';
      return;
    }

    els.authSubmit.disabled = true;
    var payload = {
      username: els.authUsername.value.trim(),
      password: els.authPassword.value
    };
    if (ts.enabled) payload.turnstileToken = tsGetToken();

    try {
      var data = await api('/api/auth/login', {
        method: 'POST',
        body: payload
      });
      els.authPassword.value = '';
      await enterApp(data.user);
    } catch (error) {
      els.authError.textContent = error.message;
      // token 单次有效：任何登录失败后都重置验证组件，下次提交重新取 token
      if (ts.enabled) {
        tsReset();
        els.authError.textContent = error.code === 'turnstile_failed'
          ? '人机验证未通过，请重新完成验证后再登录'
          : error.message;
      }
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async function () {
    if (nameEditing) finishNameEdit();
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
    updateLangPopup();
    if (state.mode === 'split') renderMarkdown(els.splitPreview);
    scheduleSave();
  });
  ['click', 'keyup', 'select'].forEach(function (eventName) {
    els.noteContent.addEventListener(eventName, updateActiveLine);
  });
  els.noteContent.addEventListener('scroll', function () {
    updateActiveLine();
    hideLangPopup();
  });

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
    // Ctrl + , 打开偏好设置（Typora 同款快捷键）
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      if (els.settingsOverlay.hidden) openSettings();
      else closeSettings();
    }
    if (event.key === 'Escape' && !els.settingsOverlay.hidden) {
      event.preventDefault();
      closeSettings();
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
