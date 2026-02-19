(function() {
  // ---- Navigation helpers ----
  document.addEventListener('click', function(e) {
    var target = e.target;
    while (target && target.tagName !== 'A') target = target.parentElement;
    if (target && target.tagName === 'A') {
      var href = target.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        window.parent.postMessage({ type: 'iframe-navigation-start', url: href }, '*');
      }
    }
  });
  window.addEventListener('load', function() {
    window.parent.postMessage({ type: 'iframe-navigation', url: window.location.href }, '*');
  });
  window.addEventListener('popstate', function() {
    window.parent.postMessage({ type: 'iframe-navigation-start', url: window.location.href }, '*');
  });

  // ---- Element Inspector ----
  var inspectorActive = false;
  var overlay = null;
  var label = null;
  var dims = null;
  var currentTarget = null;
  var clickTimer = null;
  var DBLCLICK_DELAY = 250;

  function getElementLabel(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    if (cls.length > 0) s += '.' + cls.slice(0, 3).join('.');
    if (cls.length > 3) s += ' +' + (cls.length - 3);
    return s;
  }

  function updateOverlay(el) {
    if (!overlay) return;
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      label.style.display = 'none';
      dims.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    var labelText = getElementLabel(el);
    label.textContent = labelText;
    label.style.display = 'block';
    if (rect.top > 22) {
      label.style.top = (rect.top - 20) + 'px';
    } else {
      label.style.top = (rect.bottom + 4) + 'px';
    }
    label.style.left = Math.max(0, rect.left) + 'px';

    dims.textContent = Math.round(rect.width) + ' x ' + Math.round(rect.height);
    dims.style.display = 'block';
    dims.style.top = (rect.bottom + 4) + 'px';
    dims.style.left = Math.max(0, rect.right - 80) + 'px';
  }

  function buildElementData(el) {
    var rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; }),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: (el.textContent || '').trim().substring(0, 120),
      sourceFile: el.getAttribute('data-astro-source-file') || '',
      sourceLine: parseInt(el.getAttribute('data-astro-source-line') || '0', 10) || 0,
      component: el.getAttribute('data-component') || '',
      closestComponent: findClosestComponent(el),
      componentChain: buildComponentChain(el),
      pageFile: inferPageFile(),
      siblingIndex: getSiblingIndex(el),
      isMapRendered: isLikelyMapRendered(el),
    };
  }

  function isPhantomEl(el) {
    if (!el) return true;
    if (el.id && el.id.indexOf('__phantom') === 0) return true;
    if (el.classList && el.classList.contains('__phantom-outline-label')) return true;
    return false;
  }

  function onMouseMove(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && selectedEl) { updateOverlay(selectedEl); return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) return;
    if (el === currentTarget) return;
    currentTarget = el;
    updateOverlay(el);
    var data = buildElementData(el);
    data.type = 'element-inspector-hover';
    window.parent.postMessage(data, '*');
  }

  // ---- Class Editor State ----
  var classEditorMode = false;
  var selectedEl = null;
  var classEditorPanel = null;
  var originalClasses = [];
  var twClasses = [];
  var twMap = {};
  var previewClass = null;

  // Standard Tailwind color palette for swatch previews
  var _twPalette = {black:'#000',white:'#fff',
    'slate-50':'#f8fafc','slate-100':'#f1f5f9','slate-200':'#e2e8f0','slate-300':'#cbd5e1','slate-400':'#94a3b8','slate-500':'#64748b','slate-600':'#475569','slate-700':'#334155','slate-800':'#1e293b','slate-900':'#0f172a','slate-950':'#020617',
    'gray-50':'#f9fafb','gray-100':'#f3f4f6','gray-200':'#e5e7eb','gray-300':'#d1d5db','gray-400':'#9ca3af','gray-500':'#6b7280','gray-600':'#4b5563','gray-700':'#374151','gray-800':'#1f2937','gray-900':'#111827','gray-950':'#030712',
    'zinc-50':'#fafafa','zinc-100':'#f4f4f5','zinc-200':'#e4e4e7','zinc-300':'#d4d4d8','zinc-400':'#a1a1aa','zinc-500':'#71717a','zinc-600':'#52525b','zinc-700':'#3f3f46','zinc-800':'#27272a','zinc-900':'#18181b','zinc-950':'#09090b',
    'neutral-50':'#fafafa','neutral-100':'#f5f5f5','neutral-200':'#e5e5e5','neutral-300':'#d4d4d4','neutral-400':'#a3a3a3','neutral-500':'#737373','neutral-600':'#525252','neutral-700':'#404040','neutral-800':'#262626','neutral-900':'#171717','neutral-950':'#0a0a0a',
    'stone-50':'#fafaf9','stone-100':'#f5f5f4','stone-200':'#e7e5e4','stone-300':'#d6d3d1','stone-400':'#a8a29e','stone-500':'#78716c','stone-600':'#57534e','stone-700':'#44403c','stone-800':'#292524','stone-900':'#1c1917','stone-950':'#0c0a09',
    'red-50':'#fef2f2','red-100':'#fee2e2','red-200':'#fecaca','red-300':'#fca5a5','red-400':'#f87171','red-500':'#ef4444','red-600':'#dc2626','red-700':'#b91c1c','red-800':'#991b1b','red-900':'#7f1d1d','red-950':'#450a0a',
    'orange-50':'#fff7ed','orange-100':'#ffedd5','orange-200':'#fed7aa','orange-300':'#fdba74','orange-400':'#fb923c','orange-500':'#f97316','orange-600':'#ea580c','orange-700':'#c2410c','orange-800':'#9a3412','orange-900':'#7c2d12','orange-950':'#431407',
    'amber-50':'#fffbeb','amber-100':'#fef3c7','amber-200':'#fde68a','amber-300':'#fcd34d','amber-400':'#fbbf24','amber-500':'#f59e0b','amber-600':'#d97706','amber-700':'#b45309','amber-800':'#92400e','amber-900':'#78350f','amber-950':'#451a03',
    'yellow-50':'#fefce8','yellow-100':'#fef9c3','yellow-200':'#fef08a','yellow-300':'#fde047','yellow-400':'#facc15','yellow-500':'#eab308','yellow-600':'#ca8a04','yellow-700':'#a16207','yellow-800':'#854d0e','yellow-900':'#713f12','yellow-950':'#422006',
    'lime-50':'#f7fee7','lime-100':'#ecfccb','lime-200':'#d9f99d','lime-300':'#bef264','lime-400':'#a3e635','lime-500':'#84cc16','lime-600':'#65a30d','lime-700':'#4d7c0f','lime-800':'#3f6212','lime-900':'#365314','lime-950':'#1a2e05',
    'green-50':'#f0fdf4','green-100':'#dcfce7','green-200':'#bbf7d0','green-300':'#86efac','green-400':'#4ade80','green-500':'#22c55e','green-600':'#16a34a','green-700':'#15803d','green-800':'#166534','green-900':'#14532d','green-950':'#052e16',
    'emerald-50':'#ecfdf5','emerald-100':'#d1fae5','emerald-200':'#a7f3d0','emerald-300':'#6ee7b7','emerald-400':'#34d399','emerald-500':'#10b981','emerald-600':'#059669','emerald-700':'#047857','emerald-800':'#065f46','emerald-900':'#064e3b','emerald-950':'#022c22',
    'teal-50':'#f0fdfa','teal-100':'#ccfbf1','teal-200':'#99f6e4','teal-300':'#5eead4','teal-400':'#2dd4bf','teal-500':'#14b8a6','teal-600':'#0d9488','teal-700':'#0f766e','teal-800':'#115e59','teal-900':'#134e4a','teal-950':'#042f2e',
    'cyan-50':'#ecfeff','cyan-100':'#cffafe','cyan-200':'#a5f3fc','cyan-300':'#67e8f9','cyan-400':'#22d3ee','cyan-500':'#06b6d4','cyan-600':'#0891b2','cyan-700':'#0e7490','cyan-800':'#155e75','cyan-900':'#164e63','cyan-950':'#083344',
    'sky-50':'#f0f9ff','sky-100':'#e0f2fe','sky-200':'#bae6fd','sky-300':'#7dd3fc','sky-400':'#38bdf8','sky-500':'#0ea5e9','sky-600':'#0284c7','sky-700':'#0369a1','sky-800':'#075985','sky-900':'#0c4a6e','sky-950':'#082f49',
    'blue-50':'#eff6ff','blue-100':'#dbeafe','blue-200':'#bfdbfe','blue-300':'#93c5fd','blue-400':'#60a5fa','blue-500':'#3b82f6','blue-600':'#2563eb','blue-700':'#1d4ed8','blue-800':'#1e40af','blue-900':'#1e3a8a','blue-950':'#172554',
    'indigo-50':'#eef2ff','indigo-100':'#e0e7ff','indigo-200':'#c7d2fe','indigo-300':'#a5b4fc','indigo-400':'#818cf8','indigo-500':'#6366f1','indigo-600':'#4f46e5','indigo-700':'#4338ca','indigo-800':'#3730a3','indigo-900':'#312e81','indigo-950':'#1e1b4b',
    'violet-50':'#f5f3ff','violet-100':'#ede9fe','violet-200':'#ddd6fe','violet-300':'#c4b5fd','violet-400':'#a78bfa','violet-500':'#8b5cf6','violet-600':'#7c3aed','violet-700':'#6d28d9','violet-800':'#5b21b6','violet-900':'#4c1d95','violet-950':'#2e1065',
    'purple-50':'#faf5ff','purple-100':'#f3e8ff','purple-200':'#e9d5ff','purple-300':'#d8b4fe','purple-400':'#c084fc','purple-500':'#a855f7','purple-600':'#9333ea','purple-700':'#7e22ce','purple-800':'#6b21a8','purple-900':'#581c87','purple-950':'#3b0764',
    'fuchsia-50':'#fdf4ff','fuchsia-100':'#fae8ff','fuchsia-200':'#f5d0fe','fuchsia-300':'#f0abfc','fuchsia-400':'#e879f9','fuchsia-500':'#d946ef','fuchsia-600':'#c026d3','fuchsia-700':'#a21caf','fuchsia-800':'#86198f','fuchsia-900':'#701a75','fuchsia-950':'#4a044e',
    'pink-50':'#fdf2f8','pink-100':'#fce7f3','pink-200':'#fbcfe8','pink-300':'#f9a8d4','pink-400':'#f472b6','pink-500':'#ec4899','pink-600':'#db2777','pink-700':'#be185d','pink-800':'#9d174d','pink-900':'#831843','pink-950':'#500724',
    'rose-50':'#fff1f2','rose-100':'#ffe4e6','rose-200':'#fecdd3','rose-300':'#fda4af','rose-400':'#fb7185','rose-500':'#f43f5e','rose-600':'#e11d48','rose-700':'#be123c','rose-800':'#9f1239','rose-900':'#881337','rose-950':'#4c0519'
  };

  function resolveColorToken(token) {
    var val = getComputedStyle(document.documentElement).getPropertyValue('--color-' + token).trim();
    if (val) return val;
    return _twPalette[token] || null;
  }

  function onClick(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && (classEditorPanel.contains(e.target) || e.target.closest('#__phantom-class-editor'))) return;
    var dropEl = document.getElementById('__phantom-class-dropdown');
    if (dropEl && (dropEl.contains(e.target) || e.target.closest('#__phantom-class-dropdown'))) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // In class editor mode, act immediately (no debounce needed)
    if (classEditorMode) {
      // Close old editor BEFORE changing selectedEl so it reverts the correct element
      hideClassEditor();
      selectedEl = el;
      originalClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      var data = buildElementData(el);
      data.type = 'element-inspector-select';
      window.parent.postMessage(data, '*');
      showClassEditor(el, e.clientX, e.clientY);
      return false;
    }

    // Debounce single click to distinguish from double-click
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(function() {
      clickTimer = null;
      selectedEl = el;
      originalClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      var data = buildElementData(el);
      data.type = 'element-inspector-select';
      window.parent.postMessage(data, '*');
    }, DBLCLICK_DELAY);
    return false;
  }

  function onDblClick(e) {
    if (!inspectorActive) return;
    if (classEditorPanel && (classEditorPanel.contains(e.target) || e.target.closest('#__phantom-class-editor'))) return;
    var dropEl2 = document.getElementById('__phantom-class-dropdown');
    if (dropEl2 && (dropEl2.contains(e.target) || e.target.closest('#__phantom-class-dropdown'))) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isPhantomEl(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    selectedEl = el;
    originalClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    var data = buildElementData(el);
    data.type = 'element-inspector-dblclick';
    window.parent.postMessage(data, '*');
    return false;
  }

  // Delayed overlay refresh: waits for Tailwind CDN to generate CSS for new classes
  function refreshOverlay() {
    updateOverlay(selectedEl);
    setTimeout(function() { if (selectedEl) updateOverlay(selectedEl); }, 80);
  }

  // ---- Class Editor Panel ----
  function showClassEditor(el, clickX, clickY) {
    hideClassEditor();
    selectedEl = el;
    var classes = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    var computedStyle = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();

    classEditorPanel = document.createElement('div');
    classEditorPanel.id = '__phantom-class-editor';
    classEditorPanel.style.cssText = 'position:fixed;z-index:2147483647;background:#111827;border:1px solid #1f2937;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#d1d5db;width:380px;max-height:420px;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.6);backdrop-filter:blur(8px);overflow:hidden;';

    var panelW = 380, panelH = 380;
    var vw = window.innerWidth, vh = window.innerHeight;
    var spaceBelow = vh - rect.bottom;
    var spaceAbove = rect.top;
    // Horizontal: align with element left, shift if no room
    var px = rect.left;
    if (px + panelW > vw - 12) px = vw - panelW - 12;
    if (px < 12) px = 12;
    // Vertical: prefer below the element, use above if more space there
    var py;
    if (spaceBelow >= panelH + 12 || spaceBelow >= spaceAbove) {
      py = rect.bottom + 8;
      if (py + panelH > vh - 12) py = vh - panelH - 12;
    } else {
      py = rect.top - panelH - 8;
      if (py < 12) py = 12;
    }
    classEditorPanel.style.left = px + 'px';
    classEditorPanel.style.top = py + 'px';

    // Drag handle / header
    var dragBar = document.createElement('div');
    dragBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px 6px;cursor:grab;user-select:none;flex-shrink:0;';
    var tagRow = document.createElement('div');
    tagRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var tagIcon = document.createElement('span');
    tagIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    tagRow.appendChild(tagIcon);
    var tagName = document.createElement('span');
    tagName.style.cssText = 'color:#3b82f6;font-weight:600;font-size:13px;';
    tagName.textContent = el.tagName.toLowerCase();
    tagRow.appendChild(tagName);
    dragBar.appendChild(tagRow);
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px;line-height:0;border-radius:4px;';
    closeBtn.onmouseenter = function() { closeBtn.style.background = '#1f2937'; };
    closeBtn.onmouseleave = function() { closeBtn.style.background = 'none'; };
    closeBtn.onclick = function(ev) { ev.stopPropagation(); hideClassEditor(); };
    dragBar.appendChild(closeBtn);
    classEditorPanel.appendChild(dragBar);

    // Make draggable
    var isDragging = false, dragStartX = 0, dragStartY = 0, panelStartX = 0, panelStartY = 0;
    dragBar.addEventListener('mousedown', function(ev) {
      if (ev.target === closeBtn || closeBtn.contains(ev.target)) return;
      isDragging = true;
      dragStartX = ev.clientX; dragStartY = ev.clientY;
      panelStartX = parseInt(classEditorPanel.style.left, 10);
      panelStartY = parseInt(classEditorPanel.style.top, 10);
      dragBar.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function dragMove(ev) {
      if (!isDragging) return;
      classEditorPanel.style.left = (panelStartX + ev.clientX - dragStartX) + 'px';
      classEditorPanel.style.top = (panelStartY + ev.clientY - dragStartY) + 'px';
    });
    document.addEventListener('mouseup', function dragEnd() {
      if (isDragging) { isDragging = false; dragBar.style.cursor = 'grab'; }
    });

    // Info row
    var infoRow = document.createElement('div');
    infoRow.style.cssText = 'padding:0 12px 8px;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;flex-shrink:0;border-bottom:1px solid #1f2937;';
    var fontFamily = computedStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    var infoLeft = document.createElement('span');
    infoLeft.textContent = '"' + fontFamily + '" ' + computedStyle.fontSize + ' / ' + computedStyle.fontWeight;
    infoRow.appendChild(infoLeft);
    var infoRight = document.createElement('span');
    infoRight.textContent = Math.round(rect.width) + ' x ' + Math.round(rect.height) + 'px';
    infoRow.appendChild(infoRight);
    classEditorPanel.appendChild(infoRow);

    // Class chips (flat list)
    var chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'padding:10px 12px;display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;flex:1;min-height:40px;max-height:200px;scrollbar-width:thin;scrollbar-color:#374151 transparent;';
    if (classes.length === 0) {
      var emptyMsg = document.createElement('span');
      emptyMsg.style.cssText = 'color:#6b7280;font-size:11px;font-style:italic;';
      emptyMsg.textContent = 'No classes on this element';
      chipsWrap.appendChild(emptyMsg);
    }
    classes.forEach(function(cls) {
      chipsWrap.appendChild(createClassChip(cls, true, el, chipsWrap, markDirty));
    });
    classEditorPanel.appendChild(chipsWrap);

    // Add Class section
    var addSection = document.createElement('div');
    addSection.style.cssText = 'padding:8px 12px 10px;border-top:1px solid #1f2937;flex-shrink:0;position:relative;';
    var addLabel = document.createElement('div');
    addLabel.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:4px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px;';
    addLabel.textContent = 'Add Class';
    addSection.appendChild(addLabel);
    var inputWrap = document.createElement('div');
    inputWrap.style.cssText = 'position:relative;';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search by class/property';
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#030712;border:1px solid #374151;border-radius:6px;padding:7px 10px;color:#e5e7eb;font-family:inherit;font-size:11px;outline:none;';
    input.onfocus = function() { input.style.borderColor = '#3b82f6'; input.style.boxShadow = '0 0 0 2px rgba(59,130,246,0.2)'; };
    input.onblur = function() { setTimeout(function() { hideDropdown(); input.style.borderColor = '#374151'; input.style.boxShadow = 'none'; }, 150); };
    inputWrap.appendChild(input);
    addSection.appendChild(inputWrap);
    classEditorPanel.appendChild(addSection);

    // Autocomplete dropdown
    var dropdown = document.createElement('div');
    dropdown.id = '__phantom-class-dropdown';
    dropdown.style.cssText = 'display:none;position:fixed;background:#111827;border:1px solid #374151;border-radius:6px;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:2147483647;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;scrollbar-width:thin;scrollbar-color:#374151 transparent;color-scheme:dark;';

    function positionDropdown() {
      var inputRect = input.getBoundingClientRect();
      dropdown.style.left = inputRect.left + 'px';
      dropdown.style.width = inputRect.width + 'px';
      var spaceBelow = window.innerHeight - inputRect.bottom - 8;
      var dropH = Math.min(180, dropdown.scrollHeight || 180);
      if (spaceBelow >= dropH || spaceBelow >= 100) {
        dropdown.style.top = (inputRect.bottom + 4) + 'px';
        dropdown.style.bottom = 'auto';
      } else {
        dropdown.style.top = 'auto';
        dropdown.style.bottom = (window.innerHeight - inputRect.top + 4) + 'px';
      }
    }
    var activeIdx = -1;

    function showDropdown(query) {
      dropdown.innerHTML = '';
      activeIdx = -1;
      if (!query || query.length < 1) { dropdown.style.display = 'none'; return; }
      var q = query.toLowerCase();
      var currentClasses = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      var currentSet = {};
      currentClasses.forEach(function(c) { currentSet[c] = true; });
      var matches = [];
      for (var i = 0; i < twClasses.length && matches.length < 30; i++) {
        var cls = twClasses[i];
        var name = typeof cls === 'string' ? cls : cls.name;
        var desc = typeof cls === 'string' ? '' : (cls.description || '');
        if (currentSet[name]) continue;
        // Match by class name OR CSS description
        if (name.indexOf(q) !== -1 || (desc && desc.toLowerCase().indexOf(q) !== -1)) {
          matches.push(cls);
        }
      }
      if (matches.length === 0) { dropdown.style.display = 'none'; return; }
      // Sort: name-starts-with first, then name-contains, then description-match
      matches.sort(function(a, b) {
        var aName = typeof a === 'string' ? a : a.name;
        var bName = typeof b === 'string' ? b : b.name;
        var aNameStart = aName.indexOf(q) === 0 ? 0 : (aName.indexOf(q) !== -1 ? 1 : 2);
        var bNameStart = bName.indexOf(q) === 0 ? 0 : (bName.indexOf(q) !== -1 ? 1 : 2);
        if (aNameStart !== bNameStart) return aNameStart - bNameStart;
        return aName.length - bName.length;
      });
      matches.forEach(function(m, idx) {
        var mName = typeof m === 'string' ? m : m.name;
        var mDesc = typeof m === 'string' ? '' : (m.description || '');
        var item = document.createElement('div');
        item.setAttribute('data-class', mName);
        item.style.cssText = 'padding:5px 10px;cursor:pointer;font-size:11px;color:#d1d5db;display:flex;align-items:center;gap:8px;';
        var tokenMatch = mName.match(/^(?:bg|text|border|ring|outline|divide|shadow|from|via|to|fill|stroke|accent|caret)-(.+)$/);
        var tokenColor = tokenMatch ? resolveColorToken(tokenMatch[1]) : null;
        if (tokenColor) {
          var swatch = document.createElement('span');
          swatch.style.cssText = 'width:12px;height:12px;border-radius:3px;flex-shrink:0;border:1px solid #4b5563;background:' + tokenColor + ';';
          item.appendChild(swatch);
        }
        var lbl = document.createElement('span');
        lbl.textContent = mName;
        lbl.style.cssText = 'flex-shrink:0;';
        item.appendChild(lbl);
        // Show CSS description
        if (mDesc) {
          var descLbl = document.createElement('span');
          descLbl.textContent = mDesc;
          descLbl.style.cssText = 'color:#6b7280;font-size:10px;margin-left:auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;';
          item.appendChild(descLbl);
        }
        item.onmouseenter = function() { setActive(idx); applyPreview(mName); };
        item.onmouseleave = function() { removePreview(); };
        item.onmousedown = function(ev) { ev.preventDefault(); ev.stopPropagation(); selectSuggestion(mName); };
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
      positionDropdown();
    }

    function setActive(idx) {
      var items = dropdown.children;
      for (var j = 0; j < items.length; j++) {
        items[j].style.background = j === idx ? 'rgba(59,130,246,0.15)' : 'transparent';
        items[j].style.color = j === idx ? '#93c5fd' : '#d1d5db';
      }
      activeIdx = idx;
    }

    function hideDropdown() { removePreview(); dropdown.style.display = 'none'; activeIdx = -1; }

    function applyPreview(cls) {
      removePreview();
      if (cls && !el.classList.contains(cls)) {
        el.classList.add(cls);
        previewClass = cls;
        refreshOverlay();
      }
    }

    function removePreview() {
      if (previewClass && selectedEl) {
        selectedEl.classList.remove(previewClass);
        previewClass = null;
        refreshOverlay();
      }
    }

    var isDirty = false;
    function markDirty() { isDirty = true; if (saveBtn) saveBtn.style.opacity = '1'; }

    function addClassToElement(cls) {
      removePreview();
      if (!cls) return;
      if (!el.classList.contains(cls)) el.classList.add(cls);
      var existing = chipsWrap.querySelector('[data-class="' + cls + '"]');
      if (!existing) {
        var emptyEl = chipsWrap.querySelector('span[style*="italic"]');
        if (emptyEl) emptyEl.remove();
        chipsWrap.appendChild(createClassChip(cls, true, el, chipsWrap, markDirty));
      }
      refreshOverlay();
      markDirty();
    }

    function selectSuggestion(cls) {
      addClassToElement(cls);
      input.value = '';
      hideDropdown();
      input.focus();
    }

    input.oninput = function() { showDropdown(input.value.trim()); };
    input.onkeydown = function(ev) {
      var items = dropdown.children;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (dropdown.style.display === 'none') { showDropdown(input.value.trim()); return; }
        var nextIdx = Math.min(activeIdx + 1, items.length - 1);
        setActive(nextIdx);
        if (items[activeIdx]) { items[activeIdx].scrollIntoView({ block: 'nearest' }); applyPreview(items[activeIdx].getAttribute('data-class')); }
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        var prevIdx = Math.max(activeIdx - 1, 0);
        setActive(prevIdx);
        if (items[activeIdx]) { items[activeIdx].scrollIntoView({ block: 'nearest' }); applyPreview(items[activeIdx].getAttribute('data-class')); }
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) selectSuggestion(items[activeIdx].getAttribute('data-class'));
        else if (input.value.trim()) {
          input.value.trim().split(/\s+/).forEach(function(c) { if (c) addClassToElement(c); });
          input.value = '';
          hideDropdown();
          input.focus();
        }
      } else if (ev.key === 'Escape') {
        removePreview();
        if (dropdown.style.display !== 'none') { hideDropdown(); ev.stopPropagation(); }
        else hideClassEditor();
      } else if (ev.key === 'Tab' && activeIdx >= 0 && items[activeIdx]) {
        ev.preventDefault();
        selectSuggestion(items[activeIdx].getAttribute('data-class'));
      }
    };

    // Footer: Save / Revert
    var footer = document.createElement('div');
    footer.style.cssText = 'padding:6px 12px 8px;border-top:1px solid #1f2937;flex-shrink:0;display:flex;gap:6px;justify-content:flex-end;';

    var revertBtn = document.createElement('button');
    revertBtn.textContent = 'Revert';
    revertBtn.style.cssText = 'padding:4px 12px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;background:transparent;color:#9ca3af;border:1px solid #374151;';
    revertBtn.onmouseenter = function() { revertBtn.style.background = '#1f2937'; revertBtn.style.color = '#e5e7eb'; };
    revertBtn.onmouseleave = function() { revertBtn.style.background = 'transparent'; revertBtn.style.color = '#9ca3af'; };
    revertBtn.onclick = function(ev) {
      ev.stopPropagation();
      var current = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      current.forEach(function(c) { el.classList.remove(c); });
      originalClasses.forEach(function(c) { el.classList.add(c); });
      hideClassEditor();
    };
    footer.appendChild(revertBtn);

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save to code';
    saveBtn.style.cssText = 'padding:4px 12px;border-radius:6px;font-size:11px;font-family:inherit;cursor:pointer;background:#2563eb;color:#fff;border:1px solid #3b82f6;opacity:0.5;box-shadow:0 0 8px rgba(59,130,246,0.3);';
    saveBtn.onmouseenter = function() { saveBtn.style.background = '#1d4ed8'; };
    saveBtn.onmouseleave = function() { saveBtn.style.background = '#2563eb'; };
    saveBtn.onclick = function(ev) {
      ev.stopPropagation();
      notifyClassChange(el);
      classEditorPanel.remove();
      classEditorPanel = null;
    };
    footer.appendChild(saveBtn);

    classEditorPanel.appendChild(footer);

    document.body.appendChild(classEditorPanel);
    document.body.appendChild(dropdown);
    setTimeout(function() { input.focus(); }, 60);
  }

  // CSS popup for hovering class chips
  var cssPopupTimer = null;
  function showCssPopup(chip, cls) {
    hideCssPopup();
    var info = twMap[cls];
    var desc = (info && info.description) ? info.description : null;
    if (!desc) return;

    cssPopupTimer = setTimeout(function() {
      var popup = document.createElement('div');
      popup.id = '__phantom-css-popup';
      popup.style.cssText = 'position:fixed;z-index:2147483647;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;pointer-events:none;max-width:320px;';

      // Build syntax-highlighted CSS line(s)
      var parts = desc.split(';');
      parts.forEach(function(part) {
        part = part.trim();
        if (!part) return;
        var colonIdx = part.indexOf(':');
        if (colonIdx === -1) {
          // No colon, just render as text
          var line = document.createElement('div');
          line.style.cssText = 'color:#e2e8f0;white-space:nowrap;';
          line.textContent = part;
          popup.appendChild(line);
          return;
        }
        var prop = part.substring(0, colonIdx).trim();
        var val = part.substring(colonIdx + 1).trim();

        var line = document.createElement('div');
        line.style.cssText = 'white-space:nowrap;';

        var propSpan = document.createElement('span');
        propSpan.style.cssText = 'color:#7dd3fc;';
        propSpan.textContent = prop;
        line.appendChild(propSpan);

        var colonSpan = document.createElement('span');
        colonSpan.style.cssText = 'color:#64748b;';
        colonSpan.textContent = ': ';
        line.appendChild(colonSpan);

        // Color-code values
        var valSpan = document.createElement('span');
        // Numbers/units -> orange, keywords -> green, colors -> pink
        if (/^-?[\d.]+/.test(val) || /^\d/.test(val)) {
          valSpan.style.cssText = 'color:#fbbf24;';
        } else if (val === 'none' || val === 'auto' || val === 'inherit' || val === 'initial' || val === 'transparent') {
          valSpan.style.cssText = 'color:#a78bfa;';
        } else {
          valSpan.style.cssText = 'color:#86efac;';
        }
        valSpan.textContent = val;
        line.appendChild(valSpan);

        var semiSpan = document.createElement('span');
        semiSpan.style.cssText = 'color:#64748b;';
        semiSpan.textContent = ';';
        line.appendChild(semiSpan);

        popup.appendChild(line);
      });

      // Position above the chip
      document.body.appendChild(popup);
      var chipRect = chip.getBoundingClientRect();
      var popupRect = popup.getBoundingClientRect();
      var left = chipRect.left;
      if (left + popupRect.width > window.innerWidth - 8) left = window.innerWidth - popupRect.width - 8;
      if (left < 8) left = 8;
      var top = chipRect.top - popupRect.height - 6;
      if (top < 8) top = chipRect.bottom + 6;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    }, 400);
  }

  function hideCssPopup() {
    if (cssPopupTimer) { clearTimeout(cssPopupTimer); cssPopupTimer = null; }
    var popup = document.getElementById('__phantom-css-popup');
    if (popup) popup.remove();
  }

  function createClassChip(cls, enabled, el, container, markDirty) {
    var chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer;user-select:none;transition:background 0.1s,color 0.1s;' + (enabled ? 'background:rgba(59,130,246,0.1);color:#93c5fd;border:1px solid rgba(59,130,246,0.3);' : 'background:#1f2937;color:#6b7280;border:1px solid #374151;');
    chip.setAttribute('data-class', cls);
    chip.setAttribute('data-enabled', enabled ? '1' : '0');

    var cb = document.createElement('span');
    cb.style.cssText = 'width:14px;height:14px;border-radius:3px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:10px;line-height:1;' + (enabled ? 'background:#3b82f6;color:#fff;' : 'background:#1f2937;color:transparent;border:1px solid #4b5563;');
    cb.innerHTML = enabled ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '';
    chip.appendChild(cb);

    var text = document.createElement('span');
    text.style.cssText = enabled ? '' : 'text-decoration:line-through;';
    text.textContent = cls;
    chip.appendChild(text);

    chip.onmouseenter = function() { chip.style.filter = 'brightness(1.15)'; showCssPopup(chip, cls); };
    chip.onmouseleave = function() { chip.style.filter = ''; hideCssPopup(); };

    chip.onclick = function(ev) {
      ev.stopPropagation();
      var isEnabled = chip.getAttribute('data-enabled') === '1';
      if (isEnabled) {
        el.classList.remove(cls);
        chip.setAttribute('data-enabled', '0');
        chip.style.background = '#1f2937'; chip.style.color = '#6b7280'; chip.style.borderColor = '#374151';
        cb.style.background = '#1f2937'; cb.style.color = 'transparent'; cb.style.border = '1px solid #4b5563'; cb.innerHTML = '';
        text.style.textDecoration = 'line-through';
      } else {
        el.classList.add(cls);
        chip.setAttribute('data-enabled', '1');
        chip.style.background = 'rgba(59,130,246,0.1)'; chip.style.color = '#93c5fd'; chip.style.borderColor = 'rgba(59,130,246,0.3)';
        cb.style.background = '#3b82f6'; cb.style.color = '#fff'; cb.style.border = 'none';
        cb.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        text.style.textDecoration = 'none';
      }
      refreshOverlay();
      markDirty();
    };

    return chip;
  }

  function findClosestComponent(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      var comp = node.getAttribute('data-component');
      if (comp) return comp;
      node = node.parentElement;
    }
    return '';
  }

  function buildComponentChain(el) {
    var chain = [];
    var node = el;
    while (node && node !== document.documentElement) {
      var comp = node.getAttribute('data-component');
      if (comp && (chain.length === 0 || chain[chain.length - 1] !== comp)) {
        chain.push(comp);
      }
      node = node.parentElement;
    }
    return chain;
  }

  function getSiblingIndex(el) {
    if (!el.parentElement) return 0;
    var siblings = el.parentElement.children;
    var sameTagCount = 0;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === el) return sameTagCount;
      if (siblings[i].tagName === el.tagName) sameTagCount++;
    }
    return 0;
  }

  function isLikelyMapRendered(el) {
    if (!el.parentElement) return false;
    var comp = el.getAttribute('data-component');
    if (!comp) return false;
    var siblings = el.parentElement.children;
    var count = 0;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].getAttribute('data-component') === comp) count++;
    }
    return count > 1;
  }

  function inferPageFile() {
    var path = window.location.pathname;
    if (path === '/' || path === '') return 'src/pages/index.astro';
    path = path.replace(/\/$/, '');
    return 'src/pages' + path + '.astro';
  }

  function notifyClassChange(el) {
    var current = Array.from(el.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    window.parent.postMessage({
      type: 'element-classes-changed',
      classes: current,
      originalClasses: originalClasses,
      sourceFile: el.getAttribute('data-astro-source-file') || '',
      sourceLine: parseInt(el.getAttribute('data-astro-source-line') || '0', 10) || 0,
      component: el.getAttribute('data-component') || '',
      closestComponent: findClosestComponent(el),
      pageFile: inferPageFile(),
      tag: el.tagName.toLowerCase(),
    }, '*');
  }

  function hideClassEditor() {
    if (previewClass && selectedEl) {
      selectedEl.classList.remove(previewClass);
      previewClass = null;
    }
    // Only revert classes if the panel was actually open (unsaved changes)
    if (classEditorPanel && selectedEl && originalClasses) {
      var current = Array.from(selectedEl.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
      current.forEach(function(c) { selectedEl.classList.remove(c); });
      originalClasses.forEach(function(c) { selectedEl.classList.add(c); });
    }
    if (classEditorPanel) { classEditorPanel.remove(); classEditorPanel = null; }
    var oldDrop = document.getElementById('__phantom-class-dropdown');
    if (oldDrop) oldDrop.remove();
    // Hide CSS popup if visible
    var popup = document.getElementById('__phantom-css-popup');
    if (popup) popup.remove();
  }

  function enableInspector() {
    if (inspectorActive) return;
    inspectorActive = true;

    overlay = document.createElement('div');
    overlay.id = '__phantom-inspector-overlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);transition:all 0.05s ease-out;display:none;';
    document.body.appendChild(overlay);

    label = document.createElement('div');
    label.id = '__phantom-inspector-label';
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font-family:ui-monospace,monospace;font-size:11px;line-height:1;padding:3px 6px;background:#3b82f6;color:#fff;border-radius:3px;white-space:nowrap;display:none;';
    document.body.appendChild(label);

    dims = document.createElement('div');
    dims.id = '__phantom-inspector-dims';
    dims.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font-family:ui-monospace,monospace;font-size:10px;line-height:1;padding:2px 5px;background:#1e293b;color:#94a3b8;border-radius:2px;white-space:nowrap;display:none;';
    document.body.appendChild(dims);

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = 'pointer';
  }

  function disableInspector() {
    if (!inspectorActive) return;
    inspectorActive = false;
    currentTarget = null;
    hideClassEditor();
    selectedEl = null;
    if (overlay) { overlay.remove(); overlay = null; }
    if (label) { label.remove(); label = null; }
    if (dims) { dims.remove(); dims = null; }
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = '';
  }

  function selectParent() {
    if (!selectedEl) return;
    var parent = selectedEl.parentElement;
    while (parent && (parent === document.body || parent === document.documentElement)) {
      parent = parent.parentElement;
    }
    if (!parent || parent === document.body || parent === document.documentElement) return;
    selectedEl = parent;
    originalClasses = Array.from(parent.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    updateOverlay(parent);
    var data = buildElementData(parent);
    data.type = 'element-inspector-select';
    window.parent.postMessage(data, '*');
  }

  function selectChild() {
    if (!selectedEl) return;
    var child = selectedEl.firstElementChild;
    while (child && (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || (child.id && child.id.indexOf('__phantom') === 0))) {
      child = child.nextElementSibling;
    }
    if (!child) return;
    selectedEl = child;
    originalClasses = Array.from(child.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    updateOverlay(child);
    var data = buildElementData(child);
    data.type = 'element-inspector-select';
    window.parent.postMessage(data, '*');
  }

  function selectContainer() {
    if (!selectedEl) return;
    var node = selectedEl.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      var hasId = !!node.id && node.id.indexOf('__phantom') === -1;
      var hasComponent = !!node.getAttribute('data-component');
      var clsCount = Array.from(node.classList).filter(function(c) { return c.indexOf('__phantom') === -1; }).length;
      if (hasId || hasComponent || clsCount >= 3) break;
      node = node.parentElement;
    }
    if (!node || node === document.body || node === document.documentElement) return;
    selectedEl = node;
    originalClasses = Array.from(node.classList).filter(function(c) { return c.indexOf('__phantom') === -1; });
    updateOverlay(node);
    var data = buildElementData(node);
    data.type = 'element-inspector-select';
    window.parent.postMessage(data, '*');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && classEditorPanel) hideClassEditor();
    // Parent/child navigation: only when inspector active, element selected, no input focused
    if (!inspectorActive || !selectedEl) return;
    if (classEditorPanel) return;
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); selectParent(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectChild(); }
  }

  // ---- Component Outlines ----
  var outlineStyleEl = null;
  var outlineLabels = [];

  function showComponentOutlines() {
    if (outlineStyleEl) return;
    outlineStyleEl = document.createElement('style');
    outlineStyleEl.id = '__phantom-component-outlines';
    outlineStyleEl.textContent = '[data-component]{outline:2px dashed rgba(74,222,128,0.45);outline-offset:-2px;position:relative;}[data-component*="/layouts/"]{outline-color:rgba(251,146,60,0.45);}';
    document.head.appendChild(outlineStyleEl);
    createOutlineLabels();
  }

  function createOutlineLabels() {
    removeOutlineLabels();
    var elements = document.querySelectorAll('[data-component]');
    elements.forEach(function(el) {
      var comp = el.getAttribute('data-component');
      if (!comp) return;
      var isLayout = comp.indexOf('/layouts/') !== -1;
      var displayName = comp.split('/').pop().replace('.astro', '');

      var lbl = document.createElement('div');
      lbl.className = '__phantom-outline-label';
      lbl.textContent = displayName;
      lbl.style.cssText = 'position:absolute;top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1;padding:3px 7px;color:#fff;border-radius:3px;z-index:2147483646;white-space:nowrap;cursor:pointer;transition:filter 0.1s;' + (isLayout ? 'right:2px;background:rgba(251,146,60,0.9);' : 'left:2px;background:rgba(74,222,128,0.9);color:#052e16;');
      lbl.setAttribute('data-phantom-component-path', comp);

      lbl.addEventListener('mouseenter', function() { lbl.style.filter = 'brightness(1.2)'; });
      lbl.addEventListener('mouseleave', function() { lbl.style.filter = ''; });
      lbl.addEventListener('click', function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.parent.postMessage({ type: 'component-outline-click', componentPath: comp }, '*');
      });

      var computedPos = window.getComputedStyle(el).position;
      if (computedPos === 'static') el.style.position = 'relative';
      el.appendChild(lbl);
      outlineLabels.push(lbl);
    });
  }

  function removeOutlineLabels() {
    outlineLabels.forEach(function(lbl) { if (lbl.parentNode) lbl.parentNode.removeChild(lbl); });
    outlineLabels = [];
  }

  function hideComponentOutlines() {
    removeOutlineLabels();
    if (outlineStyleEl) { outlineStyleEl.remove(); outlineStyleEl = null; }
  }

  // Listen for signals from the parent IDE
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'element-inspector-enable') enableInspector();
    if (e.data.type === 'element-inspector-disable') disableInspector();
    if (e.data.type === 'class-editor-enable') classEditorMode = true;
    if (e.data.type === 'class-editor-disable') { classEditorMode = false; hideClassEditor(); }
    if (e.data.type === 'component-outlines-enable') showComponentOutlines();
    if (e.data.type === 'component-outlines-disable') hideComponentOutlines();
    if (e.data.type === 'tailwind-classes' && Array.isArray(e.data.classes)) {
      twClasses = e.data.classes;
      twMap = {};
      twClasses.forEach(function(c) { if (c && c.name) twMap[c.name] = c; });
    }
    if (e.data.type === 'select-parent') selectParent();
    if (e.data.type === 'select-child') selectChild();
    if (e.data.type === 'select-container') selectContainer();
  });
})();