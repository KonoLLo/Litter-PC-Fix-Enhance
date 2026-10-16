
(function () {
  'use strict';

  var VERSION = '1.8.4';
  var OPTION_KEY = 'litterpc';
  var LS_STATE = 'litterpc.settings';
  var SS_STATE = 'litterpc.settings';
  var LS_LEGACY = 'floatingSprite.settings';
  var LS_POS = 'litterpc.pet.position';
  var SS_POS = 'litterpc.pet.position';
  var LS_TAKEN_OVER = 'litterpc.frameworkPetTakenOver';
  var LS_PET_PREV = 'litterpc.frameworkPetPrev';

  var BASE = 256;
  var MIN_SCALE = 0.5;
  var MAX_SCALE = 1.5;

  var MIN_OPACITY = 0.1;
  var MAX_OPACITY = 1;

  var PET_MASK = 128;
  var PET_ROTATION = 0;
  var INSET_LEFT = 58;
  var INSET_RIGHT = 48;

  var MODE_CHAR = 'character';
  var MODE_BG = 'background';
  var CLIP_FULL = 'full';
  var CLIP_CLOSEUP = 'closeUp';
  var CLIP_MODEL = 'modelOnly';
  var CLIP_MIN = -100;
  var CLIP_MAX = 100;

  var MAX_RETRY = 30;
  var SLOW_RETRY_MS = 1000;
  var MAX_SLOW_RETRY = 60;
  var FRAME_MS = 1000 / 24;

  var WRAP_ID = 'litterpc-pet';
  var HOST_ID = 'litterpc-pet-host';
  var BG_ID = 'litterpc-bg';
  var FW_PET_ELEMENT_ID = 'maplebirch-character-pet';

  var DEFAULTS = {
    enabled: true,
    clickThrough: false,
    positionLocked: false,
    mode: MODE_CHAR,
    scale: 0.85,
    opacity: 1,
    clipRange: 0
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function readLS(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function readSS(key) {
    try {
      var raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeSS(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function sugarV() {
    var V = window.V;
    return V && typeof V === 'object' ? V : null;
  }

  function frameworkPet() {
    var mb = window.maplebirch;
    if (mb && mb.char && mb.char.pet && typeof mb.char.pet.render === 'function') {
      return mb.char.pet;
    }
    return null;
  }

  function frameworkAnimated() {
    var V = sugarV();
    return !!(V && V.options && V.options.sidebarAnimations);
  }

  function gameReady() {
    var R = window.Renderer;
    var S = window.setup;
    if (!R || !S) return true;
    var CM = R.CanvasModels;
    return !!(CM && (CM.pet || CM.main) && S.clothes);
  }

  function normalize(obj) {
    obj.enabled = obj.enabled !== false;
    obj.clickThrough = !!obj.clickThrough;

    if (Object.prototype.hasOwnProperty.call(obj, 'positionLocked')) {
      obj.positionLocked = !!obj.positionLocked;
    } else {
      obj.positionLocked = obj.clickThrough;
    }

    obj.mode = (obj.mode === MODE_BG || obj.showBackground) ? MODE_BG : MODE_CHAR;
    delete obj.showBackground;

    var s = Number(obj.scale);
    obj.scale = isFinite(s) ? clamp(s, MIN_SCALE, MAX_SCALE) : DEFAULTS.scale;

    var o = Number(obj.opacity);
    obj.opacity = isFinite(o) ? clamp(o, MIN_OPACITY, MAX_OPACITY) : DEFAULTS.opacity;

    var cr = Number(obj.clipRange);
    if (!isFinite(cr)) {
      if (obj.clip === CLIP_CLOSEUP || obj.closeUp) cr = INSET_LEFT;
      else if (obj.clip === CLIP_MODEL || obj.modelOnly) cr = -INSET_RIGHT;
      else {
        var pl = parseInt(obj.petClipLeft, 10) || 0;
        var pr = parseInt(obj.petClipRight, 10) || 0;
        cr = pl > 0 ? pl : (pr > 0 ? -pr : 0);
      }
    }
    obj.clipRange = clamp(Math.round(cr), CLIP_MIN, CLIP_MAX);

    delete obj.clip;
    delete obj.closeUp;
    delete obj.modelOnly;
    delete obj.petClipLeft;
    delete obj.petClipRight;

    delete obj._rev;
    return obj;
  }

  function isBg() { return state.mode === MODE_BG; }

  function snapshot() {
    var o = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = state[k];
    }
    return o;
  }

  function localState() {
    var stored = readLS(LS_STATE) || readSS(SS_STATE) || readLS(LS_LEGACY);
    if (!stored || typeof stored !== 'object') return null;
    return normalize(Object.assign({}, DEFAULTS, stored));
  }

  var state = normalize(Object.assign({}, DEFAULTS, localState() || readSaveSlot()));

  function hasSaveSettings(slot) {
    return !!(slot && typeof slot === 'object')
      && (Object.prototype.hasOwnProperty.call(slot, 'mode')
        || Object.prototype.hasOwnProperty.call(slot, 'showBackground'));
  }

  function readSaveSlot() {
    var V = sugarV();
    var slot = V && V.options && V.options[OPTION_KEY];
    return hasSaveSettings(slot) ? slot : null;
  }

  function bindState() {
    var V = sugarV();
    if (!V) return state;
    if (!V.options || typeof V.options !== 'object') V.options = {};

    var slot = V.options[OPTION_KEY];
    if (!slot || typeof slot !== 'object') {
      slot = {};
      V.options[OPTION_KEY] = slot;
    }

    var local = localState();
    if (local) Object.assign(state, local);

    if (!readLS(LS_STATE)) writeState(snapshot());
    noteExternalReset(slot);
    pushToSlot(slot);
    return state;
  }

  function adoptFromSave() {
    if (localState()) return false;
    var fromSave = readSaveSlot();
    if (!fromSave) return false;
    Object.assign(state, normalize(Object.assign({}, DEFAULTS, fromSave)));

    lastPushed = null;
    return true;
  }

  function pushToSlot(slot) {
    for (var k in slot) {
      if (Object.prototype.hasOwnProperty.call(slot, k) &&
          !Object.prototype.hasOwnProperty.call(DEFAULTS, k)) delete slot[k];
    }
    Object.assign(slot, snapshot());
    lastPushed = JSON.stringify(snapshotOf(slot));
  }

  var lastPushed = null;
  var lastReported = '';
  var fromPanel = false;
  function noteExternalReset(slot) {
    if (lastPushed === null || fromPanel) return;

    if (!hasSaveSettings(slot)) return;
    var current;
    try { current = JSON.stringify(snapshotOf(slot)); } catch (e) { return; }
    if (current === lastPushed || current === lastReported) return;
    lastReported = current;
    console.log('[小小PC] $options.litterpc 被外部改成 ' + current + '，已按本地设置盖回');
  }

  function snapshotOf(obj) {
    var o = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = obj[k];
    }
    return o;
  }

  function commit() {
    writeState(snapshot());
  }

  function writeState(snap) {
    writeLS(LS_STATE, snap);
    writeSS(SS_STATE, snap);
  }

  var POS_REF = 'canvas';

  function posLoad() {
    var p = readLS(LS_POS) || readSS(SS_POS);
    if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') {
      var legacy = readLS(LS_LEGACY);
      var lp = legacy && legacy.pos;
      p = (lp && typeof lp.left === 'number' && typeof lp.top === 'number') ? lp : null;
    }
    if (!p) return { left: null, top: null, ref: POS_REF, rescale: false };
    if (p.ref === POS_REF) return { left: p.left, top: p.top, ref: POS_REF, rescale: false };

    if (p.left < 0 || p.top < 0) return { left: null, top: null, ref: POS_REF, rescale: false };
    return { left: p.left, top: p.top, ref: POS_REF, rescale: true };
  }

  var pos = posLoad();
  writePos();
  var posTimer = null;

  function posKnown() {
    return typeof pos.left === 'number' && typeof pos.top === 'number';
  }

  function writePos() {
    var snap = { left: pos.left, top: pos.top };

    if (!pos.rescale) snap.ref = pos.ref;
    writeLS(LS_POS, snap);
    writeSS(SS_POS, snap);
  }

  function savePos() {
    posTimer = null;
    writePos();
  }

  function savePosSoon() {
    clearTimeout(posTimer);
    posTimer = setTimeout(savePos, 200);
  }

  var wrap = null, host = null, bgCanvas = null, bgCtx = null;
  var booted = false;
  var retryCount = 0;
  var slowRetryTimer = null;

  var forceRerender = false;
  var lastMainRef = null;
  var lastContentSig = null;
  var slowRetryCount = 0;
  var rafId = null, lastDraw = 0, lastSrc = null;

  var SIDEBAR_MACRO = 'updatesidebarimg';
  var SIDEBAR_MAX_TRIES = 20;
  var sidebarInstalled = false;
  var sidebarOriginal = null;
  var sidebarRunning = false;
  var sidebarTimer = null;
  var sidebarTries = 0;


  var sidebarHookHits = 0;
  var liveFrame = 0;

  var sidebarObserver = null;
  var sidebarReCaptureFrame = 0;

  function displayedSize() { return Math.round(BASE * state.scale); }

  function displayedDims() {
    if (isBg()) {
      if (bgCanvas && bgCanvas.width > 0 && bgCanvas.height > 0) {
        return {
          w: Math.max(1, Math.round(bgCanvas.width * state.scale)),
          h: Math.max(1, Math.round(bgCanvas.height * state.scale))
        };
      }
    } else {
      var crop = petCrop();
      if (crop) return { w: crop.w, h: crop.h };
    }
    var s = displayedSize();
    return { w: s, h: s };
  }

  var NO_ANCHOR = { x: 0, y: 0 };

  function contentAnchor() {
    if (isBg()) {
      var b = bgState.box;

      if (!b) return NO_ANCHOR;
      return { x: Math.round(b.x * state.scale), y: Math.round(b.y * state.scale) };
    }
    var crop = petCrop();

    if (crop) return { x: -crop.left, y: -crop.top };
    return NO_ANCHOR;
  }

  function ensureShell() {
    if (!document.body) return false;

    if (!wrap || !wrap.isConnected) {
      wrap = document.getElementById(WRAP_ID) || document.createElement('div');
      wrap.id = WRAP_ID;

      host = document.getElementById(HOST_ID) || document.createElement('div');
      host.id = HOST_ID;

      bgCanvas = document.getElementById(BG_ID) || document.createElement('canvas');
      bgCanvas.id = BG_ID;
      bgCanvas.width = BASE;
      bgCanvas.height = BASE;
      bgCtx = bgCanvas.getContext ? bgCanvas.getContext('2d') : null;

      wrap.textContent = '';
      wrap.appendChild(bgCanvas);
      wrap.appendChild(host);
      document.body.appendChild(wrap);
      bindDrag();
    }
    return true;
  }

  function applyClip() {
    if (!host) return;
    var v = Math.round(clamp(state.clipRange, CLIP_MIN, CLIP_MAX));
    var l = v > 0 ? v : 0;
    var r = v < 0 ? -v : 0;
    host.style.clipPath = (l || r) ? 'inset(0 ' + r + '% 0 ' + l + '%)' : '';

    var crop = isBg() ? null : petCrop();
    host.style.left = crop ? crop.left + 'px' : '0px';
    host.style.top = crop ? crop.top + 'px' : '0px';

    if (!isBg()) {
      var s = displayedSize();
      host.style.width = s + 'px';
      host.style.height = s + 'px';
      var cv = petCanvasEl();
      if (cv) {
        cv.style.width = s + 'px';
        cv.style.height = s + 'px';
        cv.style.imageRendering = state.scale > 1 ? 'pixelated' : 'auto';
      }
    }
  }

  function applyPresentation() {
    if (!wrap) return;
    var dims = displayedDims();
    rescalePos();

    wrap.style.width = dims.w + 'px';
    wrap.style.height = dims.h + 'px';
    wrap.style.display = (state.enabled && contentReady()) ? 'block' : 'none';
    wrap.style.opacity = state.opacity;
    wrap.classList.toggle('litterpc-passthru', !!state.clickThrough);

    host.style.display = isBg() ? 'none' : 'block';
    bgCanvas.style.display = isBg() ? 'block' : 'none';
    bgCanvas.style.width = dims.w + 'px';
    bgCanvas.style.height = dims.h + 'px';

    var p = renderPos();
    wrap.style.left = p.left + 'px';
    wrap.style.top = p.top + 'px';

    applyClip();
    updatePosLabels(p);
  }

  function rescalePos() {
    if (!pos.rescale) return;
    var a = contentAnchor();

    if (!a.x && !a.y) return;
    pos.left -= a.x;
    pos.top -= a.y;
    pos.rescale = false;
    writePos();
  }

  function renderPos() {
    var d = displayedDims(), w = d.w, h = d.h;
    var a = contentAnchor();
    var l = pos.left, t = pos.top;
    if (!posKnown()) {

      l = window.innerWidth - w - a.x - 20;
      t = window.innerHeight - h - a.y - 20;
    }
    return {
      left: clamp(l + a.x, 0, Math.max(0, window.innerWidth - w)),
      top: clamp(t + a.y, 0, Math.max(0, window.innerHeight - h))
    };
  }

  function relinquishPet(pet) {
    try {
      pet.container = null;
      pet.canvas = undefined;
      pet.model = undefined;
    } catch (e) {}
  }

  function stopHostAnimation() {
    if (!host) return;
    var c = host.querySelector('canvas');
    var R = window.Renderer;
    if (!c || !R || typeof R.getAnimatingCanvas !== 'function') return;
    try {
      var anim = R.getAnimatingCanvas(c.getContext('2d'));
      if (anim && typeof anim.stop === 'function') anim.stop();
    } catch (e) {}
  }

  function invalidatePetCapture() {
    try {
      var CM = window.Renderer && window.Renderer.CanvasModels;

      if (CM && CM.pet) CM.pet = null;
    } catch (e) {}
  }

  var petCapturePatched = false;
  var petLayerRepairs = [];





  function isShallowOverwrite(def, patched) {
    if (!def || !patched || def === patched) return false;
    var dk = Object.keys(def);
    var pk = Object.keys(patched);
    if (pk.length === 0 || pk.length >= dk.length) return false;
    for (var i = 0; i < pk.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(def, pk[i])) return false;
    }
    return true;
  }



  function repairCapturedPetLayers(mainModel) {
    var CM = window.Renderer && window.Renderer.CanvasModels;
    var captured = CM && CM.pet;
    var defs = mainModel && mainModel.layers;
    if (!captured || !captured.layers || !defs) return;
    var names = Object.keys(captured.layers);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      var patched = captured.layers[k];
      if (!isShallowOverwrite(defs[k], patched)) continue;
      captured.layers[k] = Object.assign({}, defs[k], patched);
      if (petLayerRepairs.indexOf(k) < 0) petLayerRepairs.push(k);
    }
  }

  function ensurePetCapturePatch() {
    if (petCapturePatched) return;
    var pet = frameworkPet();
    if (!pet || typeof pet.capture !== 'function') return;
    var orig = pet.capture;
    try {
      pet.capture = function (mainModel) {
        orig.call(this, mainModel);
        try { repairCapturedPetLayers(mainModel); } catch (e) {}
      };
      petCapturePatched = true;
    } catch (e) {}
  }

  var SIDEBAR_CANVAS_SEL = '#sidebar-img-container canvas.mainCanvas';
  var FOLLOW_MARK = '__litterpcFollowListener';
  var followPatched = false;
  var followOriginal = null;
  var followEvents = 0;
  var followDraws = 0;
  var followLast = null;



  var FOLLOW_WATCH_MS = 200;
  var FOLLOW_OK_WATCH_MS = 1000;


  var FOLLOW_IDLE_WATCH_MS = 2000;
  var followLastAt = 0;
  var followWatchTimer = null;
  var followPrimeResult = null;
  var followStallEpisodes = 0;
  var followStalling = false;
  var followIdleWatches = 0;
  var followHeals = 0;
  var followHealAt = 0;
  var FOLLOW_HEAL_MS = 2000;
  var sidebarAnimCalls = 0;
  var sidebarAnimWrapped = 0;
  var sidebarAnimMissed = 0;

  function followWanted() {
    return booted && !isBg() && state.enabled && frameworkAnimated();
  }

  function isSidebarTarget(ctx) {
    if (!ctx || !ctx.canvas) return false;
    var cv = ctx.canvas;
    if (!cv.classList || !cv.classList.contains('mainCanvas')) return false;
    var sb = document.getElementById('sidebar-img-container');
    if (!sb || !sb.contains(cv)) return false;
    if (wrap && wrap.contains(cv)) return false;
    return true;
  }

  function animatingCanvasOf(canvas) {
    var R = window.Renderer;
    if (!canvas || !R || typeof R.getAnimatingCanvas !== 'function') return null;
    try { return R.getAnimatingCanvas(canvas.getContext('2d')); } catch (e) { return null; }
  }

  function ourAnimatingCanvas() {
    if (!host) return null;
    return animatingCanvasOf(host.querySelector('canvas'));
  }

  function sidebarAnimatingCanvas() {
    return animatingCanvasOf(document.querySelector(SIDEBAR_CANVAS_SEL));
  }

  function freezeOurAnimation() {
    var ac = ourAnimatingCanvas();
    if (!ac || !ac.animations) return;
    for (var i = 0; i < ac.animations.length; i++) {
      var a = ac.animations[i];
      if (a.timeoutId) { clearTimeout(a.timeoutId); a.timeoutId = 0; }
    }
  }

  function applyKeyframeToLayers(layers, kf) {
    if (!layers || !kf) return;
    var props = (window.Renderer && window.Renderer.AnimatableProps) || [];
    for (var i = 0; i < layers.length; i++) {
      var ly = layers[i];
      if (!ly) continue;
      if (kf.frame !== undefined) ly.frames = [kf.frame];
      if (kf.dx !== undefined) ly.frameDx = kf.dx;
      if (kf.dy !== undefined) ly.frameDy = kf.dy;
      for (var j = 0; j < props.length; j++) {
        var p = props[j];
        if (p !== 'dx' && p !== 'dy' && kf[p] !== undefined) ly[p] = kf[p];
      }
    }
  }

  function findAnimation(ac, name) {
    if (!ac || !ac.animations) return null;
    for (var i = 0; i < ac.animations.length; i++) {
      if (ac.animations[i].name === name) return ac.animations[i];
    }
    return null;
  }

  function mirrorFrame(our, name, index, keyframe) {
    if (!our || !our.animations) return;
    var a = findAnimation(our, name);
    if (!a) return;
    var kfCount = (a.keyframes && a.keyframes.length) || 0;
    a.keyframeIndex = kfCount > 0 ? (index % kfCount) : index;
    a.keyframe = keyframe;
    if (a.layers) applyKeyframeToLayers(a.layers, keyframe);
  }

  function primeFromSidebar() {
    var sb = sidebarAnimatingCanvas();
    var our = ourAnimatingCanvas();
    if (!sb) { followPrimeResult = 'no-sidebar-animating-canvas'; return followPrimeResult; }
    if (!our) { followPrimeResult = 'no-our-animating-canvas'; return followPrimeResult; }
    if (!sb.animations || !our.animations) { followPrimeResult = 'no-animations-list'; return followPrimeResult; }
    var mirrored = 0;
    for (var i = 0; i < sb.animations.length; i++) {
      var sa = sb.animations[i];
      if (sa.keyframe !== undefined) {
        mirrorFrame(our, sa.name, sa.keyframeIndex || 0, sa.keyframe);
        mirrored++;
      }
    }
    try { if (typeof our.redraw === 'function') our.redraw(); } catch (e) {}
    followPrimeResult = 'mirrored ' + mirrored + '/' + sb.animations.length;
    return followPrimeResult;
  }

  function sidebarHasAnimations() {
    var sb = sidebarAnimatingCanvas();
    return !!(sb && sb.animations && sb.animations.length);
  }



  function followAnimHealthy() {
    if (!followWanted()) return true;
    if (!sidebarHasAnimations()) return true;
    return !!ourAnimatingCanvas();
  }


  function followFramesMatched() {
    var sb = sidebarAnimatingCanvas();
    if (!sb || !sb.animations || !sb.animations.length) return false;
    var our = ourAnimatingCanvas();
    if (!our || !our.animations) return false;
    for (var i = 0; i < sb.animations.length; i++) {
      var sa = sb.animations[i];
      var oa = findAnimation(our, sa.name);
      if (!oa) return false;
      if ((oa.keyframeIndex || 0) !== (sa.keyframeIndex || 0)) return false;
    }
    return true;
  }

  function startFollowWatchdog(delay) {
    if (followWatchTimer || !followWanted()) return;
    followWatchTimer = setTimeout(followWatchdogTick, delay || FOLLOW_WATCH_MS);
  }

  function followWatchdogTick() {
    followWatchTimer = null;
    if (!followWanted()) return;

    if (!sidebarHasAnimations()) {
      followStalling = false;
      followIdleWatches++;
      startFollowWatchdog(FOLLOW_IDLE_WATCH_MS);
      return;
    }

    if (!ourAnimatingCanvas()) {


      followStalling = true;
      if (Date.now() - followHealAt > FOLLOW_HEAL_MS) {
        followHealAt = Date.now();
        followHeals++;
        forceRerender = true;
        queueLiveRender();
      }
      startFollowWatchdog(FOLLOW_WATCH_MS);
      return;
    }

    if (followFramesMatched()) {
      followStalling = false;
      startFollowWatchdog(FOLLOW_OK_WATCH_MS);
      return;
    }

    if (!followStalling) {
      followStalling = true;
      followStallEpisodes++;
    }
    primeFromSidebar();
    startFollowWatchdog();
  }

  function followListener(orig) {
    if (!orig || orig[FOLLOW_MARK]) return orig;
    var clone = {};
    var keys = Object.keys(orig);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'keyframe') continue;
      if (typeof orig[k] === 'function') {
        (function (key) {
          clone[key] = function () { return orig[key].apply(orig, arguments); };
        })(k);
      } else {
        clone[k] = orig[k];
      }
    }
    clone.keyframe = function (name, index, keyframe) {

      try {
        if (followWanted()) {
          var our = ourAnimatingCanvas();
          if (our) {
            mirrorFrame(our, name, index, keyframe);
            followEvents++;
            followLastAt = Date.now();
            if (typeof our.redraw === 'function') { our.redraw(); followDraws++; }
            followLast = name + '#' + index;
          }
        }
      } catch (e) {}
      if (typeof orig.keyframe === 'function') {
        return orig.keyframe.apply(orig, arguments);
      }
    };
    clone[FOLLOW_MARK] = true;
    return clone;
  }

  function ensureFollowPatch() {
    if (followPatched) return;
    var R = window.Renderer;
    if (!R || typeof R.animateLayers !== 'function') return;
    followOriginal = R.animateLayers;
    R.animateLayers = function (ctx, layerSpecs, listener, autoStop) {
      var l = listener;
      if (isSidebarTarget(ctx)) {
        sidebarAnimCalls++;
        if (followWanted()) {
          l = followListener(listener);
          if (l !== listener) sidebarAnimWrapped++;
        } else {
          sidebarAnimMissed++;
        }
      }
      return followOriginal.call(this, ctx, layerSpecs, l, autoStop);
    };
    followPatched = true;
  }

  function sidebarCanvasCensus() {
    var box = document.getElementById('sidebar-img-container');
    if (!box) return null;
    var list = box.querySelectorAll('canvas.mainCanvas');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ac = animatingCanvasOf(list[i]);
      out.push(i + ':' + (ac ? (animFrameStr(ac) || 'no-anim') : 'not-registered'));
    }
    return out;
  }

  function ourCanvasCensus() {
    if (!host) return null;
    var list = host.querySelectorAll('canvas');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ac = animatingCanvasOf(list[i]);
      out.push(i + ':' + (ac ? (animFrameStr(ac) || 'no-anim') : 'not-registered'));
    }
    return out;
  }

  function animFrameStr(ac) {
    if (!ac || !ac.animations) return null;
    var parts = [];
    for (var i = 0; i < ac.animations.length; i++) {
      var a = ac.animations[i];
      parts.push(a.name + '#' + (a.keyframeIndex || 0));
    }
    return parts.join(',');
  }

  function macroRegistry() {
    var SC = window.SugarCube;
    var M = (SC && SC.Macro) || window.Macro;
    if (!M || typeof M.add !== 'function' || typeof M.has !== 'function' ||
        typeof M.get !== 'function' || typeof M.delete !== 'function') return null;
    return M;
  }

  function sidebarWrapperFn() {
    var result;
    sidebarHookHits++;

    if (sidebarRunning) { queueLiveRender(); return result; }
    sidebarRunning = true;
    try {
      if (sidebarOriginal) result = sidebarOriginal.apply(this, arguments);
    } finally {

      sidebarRunning = false;
      queueLiveRender();
    }
    return result;
  }

  function sidebarTopHandler(M) {
    var def = null;
    try { def = M.has(SIDEBAR_MACRO) ? M.get(SIDEBAR_MACRO) : null; } catch (e) {}
    return def && typeof def.handler === 'function' ? def.handler : null;
  }

  function installSidebarHook(M, def, original) {
    try {
      sidebarOriginal = original;
      if (M.has(SIDEBAR_MACRO)) M.delete(SIDEBAR_MACRO);
      M.add(SIDEBAR_MACRO, Object.assign({}, def, { handler: sidebarWrapperFn }));
    } catch (e) {

      try { M.add(SIDEBAR_MACRO, def); } catch (e2) {}
      sidebarOriginal = null;
      return false;
    }
    if (sidebarTopHandler(M) !== sidebarWrapperFn) {
      try { M.delete(SIDEBAR_MACRO); M.add(SIDEBAR_MACRO, def); } catch (e3) {}
      sidebarOriginal = null;
      return false;
    }
    sidebarInstalled = true;

    stopWatchSidebarCanvas();
    return true;
  }

  function onSidebarCanvasMutated(mutations) {
    if (!booted || isBg() || !state.enabled) return;

    if (sidebarInstalled) return;
    var hit = false;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type !== 'childList') continue;
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j];
        if (node && node.nodeType === 1) {
          if (node.classList && node.classList.contains('mainCanvas')) { hit = true; break; }
          if (node.querySelector && node.querySelector('.mainCanvas')) { hit = true; break; }
        }
      }
      if (hit) break;
    }
    if (!hit) return;

    if (sidebarReCaptureFrame) return;
    sidebarReCaptureFrame = requestAnimationFrame(function () {
      sidebarReCaptureFrame = 0;
      if (!booted || isBg() || !state.enabled || sidebarInstalled) return;

      requestAnimationFrame(function () {
        if (!booted || isBg() || !state.enabled) return;
        resolveFrameworkPet();
        if (renderCharacter()) applyPresentation();
      });
    });
  }

  function watchSidebarCanvas() {
    if (sidebarObserver || !document.body) return;
    sidebarObserver = new MutationObserver(onSidebarCanvasMutated);
    sidebarObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopWatchSidebarCanvas() {
    if (sidebarObserver) { sidebarObserver.disconnect(); sidebarObserver = null; }
    if (sidebarReCaptureFrame) { cancelAnimationFrame(sidebarReCaptureFrame); sidebarReCaptureFrame = 0; }
  }

  function ensureSidebarHook() {
    var M = macroRegistry();
    if (!M) return;

    var def = null;
    try { if (M.has(SIDEBAR_MACRO)) def = M.get(SIDEBAR_MACRO); } catch (e) {}

    if (!def || typeof def.handler !== 'function') {
      if (sidebarTries < SIDEBAR_MAX_TRIES) {
        sidebarTries++;
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(ensureSidebarHook, 500);
      }
      return;
    }

    if (def.handler === sidebarWrapperFn) { sidebarInstalled = true; stopWatchSidebarCanvas(); return; }
    if (sidebarInstalled) return;
    installSidebarHook(M, def, def.handler);
  }

  function queueLiveRender() {
    if (!booted || isBg() || !state.enabled || !host) return;
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(function () {
      liveFrame = 0;
      if (!booted || isBg() || !state.enabled) return;

      resolveFrameworkPet();

      if (renderCharacter()) applyPresentation();
    });
  }

  var GAME_SYNC_AT = [500, 2000, 5000, 10000, 20000, 30000];
  var gameSyncTimers = [];
  var entryPassages = 0;

  function triggerSidebarRebuild() {
    try {
      if (typeof Wikifier !== 'undefined' && typeof Wikifier.wikifyEval === 'function') {
        Wikifier.wikifyEval('<<updatesidebarimg true>>');
      }
    } catch (e) {}
  }

  var syncRebuildCount = 0;
  var MAX_SYNC_REBUILDS = 3;

  function resyncToGame() {
    if (!booted || isBg() || !state.enabled) return;
    resetRetryBudget();

    if (!characterMounted()) forceRerender = true;
    if (syncRebuildCount < MAX_SYNC_REBUILDS) {
      syncRebuildCount++;
      triggerSidebarRebuild();
    }
    requestAnimationFrame(function () {
      apply();
    });
  }

  function clearGameSync() {
    for (var i = 0; i < gameSyncTimers.length; i++) clearTimeout(gameSyncTimers[i]);
    gameSyncTimers.length = 0;
  }

  function scheduleGameSync() {
    clearGameSync();
    for (var i = 0; i < GAME_SYNC_AT.length; i++) {
      (function (delay) {
        var id = setTimeout(function () {
          var at = gameSyncTimers.indexOf(id);
          if (at >= 0) gameSyncTimers.splice(at, 1);
          resyncToGame();
        }, delay);
        gameSyncTimers.push(id);
      })(GAME_SYNC_AT[i]);
    }
  }

  function sidebarCacheOptions() {
    try {
      var C = window.Renderer && window.Renderer.CanvasModelCaches;
      return (C && C.main && C.main.sidebar && C.main.sidebar.options) || null;
    } catch (e) { return null; }
  }

  function valueDigest(v, depth, seen) {
    if (v === null || v === undefined) return '';
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return String(v);
    if (t !== 'object') return t;
    if (depth <= 0 || seen.indexOf(v) >= 0) {
      return Array.isArray(v) ? '#' + v.length : '{' + Object.keys(v).length + '}';
    }
    seen.push(v);
    var out;
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length && i < 24; i++) a.push(valueDigest(v[i], depth - 1, seen));
      out = '[' + (v.length > 24 ? v.length + '~' : '') + a.join(',') + ']';
    } else {
      var keys = Object.keys(v);
      keys.sort();
      var p = [];
      for (var j = 0; j < keys.length; j++) p.push(keys[j] + ':' + valueDigest(v[keys[j]], depth - 1, seen));
      out = '{' + p.join(',') + '}';
    }
    seen.pop();
    return out;
  }





  function contentSignature() {
    var o = sidebarCacheOptions();
    if (!o) return null;
    var keys = Object.keys(o);
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'generatedLayers') continue;
      parts.push(k + ':' + valueDigest(o[k], 3, []));
    }
    return parts.join(',');
  }

  function renderCharacter() {
    var pet = frameworkPet();
    if (!pet) { scheduleRetry(); return false; }

    ensurePetCapturePatch();

    if (!gameReady()) { scheduleRetry(); return false; }

    if (!sidebarCacheOptions()) { scheduleRetry(); return false; }

    var currentMain = (window.Renderer && window.Renderer.CanvasModels && window.Renderer.CanvasModels.main) || null;
    var currentSig = contentSignature();


    if (characterMounted() && followAnimHealthy() && !forceRerender &&
        currentMain === lastMainRef && currentSig === lastContentSig) return true;
    stopHostAnimation();
    invalidatePetCapture();



    var ok = false;
    try {
      ok = pet.render(host, {
        floating: false,
        animated: frameworkAnimated(),
        mask: PET_MASK,
        rotation: PET_ROTATION,
        scale: state.scale
      });
    } catch (e) { ok = false; }

    if (ok) {
      lastMainRef = currentMain;
      lastContentSig = currentSig;
      forceRerender = false;

      clearRetry();
      resetRetryBudget();

      relinquishPet(pet);

      host.style.display = 'block';
      applyClip();

      petState.at = 0;
      refreshPetBox();

      freezeOurAnimation();
      requestAnimationFrame(function () {
        freezeOurAnimation();
        primeFromSidebar();
        followLastAt = Date.now();
        startFollowWatchdog();
      });
    } else {
      scheduleRetry();
    }
    return ok;
  }

  var retryPending = false;

  function clearRetry() {
    clearTimeout(slowRetryTimer);
    retryPending = false;
  }

  function scheduleRetry() {
    if (retryPending) return;
    retryPending = true;
    if (retryCount >= MAX_RETRY) {
      if (slowRetryCount >= MAX_SLOW_RETRY) { retryPending = false; return; }
      slowRetryTimer = setTimeout(function () {
        retryPending = false;
        slowRetryCount++;
        if (!needsCharacter()) return;
        if (renderCharacter()) applyPresentation();
      }, SLOW_RETRY_MS);
      return;
    }
    retryCount++;
    requestAnimationFrame(function () {
      retryPending = false;
      if (!needsCharacter()) return;
      if (renderCharacter()) applyPresentation();
    });
  }

  function resetRetryBudget() {
    retryCount = 0;
    slowRetryCount = 0;
  }

  function needsCharacter() {
    if (!booted || isBg() || !state.enabled) return false;

    if (!window.maplebirch) return false;
    return !characterMounted();
  }

  function characterMounted() {
    return !!(host && host.querySelector('canvas'));
  }

  function contentReady() {
    return isBg() ? !!lastSrc : characterMounted();
  }

  function isDrawable(el) {
    return el instanceof HTMLCanvasElement || el instanceof HTMLImageElement;
  }

  var BG_ALPHA_MIN = 8;
  var BG_BOX_MS = 500;

  var BG_BOX_FIRST_MS = 120;
  var BG_BOX_FIRST_TRIES = 4;
  var BG_SHRINK_STREAK = 2;
  var BG_MIN_SIDE = 8;

  function makeBoxState() { return { box: null, pending: null, pendingN: 0, at: 0, srcW: 0, srcH: 0, measured: false }; }
  function resetBox(st) {
    st.box = null; st.pending = null; st.pendingN = 0; st.at = 0;
    st.srcW = 0; st.srcH = 0; st.measured = false;
  }

  var bgState = makeBoxState();
  var petState = makeBoxState();
  var fullCanvas = null, fullCtx = null;
  var lastSrcW = 0, lastSrcH = 0;

  function pickSource() {
    var V = sugarV();
    if (V && V.passage === 'Start') {
      var startImg = document.getElementById('startImg');
      var c = startImg && startImg.children[1];
      if (isDrawable(c)) return c;
    }
    var list = document.getElementsByClassName('mainCanvas');
    for (var i = 0; i < list.length; i++) {
      if (isDrawable(list[i]) && list[i].width > 0 && list[i].height > 0) return list[i];
    }
    return null;
  }

  function measureBox(ctx, w, h) {
    var d;
    try { d = ctx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    var minx = w, miny = h, maxx = -1, maxy = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w * 4, hit = false;
      for (var x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] >= BG_ALPHA_MIN) {
          hit = true;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
        }
      }
      if (hit) {
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
    if (maxx < 0 || maxx - minx + 1 < BG_MIN_SIDE || maxy - miny + 1 < BG_MIN_SIDE) return null;
    return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
  }

  function boxContains(outer, inner) {
    return outer.x <= inner.x && outer.y <= inner.y &&
      outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
  }

  function sameBox(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  function scratch(w, h) {
    if (!fullCanvas) {
      fullCanvas = document.createElement('canvas');
      fullCtx = fullCanvas.getContext ?
        fullCanvas.getContext('2d', { willReadFrequently: true }) : null;
    }
    if (!fullCtx) return null;
    if (fullCanvas.width !== w || fullCanvas.height !== h) {
      fullCanvas.width = w;
      fullCanvas.height = h;
    }
    return fullCtx;
  }

  function copyToScratch(src) {
    if (!src || !src.width || !src.height) return null;
    var ctx = scratch(src.width, src.height);
    if (!ctx) return null;
    try {
      ctx.clearRect(0, 0, src.width, src.height);
      ctx.drawImage(src, 0, 0);
    } catch (e) { return null; }
    return { ctx: ctx, w: src.width, h: src.height };
  }

  function stepBox(st, ctx, w, h) {
    var now = Date.now();
    st.measured = false;
    if (st.box && now - st.at < BG_BOX_MS) return false;
    st.at = now;
    var m = measureBox(ctx, w, h);
    st.measured = !!m;
    if (!m) return false;
    if (!st.box) {
      st.box = m; st.pending = null; st.pendingN = 0;
      st.srcW = w; st.srcH = h;
      return true;
    }
    if (!boxContains(st.box, m)) {

      var x = Math.min(st.box.x, m.x), y = Math.min(st.box.y, m.y);
      st.box = {
        x: x, y: y,
        w: Math.max(st.box.x + st.box.w, m.x + m.w) - x,
        h: Math.max(st.box.y + st.box.h, m.y + m.h) - y
      };
      st.pending = null; st.pendingN = 0;
      st.srcW = w; st.srcH = h;
      return true;
    }
    if (sameBox(st.box, m)) { st.pending = null; st.pendingN = 0; return false; }

    if (sameBox(st.pending, m)) st.pendingN++;
    else { st.pending = m; st.pendingN = 1; }
    if (st.pendingN >= BG_SHRINK_STREAK) {
      st.box = m; st.pending = null; st.pendingN = 0;
      st.srcW = w; st.srcH = h;
      return true;
    }
    return false;
  }

  function drawOnce() {
    if (!bgCtx) return false;
    var src = pickSource();
    if (!src) return false;
    var r = copyToScratch(src);
    if (!r) return false;
    if (src !== lastSrc || r.w !== lastSrcW || r.h !== lastSrcH) {
      lastSrc = src; lastSrcW = r.w; lastSrcH = r.h;

      resetBox(bgState);
    }
    var resized = stepBox(bgState, r.ctx, r.w, r.h);
    var b = bgState.box || { x: 0, y: 0, w: r.w, h: r.h };
    if (bgCanvas.width !== b.w || bgCanvas.height !== b.h) {
      bgCanvas.width = b.w;
      bgCanvas.height = b.h;
      resized = true;
    }
    try {
      bgCtx.clearRect(0, 0, b.w, b.h);
      bgCtx.drawImage(fullCanvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    } catch (e) { return false; }

    if (resized) applyPresentation();
    return true;
  }

  function startBgLoop() {
    if (rafId) return;
    var tick = function (now) {
      if (!state.enabled || !isBg()) { rafId = null; return; }
      if (now - lastDraw >= FRAME_MS) {
        lastDraw = now;

        if (drawOnce() && wrap && wrap.style.display !== 'block') applyPresentation();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopBgLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    lastSrc = null;
    resetBox(bgState);
  }

  function petCanvasEl() {
    return host ? host.querySelector('canvas') : null;
  }

  function petRatio() {
    if (!petState.box) return null;
    var s = displayedSize();
    var w = petState.srcW, h = petState.srcH;
    if (!w || !h) {
      var cv = petCanvasEl();
      if (!cv || !cv.width || !cv.height) return null;
      w = cv.width;
      h = cv.height;
    }
    return { kx: s / w, ky: s / h };
  }

  function petCrop() {
    if (isBg() || !petState.box) return null;
    var k = petRatio();
    if (!k) return null;
    var b = petState.box;
    return {
      w: Math.max(1, Math.round(b.w * k.kx)),
      h: Math.max(1, Math.round(b.h * k.ky)),
      left: -Math.round(b.x * k.kx),
      top: -Math.round(b.y * k.ky)
    };
  }

  function refreshPetBox() {
    var cv = petCanvasEl();
    if (!cv) return false;

    if (cv !== petBoxCv) {
      petBoxCv = null;
      petState.at = 0;
      if (petFastTries <= 0) petFastTries = BG_BOX_FIRST_TRIES;
    }
    var r = copyToScratch(cv);
    if (!r) return false;
    var resized = stepBox(petState, r.ctx, r.w, r.h);
    if (petState.measured) {
      petBoxCv = cv;
      petFastTries = 0;
    } else if (petFastTries > 0) {
      petFastTries--;
    }
    if (resized) applyPresentation();
    return resized;
  }

  var petBoxTimer = null;
  var petBoxCv = null;
  var petFastTries = 0;

  function schedulePetBoxWatch() {
    petBoxTimer = setTimeout(function () {
      petBoxTimer = null;
      if (!booted || isBg() || !state.enabled) return;
      refreshPetBox();
      startFollowWatchdog();
      startPetBoxWatch();
    }, petFastTries > 0 ? BG_BOX_FIRST_MS : BG_BOX_MS);
  }

  function startPetBoxWatch() {
    if (petBoxTimer || !booted) return;
    schedulePetBoxWatch();
  }

  function stopPetBoxWatch() {
    if (petBoxTimer) { clearTimeout(petBoxTimer); petBoxTimer = null; }
  }

  function apply() {
    if (!booted) return;
    bindState();

    resolveFrameworkPet();
    if (!ensureShell()) return;

    if (isBg()) {
      stopBgLoop();
      stopPetBoxWatch();
      host.textContent = '';
      startBgLoop();
      drawOnce();
    } else {
      stopBgLoop();
      if (bgCtx) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

      if (state.enabled) { renderCharacter(); startPetBoxWatch(); }
      else stopPetBoxWatch();
    }
    applyPresentation();
  }

  function normalizeField(key, value) {
    switch (key) {
      case 'enabled': return value !== false;
      case 'clickThrough': return !!value;
      case 'positionLocked': return !!value;
      case 'mode': return value === MODE_BG ? MODE_BG : MODE_CHAR;
      case 'clipRange':
        var c = Number(value);
        return isFinite(c) ? clamp(Math.round(c), CLIP_MIN, CLIP_MAX) : DEFAULTS.clipRange;
      case 'scale':
        var s = Number(value);
        return isFinite(s) ? clamp(s, MIN_SCALE, MAX_SCALE) : DEFAULTS.scale;
      case 'opacity':
        var o = Number(value);
        return isFinite(o) ? clamp(o, MIN_OPACITY, MAX_OPACITY) : DEFAULTS.opacity;
    }
    return value;
  }

  function adopt(key) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return false;
    var V = sugarV();
    var slot = V && V.options && V.options[OPTION_KEY];
    if (!slot || typeof slot !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(slot, key)) return false;
    var next = normalizeField(key, slot[key]);
    if (state[key] === next) return false;
    state[key] = next;
    return true;
  }

  function changed(key) {
    if (syncingSlider) return;
    if (key) adopt(key);

    commit();
    if (!booted) return;

    if (key === 'clipRange') { applyClip(); return; }

    resetRetryBudget();
    forceRerender = true;
    fromPanel = true;
    try {
      apply();
    } finally {
      fromPanel = false;
    }
  }

  function set(key, value) {
    bindState();
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return;

    state[key] = normalizeField(key, value);

    if (key === 'clipRange') {
      commit();
      bindState();
      if (booted) applyClip();
      syncSlider('clipRange');
      return;
    }
    changed();
    if (key === 'scale' || key === 'opacity') syncSlider(key);
  }

  var syncingSlider = false;
  function syncSlider(key) {
    if (syncingSlider) return;
    var box = document.querySelector('[data-lpc="' + key + '"]');
    if (!box) return;
    var inp = box.querySelector('input[type="range"]');
    if (!inp) return;
    syncingSlider = true;
    try {
      inp.value = String(state[key]);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {} finally { syncingSlider = false; }
  }

  var drag = null;

  var LONGPRESS_MS = 450;
  var MOVE_TOL = 8;
  var lpTimer = null;
  var lpId = -1;
  var lpActive = false;
  var lpStart = null;
  var lpGrab = null;

  function inModelRect(x, y) {
    if (!wrap) return false;
    var r = wrap.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function cancelLongPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    lpId = -1;
    lpActive = false;
    lpStart = null;
    lpGrab = null;
  }

  function bindDrag() {
    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('pointermove', onPointerMove);
    wrap.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', onResize);

    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('pointermove', onDocPointerMove, { passive: false, capture: true });
    document.addEventListener('pointerup', onDocPointerUp, true);
    document.addEventListener('pointercancel', onDocPointerUp, true);
    document.addEventListener('contextmenu', onDocContextMenu, true);
  }

  function onDocPointerDown(e) {
    if (!state.enabled || state.positionLocked || !state.clickThrough) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!inModelRect(e.clientX, e.clientY)) return;
    if (wrap && wrap.contains(e.target)) return;

    rescalePos();
    var p = renderPos();
    lpId = e.pointerId;
    lpActive = false;
    lpStart = { x: e.clientX, y: e.clientY };
    lpGrab = { ox: e.clientX - p.left, oy: e.clientY - p.top };
    if (lpTimer) clearTimeout(lpTimer);
    lpTimer = setTimeout(function () {
      lpTimer = null;
      lpActive = true;
      if (wrap) wrap.classList.add('litterpc-dragging');
    }, LONGPRESS_MS);
  }

  function onDocPointerMove(e) {
    if (lpId < 0 || e.pointerId !== lpId) return;
    if (!lpActive) {
      if (Math.abs(e.clientX - lpStart.x) > MOVE_TOL || Math.abs(e.clientY - lpStart.y) > MOVE_TOL) {
        cancelLongPress();
      }
      return;
    }
    var d = displayedDims();
    var a = contentAnchor();
    pos.left = clamp(e.clientX - lpGrab.ox, 0, Math.max(0, window.innerWidth - d.w)) - a.x;
    pos.top = clamp(e.clientY - lpGrab.oy, 0, Math.max(0, window.innerHeight - d.h)) - a.y;
    applyPresentation();
    e.preventDefault();
  }

  function onDocPointerUp(e) {
    if (lpId < 0 || e.pointerId !== lpId) return;
    if (lpActive) {
      if (wrap) wrap.classList.remove('litterpc-dragging');
      savePosSoon();
    }
    cancelLongPress();
  }

  function onDocContextMenu(e) {
    if (lpActive || (lpId >= 0 && lpStart)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPointerDown(e) {
    if (!state.enabled || state.positionLocked) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    rescalePos();
    var p = renderPos();

    var a = contentAnchor();
    pos.left = p.left - a.x;
    pos.top = p.top - a.y;
    drag = { id: e.pointerId, dx: e.clientX - p.left, dy: e.clientY - p.top };
    wrap.classList.add('litterpc-dragging');
    try { if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    var d = displayedDims();
    var a = contentAnchor();

    pos.left = clamp(e.clientX - drag.dx, 0, Math.max(0, window.innerWidth - d.w)) - a.x;
    pos.top = clamp(e.clientY - drag.dy, 0, Math.max(0, window.innerHeight - d.h)) - a.y;
    applyPresentation();
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!drag || drag.id !== e.pointerId) return;
    try { if (wrap.releasePointerCapture) wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    drag = null;
    wrap.classList.remove('litterpc-dragging');
    savePosSoon();
  }

  function onResize() {
    if (!wrap) return;
    applyPresentation();
  }

  function resetPos() {

    pos.left = null;
    pos.top = null;
    pos.rescale = false;
    var p = renderPos();
    var a = contentAnchor();
    pos.left = p.left - a.x;
    pos.top = p.top - a.y;
    applyPresentation();
    writePos();
  }

  function reconcileFrameworkPet() {
    if (!booted) return;
    resolveFrameworkPet();

    if (!isBg() && state.enabled && !characterMounted()) {
      resetRetryBudget();
      apply();
    }
  }

  function onPanelEvent(e) {
    if (e.type !== 'change') return;
    var el = e.target && e.target.closest ? e.target.closest('input') : null;
    if (!el || el.type === 'range') return;

    if (isFrameworkPetControl(el)) { reconcileFrameworkPet(); return; }
    var box = el.closest('[data-lpc]');
    if (!box) return;
    var key = box.getAttribute('data-lpc');
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return;
    changed(key);
  }

  function isFrameworkPetControl(el) {
    var name = el.getAttribute ? (el.getAttribute('name') || '') : '';
    return name.indexOf('optionsmaplebirchcharacterpet') !== -1;
  }

  function updatePosLabels(p) {

    var list = document.querySelectorAll('.lpc-pos');
    for (var i = 0; i < list.length; i++) {
      list[i].textContent = 'X=' + Math.round(p.left) + ', Y=' + Math.round(p.top);
    }
  }

  var petPrevKnown = false;
  var petPrev = false;

  function frameworkPetOption() {
    var V = sugarV();
    var mb = V && V.options && V.options.maplebirch;
    return (mb && mb.character && mb.character.pet) || null;
  }

  function resolveFrameworkPet() {

    ensureSidebarHook();

    var ours = booted && state.enabled;
    var opt = frameworkPetOption();

    if (opt) {
      if (!petPrevKnown) {
        var stored = readLS(LS_PET_PREV);
        if (typeof stored !== 'boolean') {

          stored = readLS(LS_TAKEN_OVER) ? false : !!opt.enabled;
          writeLS(LS_PET_PREV, stored);
        }
        petPrev = stored;
        petPrevKnown = true;
      }

      var want = ours ? false : petPrev;
      if (!!opt.enabled !== want) {
        opt.enabled = want;
        var pet = frameworkPet();
        if (pet && typeof pet.sync === 'function') pet.sync();
      }
    }

    if (ours) {
      var theirEl = document.getElementById(FW_PET_ELEMENT_ID);
      if (theirEl && theirEl.firstChild) theirEl.textContent = '';
    }
  }

  function init() {
    if (booted) return;
    if (!document.body) { setTimeout(init, 50); return; }
    booted = true;

    adoptFromSave();
    bindState();
    ensureShell();
    ensureFollowPatch();
    ensurePetCapturePatch();
    apply();

    scheduleGameSync();

    document.addEventListener('change', onPanelEvent);

    window.addEventListener('pagehide', function () {
      if (posTimer) savePos();
    });

    watchSidebarCanvas();

    $(document).on(':passagedisplay', onPassageEvent);

    $(document).on(':passageend', onPassageEndEvent);

    $(document).on(':storyloaded', function () {
      if (!booted) return;

      sidebarInstalled = false;
      sidebarTries = 0;
      clearTimeout(sidebarTimer);

      watchSidebarCanvas();
      adoptFromSave();
      pos = posLoad();

      forceRerender = true;
      lastMainRef = null;
      lastContentSig = null;
      triggerSidebarRebuild();
      requestAnimationFrame(function () {
        apply();
      });

      entryPassages = 0;
      syncRebuildCount = 0;
      scheduleGameSync();
    });
  }

  function onPassageEvent() {
    if (!booted) return;

    if (!isBg() && !characterMounted()) resetRetryBudget();

    ensureFollowPatch();
    ensurePetCapturePatch();

    apply();
    if (entryPassages < 10 && !isBg()) {
      entryPassages++;
      scheduleGameSync();
    }
  }

  function onPassageEndEvent() {
    if (!booted) return;
    reconcileFrameworkPet();
  }

  var GIF_INTERVAL = 80;
  var GIF_DURATION_MS = 2000;
  var GIF_DELAY_MIN_CS = 2;
  var GIF_DELAY_MAX_CS = 100;
  var GIF_MAX_FRAMES = 40;
  var GIF_MAX_SIDE = 320;
  var GIF_TRANSPARENT = 255;
  var GIF_ALPHA_CUT = 128;
  var gifBusy = false;

  var gifUrl = null;

  function gifStatus(msg) {
    try {
      var el = document.getElementById('lpc-gif-status');
      if (el) el.textContent = msg;
    } catch (e) {}
    console.log('[小小PC] ' + msg);
  }

  function gifFingerprint(d, w, h) {
    var g = new Float64Array(256);
    for (var y = 0; y < 16; y++) {
      var py = ((y * h) / 16) | 0;
      for (var x = 0; x < 16; x++) {
        var px = ((x * w) / 16) | 0;
        var i = (py * w + px) * 4;
        g[y * 16 + x] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 * (d[i + 3] / 255);
      }
    }
    return g;
  }

  function gifDistance(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  function gifDelays(stamps) {
    var out = [];
    for (var i = 0; i < stamps.length; i++) {
      var ms = i + 1 < stamps.length ? stamps[i + 1] - stamps[i]
        : (i > 0 ? stamps[i] - stamps[i - 1] : GIF_INTERVAL);
      out.push(clamp(Math.round(ms / 10), GIF_DELAY_MIN_CS, GIF_DELAY_MAX_CS));
    }
    return out;
  }

  function gifSample(canvas, rect, done) {
    var sx = rect ? rect.x : 0;
    var sy = rect ? rect.y : 0;
    var sw = rect ? rect.w : canvas.width;
    var sh = rect ? rect.h : canvas.height;

    if (rect) {
      sx = clamp(sx, 0, Math.max(0, canvas.width - 1));
      sy = clamp(sy, 0, Math.max(0, canvas.height - 1));
      sw = Math.min(sw, canvas.width - sx);
      sh = Math.min(sh, canvas.height - sy);
    }
    if (!canvas.width || !canvas.height || !sw || !sh) { done({ error: '画布尺寸是 0' }); return; }
    var k = Math.min(1, GIF_MAX_SIDE / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * k));
    var h = Math.max(1, Math.round(sh * k));

    var tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    var ctx = tmp.getContext('2d', { willReadFrequently: true });
    if (!ctx) { done({ error: '拿不到 2d 上下文' }); return; }

    var frames = [];
    var stamps = [];
    var first = null;
    var moved = false;
    var t0 = Date.now();

    function grab() {
      var img;
      try {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, w, h);
        img = ctx.getImageData(0, 0, w, h);
      } catch (e) {
        done({ error: '画布读不出来：' + e });
        return;
      }
      var fp = gifFingerprint(img.data, w, h);
      if (!first) first = fp;
      if (!moved && gifDistance(first, fp) > 2) moved = true;
      frames.push(img);
      stamps.push(Date.now());

      if (Date.now() - t0 >= GIF_DURATION_MS || frames.length >= GIF_MAX_FRAMES) {
        done({ w: w, h: h, frames: frames, moved: moved, delays: gifDelays(stamps) });
        return;
      }
      setTimeout(grab, GIF_INTERVAL);
    }
    grab();
  }

  function gifMeasure(items) {
    var mn = [255, 255, 255], mx = [0, 0, 0], n = 0;
    for (var i = 0; i < items.length; i++) {
      var c = items[i].c, cnt = items[i].n, ch;
      var r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      ch = [r, g, b];
      for (var a = 0; a < 3; a++) {
        if (ch[a] < mn[a]) mn[a] = ch[a];
        if (ch[a] > mx[a]) mx[a] = ch[a];
      }
      n += cnt;
    }
    var axis = 0, span = 0;
    for (var x = 0; x < 3; x++) {
      var s = mx[x] - mn[x];
      if (s > span) { span = s; axis = x; }
    }
    return { mn: mn, mx: mx, n: n, axis: axis, span: span };
  }

  function gifMedianCut(items) {
    var boxes = [];
    var leaves = [];

    function average(list) {
      var wr = 0, wg = 0, wb = 0, tn = 0;
      for (var i = 0; i < list.length; i++) {
        var c = list[i].c, n = list[i].n;
        wr += ((c >> 16) & 255) * n;
        wg += ((c >> 8) & 255) * n;
        wb += (c & 255) * n;
        tn += n;
      }
      if (!tn) return null;
      return [(wr / tn) | 0, (wg / tn) | 0, (wb / tn) | 0];
    }

    function push(list) {
      if (!list.length) return;
      var m = gifMeasure(list);

      if (list.length < 2 || m.span === 0) { leaves.push(list); return; }
      boxes.push({ items: list, m: m });
    }

    push(items);

    while (boxes.length < 254) {
      var best = -1, bestSpan = 0;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].m.span > bestSpan) { bestSpan = boxes[i].m.span; best = i; }
      }
      if (best < 0) break;
      var box = boxes[best];
      var axis = box.m.axis;
      var chan = function (c) { return (c >> (16 - axis * 8)) & 255; };
      var list = box.items.slice().sort(function (a, b) { return chan(a.c) - chan(b.c); });
      var half = box.m.n / 2, acc = 0, cut = 0;
      for (var j = 0; j < list.length; j++) {
        acc += list[j].n;
        if (acc >= half) { cut = j; break; }
      }

      if (cut >= list.length - 1) cut = (list.length - 1) >> 1;
      if (cut < 0) cut = 0;
      boxes.splice(best, 1);
      push(list.slice(0, cut + 1));
      push(list.slice(cut + 1));
    }
    boxes.forEach(function (b) { leaves.push(b.items); });

    var pal = [];
    for (var p = 0; p < leaves.length && pal.length < 255; p++) {
      var c2 = average(leaves[p]);
      if (c2) pal.push(c2);
    }
    if (!pal.length) pal.push([0, 0, 0]);
    return pal;
  }

  function gifPaletteItems(frames) {
    var map = new Map();
    for (var f = 0; f < frames.length; f++) {
      var d = frames[f].data;
      for (var i = 0; i < d.length; i += 16) {
        if (d[i + 3] < GIF_ALPHA_CUT) continue;
        var c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    var items = [];
    map.forEach(function (n, c) { items.push({ c: c, n: n }); });
    return items;
  }

  function gifNearest(pal) {
    var cache = new Map();
    return function (r, g, b) {
      var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      var hit = cache.get(key);
      if (hit !== undefined) return hit;
      var best = 0, bestD = Infinity;
      for (var i = 0; i < pal.length; i++) {
        var dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
        var d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
        if (d < bestD) { bestD = d; best = i; }
      }
      cache.set(key, best);
      return best;
    };
  }

  function gifLzw(indices, minCodeSize) {
    var CLEAR = 1 << minCodeSize;
    var EOI = CLEAR + 1;
    var codeSize = minCodeSize + 1;
    var next = EOI + 1;
    var dict = new Map();
    var bytes = [];
    var cur = 0, nbits = 0;

    function put(code) {
      cur |= code << nbits;
      nbits += codeSize;
      while (nbits >= 8) { bytes.push(cur & 255); cur >>= 8; nbits -= 8; }
    }

    put(CLEAR);
    var prev = indices[0];
    for (var i = 1; i < indices.length; i++) {
      var c = indices[i];
      var key = (prev << 8) | c;
      var found = dict.get(key);
      if (found !== undefined) { prev = found; continue; }
      put(prev);
      if (next < 4096) {
        dict.set(key, next);
        next++;

        if (next - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        put(CLEAR);
        dict.clear();
        next = EOI + 1;
        codeSize = minCodeSize + 1;
      }
      prev = c;
    }
    put(prev);
    put(EOI);
    if (nbits > 0) bytes.push(cur & 255);
    return bytes;
  }

  function gifEncode(spec) {
    var w = spec.w, h = spec.h, pal = spec.palette, frames = spec.frames;
    var bytes = [];
    function u8(v) { bytes.push(v & 255); }
    function u16(v) { u8(v); u8(v >> 8); }
    function str(s) { for (var i = 0; i < s.length; i++) u8(s.charCodeAt(i)); }

    str('GIF89a');
    u16(w); u16(h);
    u8(0xF7);
    u8(0);
    u8(0);
    for (var i = 0; i < 256; i++) {
      var c = pal[i] || [0, 0, 0];
      u8(c[0]); u8(c[1]); u8(c[2]);
    }

    u8(0x21); u8(0xFF); u8(11);
    str('NETSCAPE2.0');
    u8(3); u8(1); u16(0); u8(0);

    var delays = spec.delays || [];
    for (var f = 0; f < frames.length; f++) {
      u8(0x21); u8(0xF9); u8(4);
      u8(0x09);
      u16(delays[f] || GIF_INTERVAL / 10);
      u8(GIF_TRANSPARENT);
      u8(0);
      u8(0x2C);
      u16(0); u16(0); u16(w); u16(h);
      u8(0);
      u8(8);
      var data = frames[f];
      var pos = 0;
      while (pos < data.length) {
        var n = Math.min(255, data.length - pos);
        u8(n);
        for (var j = 0; j < n; j++) u8(data[pos + j]);
        pos += n;
      }
      u8(0);
    }
    u8(0x3B);
    return new Uint8Array(bytes);
  }

  function gifDownload(bytes, name) {
    gifClearActions();
    var blob = new Blob([bytes], { type: 'image/gif' });
    var url = URL.createObjectURL(blob);

    gifUrl = url;
    gifRenderActions(url, blob, name);
    gifAutoClick(url, name);
  }

  function gifAutoClick(url, name) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = name;

      a.target = '_blank';
      a.rel = 'noopener';

      a.style.position = 'fixed';
      a.style.left = '-2000px';
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
    } catch (e) {}
  }

  function gifShareFile(blob, name) {
    try {
      var f = new File([blob], name, { type: 'image/gif' });
      if (!navigator.canShare || !navigator.canShare({ files: [f] })) return null;
      return f;
    } catch (e) {
      return null;
    }
  }

  function gifRenderActions(url, blob, name) {
    var el = document.getElementById('lpc-gif-actions');

    if (!el) return;
    el.textContent = '';
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '保存 ' + name;
    el.appendChild(a);
    var file = gifShareFile(blob, name);
    if (file) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '分享';
      btn.onclick = function (ev) {
        ev.preventDefault();
        navigator.share({ files: [file], title: name }).catch(function (e) {

          if (e && e.name === 'AbortError') return;
          gifStatus('分享没成：' + e);
        });
      };
      el.appendChild(btn);
    }
    var hint = document.createElement('span');
    hint.className = 'lpc-gif-hint';
    hint.textContent = file
      ? 'iPhone 请走 分享→存储到"文件"，存进照片会变成静止画面'
      : '没自动下载就点上面这条链接；iPhone 长按存进照片会变成静止画面';
    el.appendChild(hint);
  }

  function gifClearActions() {
    if (gifUrl) {
      try {
        URL.revokeObjectURL(gifUrl);
      } catch (e) {}
      gifUrl = null;
    }
    var el = document.getElementById('lpc-gif-actions');
    if (el) el.textContent = '';
  }

  function gifStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function gifSource() {
    if (isBg()) {

      if (!lastSrc || !bgCanvas || !bgCanvas.width) return { error: '还没抓到背景画面' };
      return { canvas: bgCanvas, rect: null };
    }
    var canvas = petCanvasEl();
    if (!canvas || !canvas.width) return { error: '模型还没画出来' };
    return { canvas: canvas, rect: petState.box || null };
  }

  function exportGif() {
    if (gifBusy) return false;
    var src = gifSource();
    if (src.error) { gifStatus(src.error + '，稍等一下再点'); return false; }

    var bg = isBg();

    gifBusy = true;

    gifClearActions();
    gifStatus('正在采样 ' + (GIF_DURATION_MS / 1000) + ' 秒' + (bg ? '背景' : '模型') + '画面……');
    gifSample(src.canvas, src.rect, function (r) {
      try {
        if (r.error) { gifStatus('导出失败：' + r.error); return; }
        if (!r.moved) {
          gifStatus('注意：这 ' + (GIF_DURATION_MS / 1000) + ' 秒里画面没有变化' +
            (bg ? '（侧边栏是静止的，导出的就是同一张背景）'
                : '（游戏设置里的「侧边栏动画」可能是关的）'));
        }
        var items = gifPaletteItems(r.frames);
        if (!items.length) { gifStatus('导出失败：画面是全透明的'); return; }
        var pal = gifMedianCut(items);
        var nearest = gifNearest(pal);
        var indexed = [];
        for (var f = 0; f < r.frames.length; f++) {
          var d = r.frames[f].data;
          var idx = new Uint8Array(d.length / 4);
          for (var i = 0, p = 0; i < d.length; i += 4, p++) {
            idx[p] = d[i + 3] < GIF_ALPHA_CUT
              ? GIF_TRANSPARENT
              : nearest(d[i], d[i + 1], d[i + 2]);
          }
          indexed.push(gifLzw(idx, 8));
        }
        var name = 'litterpc-' + gifStamp() + '.gif';
        gifDownload(gifEncode({
          w: r.w, h: r.h, palette: pal, frames: indexed, delays: r.delays
        }), name);

        var totalCs = 0;
        for (var f2 = 0; f2 < r.delays.length; f2++) totalCs += r.delays[f2];
        gifStatus('已生成 ' + name + '（' + r.frames.length + ' 帧，' + r.w + 'x' + r.h +
          '，回放约 ' + (totalCs / 100).toFixed(1) + ' 秒）');
      } catch (e) {
        gifStatus('导出失败：' + e);
      } finally {
        gifBusy = false;
      }
    });
    return true;
  }

  $(document).one(':storyready', init);
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function () {
      if (document.readyState !== 'loading') init();
    }, { once: true });
  } else {
    init();
  }

  function debug() {
    var R = window.Renderer;
    var V = sugarV();
    var mb = window.maplebirch;
    var opt = frameworkPetOption();
    var CM = R && R.CanvasModels;
    var wrapEl = document.getElementById(WRAP_ID);
    var c = host ? host.querySelector('canvas') : null;

    var fromLS = readLS(LS_STATE);
    var fromSS = readSS(SS_STATE);
    var fromLegacy = readLS(LS_LEGACY);
    var fromSave = readSaveSlot();
    var source = fromLS ? 'localStorage'
      : fromSS ? 'sessionStorage'
        : fromLegacy ? '旧版键 ' + LS_LEGACY
          : fromSave ? '存档副本' : 'DEFAULTS';

    var d = {
      version: VERSION,
      booted: booted,
      state: snapshot(),

      pos: {
        stored: posKnown() ? [Math.round(pos.left), Math.round(pos.top)] : null,
        rescalePending: !!pos.rescale,
        anchor: contentAnchor(),
        rendered: (function () {
          var rp = renderPos();
          return { left: Math.round(rp.left), top: Math.round(rp.top) };
        })()
      },
      viewport: { w: window.innerWidth, h: window.innerHeight },

      localSource: source,
      storage: {
        settings: fromLS,
        settingsSession: fromSS,
        legacy: fromLegacy,
        position: readLS(LS_POS),
        frameworkPetPrev: readLS(LS_PET_PREV),
        saveSlot: V && V.options ? V.options[OPTION_KEY] : undefined
      },
      animation: {

        optionKey: 'V.options.sidebarAnimations',
        optionValue: V && V.options ? V.options.sidebarAnimations : undefined,
        ourAnimated: frameworkAnimated(),
        petMask: PET_MASK,
        petRotation: PET_ROTATION,
        petCapture: {
          patched: petCapturePatched,
          repairs: petLayerRepairs.slice(0)
        },
        follow: {
          patched: followPatched,
          wanted: followWanted(),
          events: followEvents,
          draws: followDraws,
          last: followLast,
          lastEventAgoMs: followLastAt ? (Date.now() - followLastAt) : null,
          watchMs: FOLLOW_WATCH_MS,
          okWatchMs: FOLLOW_OK_WATCH_MS,
          idleWatchMs: FOLLOW_IDLE_WATCH_MS,
          idleWatches: followIdleWatches,
          animHealthy: followAnimHealthy(),
          heals: followHeals,
          healMs: FOLLOW_HEAL_MS,
          framesMatched: followFramesMatched(),
          sidebarAnimating: sidebarHasAnimations(),
          watchArmed: !!followWatchTimer,
          stalling: followStalling,
          stallEpisodes: followStallEpisodes,
          lastPrimeResult: followPrimeResult,
          sidebarAnimCalls: sidebarAnimCalls,
          sidebarAnimWrapped: sidebarAnimWrapped,
          sidebarAnimMissed: sidebarAnimMissed,
          sidebarCensus: sidebarCanvasCensus(),
          ourCensus: ourCanvasCensus(),
          sidebarFrames: animFrameStr(sidebarAnimatingCanvas()),
          ourFrames: animFrameStr(ourAnimatingCanvas())
        }
      },
      framework: {
        installed: !!mb,
        petApi: !!frameworkPet(),
        petOptionEnabled: opt ? !!opt.enabled : null,
        petElementChildren: (function () {
          var el = document.getElementById(FW_PET_ELEMENT_ID);
          return el ? el.childNodes.length : null;
        })()
      },
      canvasModels: CM
        ? { main: !!CM.main, pet: CM.pet ? true : String(CM.pet) }
        : null,
      sidebarCacheReady: !!sidebarCacheOptions(),
      gameReady: gameReady(),
      mounted: characterMounted(),
      hooks: {
        sidebarInstalled: sidebarInstalled,

        sidebarHookHits: sidebarHookHits,
        sidebarTries: sidebarTries,
        retry: { fast: retryCount, slow: slowRetryCount, pending: retryPending },
        gameSyncPending: gameSyncTimers.length
      },
      gif: {
        busy: gifBusy,
        mode: state.mode,

        delayCs: { min: GIF_DELAY_MIN_CS, max: GIF_DELAY_MAX_CS, nominal: GIF_INTERVAL / 10 },

        source: gifSource().canvas ? (isBg() ? 'bgCanvas' : 'hostCanvas') : null,
        bgCanvas: bgCanvas ? [bgCanvas.width, bgCanvas.height] : null,
        bgHasSource: !!lastSrc,

        paths: {
          linkRow: !!document.getElementById('lpc-gif-actions'),
          share: gifShareFile(new Blob(['GIF89a'], { type: 'image/gif' })) !== null,

          held: !!gifUrl
        },
        ua: navigator.userAgent
      },

      crop: (function () {
        function fmtBox(b) { return b ? [b.x, b.y, b.w, b.h] : null; }
        var hc = petCanvasEl();
        var crop = petCrop();
        return {
          srcCanvas: fullCanvas ? [fullCanvas.width, fullCanvas.height] : null,
          bgBox: fmtBox(bgState.box),
          bgPending: fmtBox(bgState.pending),
          petBox: fmtBox(petState.box),
          petBoxSrc: [petState.srcW, petState.srcH],

          petBoxOnCanvas: !!(petBoxCv && petBoxCv === hc),
          petFastTries: petFastTries,
          petPending: fmtBox(petState.pending),
          petCanvas: hc ? [hc.width, hc.height] : null,
          petCss: hc ? [hc.style.width, hc.style.height] : null,
          hostBoxOffset: crop ? [crop.left, crop.top] : null,
          anchor: contentAnchor(),
          bgCanvas: bgCanvas ? [bgCanvas.width, bgCanvas.height] : null,
          displayed: displayedDims(),
          watch: !!petBoxTimer
        };
      })(),
      dom: {
        wrap: !!wrapEl,
        wrapDisplay: wrapEl ? getComputedStyle(wrapEl).display : null,
        wrapOpacity: wrapEl ? getComputedStyle(wrapEl).opacity : null,
        hostCanvas: !!c,
        canvasSize: c ? c.width + 'x' + c.height : null
      }
    };
    console.log('FloatingSprite.debug ' + VERSION + '\n' + JSON.stringify(d, null, 2));
    return d;
  }

  window.FloatingSprite = {
    get data() { return bindState(); },
    get pos() {
      var p = renderPos();
      return { left: Math.round(p.left), top: Math.round(p.top) };
    },
    ensure: bindState,
    set: set,
    changed: changed,
    resetPos: resetPos,
    debug: debug,
    exportGif: exportGif
  };
})();
