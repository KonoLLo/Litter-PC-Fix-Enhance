window.FloatingSprite = window.FloatingSprite || {};

(function () {
  'use strict';

  var CONTAINER_ID = 'floating-sprite';
  var STORAGE_KEY  = 'floatingSprite.settings';
  var BASE_SIZE    = 256;
  var MIN_SCALE    = 0.5;
  var MAX_SCALE    = 1.0;

  var PET_MIN_SCALE = 0.5;
  var PET_MAX_SCALE = 1.0;

  // 默认遮罩参数
  var DEFAULT_PET_MASK = 128;
  var DEFAULT_PET_ROTATION = 0;

  // ==================== 状态 ====================
  FloatingSprite.DEFAULTS = {
    enabled: true,
    clickThrough: false,
    scale: 0.85,
    showBackground: false,
    petMask: DEFAULT_PET_MASK,
    petRotation: DEFAULT_PET_ROTATION,
    pos: { left: -1, top: -1 }
  };

  FloatingSprite.data = Object.assign({}, FloatingSprite.DEFAULTS, {
    pos: Object.assign({}, FloatingSprite.DEFAULTS.pos)
  });

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  FloatingSprite.loadSettings = function () {
    var data;
    try {
      var s = localStorage.getItem(STORAGE_KEY);
      data = Object.assign({}, FloatingSprite.DEFAULTS, s ? JSON.parse(s) : {});
    } catch (e) {
      data = Object.assign({}, FloatingSprite.DEFAULTS);
    }
    data.scale = clamp(+data.scale || 0.85, MIN_SCALE, MAX_SCALE);
    data.petMask = clamp(parseInt(data.petMask, 10) || DEFAULT_PET_MASK, 18, 128);
    data.petRotation = clamp(parseInt(data.petRotation, 10) || DEFAULT_PET_ROTATION, -90, 90);
    data.showBackground = !!data.showBackground;
    data.clickThrough = !!data.clickThrough;
    if (!data.pos || typeof data.pos !== 'object') data.pos = { left: -1, top: -1 };
    FloatingSprite.data = data;
  };

  FloatingSprite.saveSettings = function () {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(FloatingSprite.data)); } catch (e) {}
  };

  var saveDebounced = (function () {
    var timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(FloatingSprite.saveSettings, 200);
    };
  })();

  // ==================== 运行时 ====================
  var container = null;
  var bgCanvas = null;
  var dragging = false;
  var dragMoved = false;
  var dragDownTime = 0;
  var dragStartX = 0, dragStartY = 0;
  var elStartX = 0, elStartY = 0;
  var syncId = null;

  var DRAG_THRESHOLD_PX = 3;
  var DRAG_THRESHOLD_MS = 180;

  // ==================== 框架桌宠 ====================
  function getPetContainer() {
    return document.getElementById('maplebirch-character-pet');
  }

  function getPetOptions() {
    try {
      var V = window.V;
      if (V && V.options && V.options.maplebirch
          && V.options.maplebirch.character
          && V.options.maplebirch.character.pet) {
        return V.options.maplebirch.character.pet;
      }
    } catch (e) {}
    return null;
  }

  function getPet() {
    try {
      var mb = window.maplebirch;
      if (mb && mb.char && mb.char.pet) return mb.char.pet;
    } catch (e) {}
    return null;
  }

  function callPetSync() {
    var pet = getPet();
    if (pet && typeof pet.sync === 'function') {
      try { pet.sync(); } catch (e) {}
    }
  }

  function applyToPet() {
    var el = getPetContainer();
    if (!el) return;

    var data = FloatingSprite.data;
    var wantPet = data.enabled && !data.showBackground;

    var opts = getPetOptions();
    if (opts) {
      opts.enabled = wantPet;
      opts.scale = clamp(data.scale, PET_MIN_SCALE, PET_MAX_SCALE);
      // ★ 直接使用我们保存的遮罩值
      opts.mask = data.petMask;
      opts.rotation = data.petRotation;
    }

    if (wantPet) {
      el.classList.remove('fs-hidden');
    } else {
      el.classList.add('fs-hidden');
    }

    el.classList.toggle('fs-locked', !!data.clickThrough);

    if (data.pos.left >= 0 && data.pos.top >= 0) {
      el.style.left = data.pos.left + 'px';
      el.style.top  = data.pos.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    callPetSync();
  }

  function syncPosFromPet() {
    var el = getPetContainer();
    if (!el) return;
    var left = parseInt(el.style.left, 10);
    var top  = parseInt(el.style.top, 10);
    if (isNaN(left) || isNaN(top)) return;
    if (FloatingSprite.data.pos.left === left
        && FloatingSprite.data.pos.top === top) return;
    FloatingSprite.data.pos.left = left;
    FloatingSprite.data.pos.top  = top;
    saveDebounced();
    FloatingSprite.updatePanelPos();
  }

  // ==================== 我们的 canvas ====================
  function createContainer() {
    if (container || !document.body) return;

    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.display = 'none';

    bgCanvas = document.createElement('canvas');
    bgCanvas.width = BASE_SIZE;
    bgCanvas.height = BASE_SIZE;
    container.appendChild(bgCanvas);

    document.body.appendChild(container);

    var size = currentSize();
    var pos = FloatingSprite.data.pos;
    var left = pos.left >= 0 ? pos.left : (window.innerWidth - size - 20);
    var top  = pos.top  >= 0 ? pos.top  : (window.innerHeight - size - 20);

    setPos(
      clamp(left, 0, Math.max(0, window.innerWidth  - size)),
      clamp(top,  0, Math.max(0, window.innerHeight - size))
    );
    FloatingSprite.data.pos.left = parseInt(container.style.left, 10) || 0;
    FloatingSprite.data.pos.top  = parseInt(container.style.top,  10) || 0;

    bindDrag();
    bindWheel();
  }

  function setPos(l, t) {
    if (!container) return;
    container.style.left = l + 'px';
    container.style.top  = t + 'px';
  }

  function currentSize() { return Math.round(BASE_SIZE * FloatingSprite.data.scale); }

  function applyAll() {
    if (!container) return;
    var data = FloatingSprite.data;

    if (data.enabled && data.showBackground) {
      container.style.display = 'block';
      container.style.transform = 'scale(' + data.scale + ')';
      container.classList.toggle('locked', !!data.clickThrough);

      var size = currentSize();
      var l = parseInt(container.style.left, 10) || 0;
      var t = parseInt(container.style.top,  10) || 0;
      setPos(
        clamp(l, 0, Math.max(0, window.innerWidth  - size)),
        clamp(t, 0, Math.max(0, window.innerHeight - size))
      );
      startSync();
    } else {
      container.style.display = 'none';
      stopSync();
    }

    applyToPet();
  }

  // ==================== 拖拽 + 穿透 ====================
  function bindDrag() {
    container.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove',   onTouchMove,  { passive: false });
    document.addEventListener('touchend',    onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
  }

  function canDrag() {
    var d = FloatingSprite.data;
    return !!container && d.enabled && !d.clickThrough && d.showBackground;
  }

  function startDrag(cx, cy) {
    if (!canDrag()) return;
    dragging = true;
    dragMoved = false;
    dragDownTime = Date.now();
    container.classList.add('dragging');
    dragStartX = cx; dragStartY = cy;
    elStartX = parseInt(container.style.left, 10) || 0;
    elStartY = parseInt(container.style.top,  10) || 0;
  }

  function moveDrag(cx, cy) {
    if (!dragging) return;
    var dx = cx - dragStartX;
    var dy = cy - dragStartY;
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) dragMoved = true;
    if (!dragMoved) return;
    var size = currentSize();
    var nx = clamp(elStartX + dx, 0, Math.max(0, window.innerWidth  - size));
    var ny = clamp(elStartY + dy, 0, Math.max(0, window.innerHeight - size));
    setPos(nx, ny);
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    container.classList.remove('dragging');
    var elapsed = Date.now() - dragDownTime;
    var isClick = !dragMoved && elapsed < DRAG_THRESHOLD_MS;

    if (dragMoved) {
      FloatingSprite.data.pos.left = parseInt(container.style.left, 10) || 0;
      FloatingSprite.data.pos.top  = parseInt(container.style.top,  10) || 0;
      FloatingSprite.saveSettings();
    } else if (isClick && FloatingSprite.data.clickThrough && e) {
      forwardClick(e);
    }
  }

  function forwardClick(e) {
    try {
      var x = e.clientX, y = e.clientY;
      var prev = container.style.pointerEvents;
      container.style.pointerEvents = 'none';
      var target = document.elementFromPoint(x, y);
      container.style.pointerEvents = prev;
      if (!target || target === container || container.contains(target)) return;
      var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
    } catch (err) {}
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (!FloatingSprite.data.enabled || !FloatingSprite.data.showBackground) return;
    startDrag(e.clientX, e.clientY);
    e.preventDefault();
  }
  function onMouseMove(e) { if (dragging) moveDrag(e.clientX, e.clientY); }
  function onMouseUp(e)   { endDrag(e); }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    if (!FloatingSprite.data.enabled || !FloatingSprite.data.showBackground) return;
    var t = e.touches[0];
    startDrag(t.clientX, t.clientY);
    e.preventDefault();
  }
  function onTouchMove(e) {
    if (!dragging || e.touches.length !== 1) return;
    var t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
    e.preventDefault();
  }
  function onTouchEnd(e) {
    var t = e.changedTouches && e.changedTouches[0];
    endDrag(t ? { clientX: t.clientX, clientY: t.clientY } : null);
  }

  // ==================== 滚轮缩放 ====================
  function bindWheel() {
    container.addEventListener('wheel', function (e) {
      var d = FloatingSprite.data;
      if (!d.enabled || d.clickThrough || !d.showBackground) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -0.05 : 0.05;
      d.scale = Math.round(clamp(d.scale + delta, MIN_SCALE, MAX_SCALE) * 20) / 20;
      saveDebounced();
      container.style.transform = 'scale(' + d.scale + ')';
      renderFrame();
      syncSliderUI();
    }, { passive: false });
  }

  function syncSliderUI() {
    var range = document.getElementById('fs-scale-range');
    if (range) range.value = FloatingSprite.data.scale;
    var val = document.getElementById('fs-scale-val');
    if (val) val.textContent = FloatingSprite.data.scale.toFixed(2);
  }

  // ==================== 渲染 ====================
  function isDrawable(el) {
    if (!el) return false;
    if (typeof HTMLCanvasElement !== 'undefined' && el instanceof HTMLCanvasElement) return true;
    if (typeof HTMLImageElement  !== 'undefined' && el instanceof HTMLImageElement)  return true;
    return false;
  }

  function renderFull() {
    if (!bgCanvas) return false;
    var src;
    try {
      if (window.V && window.V.passage === 'Start') {
        var startImg = document.querySelector('#startImg');
        var c = startImg && startImg.children[1];
        if (isDrawable(c)) src = c;
      }
    } catch (e) {}
    if (!src) {
      var list = document.getElementsByClassName('mainCanvas');
      for (var i = 0; i < list.length; i++) {
        if (isDrawable(list[i]) && list[i].width > 0 && list[i].height > 0) {
          src = list[i];
          break;
        }
      }
    }
    if (!src) return false;

    var ctx = bgCanvas.getContext('2d');
    if (!ctx) return false;
    try {
      if (bgCanvas.width !== src.width || bgCanvas.height !== src.height) {
        bgCanvas.width = src.width;
        bgCanvas.height = src.height;
      }
      ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      ctx.drawImage(src, 0, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderFrame() {
    if (FloatingSprite.data.showBackground) {
      return renderFull();
    }
    return false;
  }

  function startSync() {
    if (syncId) return;
    if (!FloatingSprite.data.enabled || !FloatingSprite.data.showBackground) return;

    function tick() {
      if (!FloatingSprite.data.enabled || !FloatingSprite.data.showBackground) {
        syncId = null;
        return;
      }
      renderFrame();
      syncId = requestAnimationFrame(tick);
    }
    syncId = requestAnimationFrame(tick);
  }

  function stopSync() {
    if (syncId) { cancelAnimationFrame(syncId); syncId = null; }
  }

  // ==================== 对外 setter ====================
  FloatingSprite.setEnabled = function (v) {
    FloatingSprite.data.enabled = !!v;
    FloatingSprite.saveSettings();
    if (!container) createContainer();
    applyAll();
    FloatingSprite.refreshPanel();
  };

  FloatingSprite.setClickThrough = function (v) {
    FloatingSprite.data.clickThrough = !!v;
    FloatingSprite.saveSettings();
    if (container) container.classList.toggle('locked', !!v);
    applyToPet();
    FloatingSprite.refreshPanel();
  };

  FloatingSprite.setShowBackground = function (v) {
    if (FloatingSprite.data.showBackground) {
      if (container) {
        var l = parseInt(container.style.left, 10);
        var t = parseInt(container.style.top, 10);
        if (!isNaN(l)) FloatingSprite.data.pos.left = l;
        if (!isNaN(t)) FloatingSprite.data.pos.top  = t;
      }
    } else {
      syncPosFromPet();
    }
    FloatingSprite.data.showBackground = !!v;
    FloatingSprite.saveSettings();

    if (FloatingSprite.data.showBackground) {
      if (!container) createContainer();
      if (container && FloatingSprite.data.pos.left >= 0) {
        setPos(FloatingSprite.data.pos.left, FloatingSprite.data.pos.top);
      }
    }

    if (container && bgCanvas) {
      var ctx = bgCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    }
    applyAll();
    renderFrame();
    FloatingSprite.refreshPanel();
  };

  FloatingSprite.setScale = function (v) {
    if (v == null || isNaN(v)) v = 1;
    FloatingSprite.data.scale = clamp(+v, MIN_SCALE, MAX_SCALE);
    FloatingSprite.saveSettings();
    if (container) container.style.transform = 'scale(' + FloatingSprite.data.scale + ')';
    applyToPet();
    syncSliderUI();
    renderFrame();
  };

  // ★ 新增：遮罩分割线
  FloatingSprite.setPetMask = function (v) {
    FloatingSprite.data.petMask = clamp(+v || 0, 18, 128);
    FloatingSprite.saveSettings();
    applyToPet();
    var val = document.getElementById('fs-mask-val');
    if (val) val.textContent = FloatingSprite.data.petMask;
  };

  // ★ 新增：遮罩旋转角度
  FloatingSprite.setPetRotation = function (v) {
    FloatingSprite.data.petRotation = clamp(+v || 0, -90, 90);
    FloatingSprite.saveSettings();
    applyToPet();
    var val = document.getElementById('fs-rotation-val');
    if (val) val.textContent = FloatingSprite.data.petRotation;
  };

  FloatingSprite.resetPos = function () {
    if (!container) createContainer();
    var size = currentSize();
    var newLeft = Math.max(0, window.innerWidth  - size - 20);
    var newTop  = Math.max(0, window.innerHeight - size - 20);

    if (container) setPos(newLeft, newTop);
    FloatingSprite.data.pos.left = newLeft;
    FloatingSprite.data.pos.top  = newTop;
    FloatingSprite.saveSettings();

    var petEl = getPetContainer();
    if (petEl) {
      petEl.style.left = newLeft + 'px';
      petEl.style.top  = newTop + 'px';
      petEl.style.right = 'auto';
      petEl.style.bottom = 'auto';
    }

    FloatingSprite.updatePanelPos();
  };

  FloatingSprite.updatePanelPos = function () {
    var el = document.getElementById('fs-pos-label');
    if (!el) return;
    var p = FloatingSprite.data.pos;
    el.textContent = 'X=' + p.left + ', Y=' + p.top;
  };

  FloatingSprite.refreshPanel = function () {
    try {
      var content = document.getElementById('customOverlayContent');
      if (!content) return;
      content.innerHTML = '';
      var wrapper = document.createElement('div');
      content.appendChild(wrapper);
      $(wrapper).wiki('<<floatingSpriteModSetting>>');
    } catch (e) {}
  };

  // ==================== 初始化 ====================
  function init() {
    if (!document.body) { setTimeout(init, 100); return; }

    FloatingSprite.loadSettings();
    createContainer();

    // 首次强制把框架桌宠的遮罩改为我们的值
    var opts = getPetOptions();
    if (opts) {
      opts.mask = FloatingSprite.data.petMask;
      opts.rotation = FloatingSprite.data.petRotation;
    }

    applyAll();

    // 定期从桌宠同步位置 + 强制覆盖框架选项
    setInterval(function () {
      if (!FloatingSprite.data.enabled) return;
      if (!FloatingSprite.data.showBackground) {
        syncPosFromPet();
        var opts2 = getPetOptions();
        if (opts2) {
          if (opts2.enabled !== true) {
            opts2.enabled = true;
            callPetSync();
          }
          var desiredScale = clamp(FloatingSprite.data.scale, PET_MIN_SCALE, PET_MAX_SCALE);
          if (opts2.scale !== desiredScale) {
            opts2.scale = desiredScale;
            callPetSync();
          }
          // 强制覆盖遮罩（防止用户在框架设置页调整）
          if (opts2.mask !== FloatingSprite.data.petMask) {
            opts2.mask = FloatingSprite.data.petMask;
            callPetSync();
          }
          if (opts2.rotation !== FloatingSprite.data.petRotation) {
            opts2.rotation = FloatingSprite.data.petRotation;
            callPetSync();
          }
        }
      }
    }, 500);

    $(document).on(':passagedisplay', function () {
      if (!container) createContainer();
      applyAll();
      FloatingSprite.updatePanelPos();
    });

    window.addEventListener('resize', function () {
      if (!container) return;
      var size = currentSize();
      var l = parseInt(container.style.left, 10) || 0;
      var t = parseInt(container.style.top,  10) || 0;
      setPos(
        clamp(l, 0, Math.max(0, window.innerWidth  - size)),
        clamp(t, 0, Math.max(0, window.innerHeight - size))
      );
    });
  }

  $(document).one(':storyready', init);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function () { if (!container) init(); }, 0);
  }

})();