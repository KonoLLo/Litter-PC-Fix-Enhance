/*
 * 小小PC-修复增强 (Litter-PC)
 *
 * 与秋枫白桦框架的边界：
 *   - 只用 Pet 的公开接口 render(target, options)，并传 floating:false。
 *     框架的 enableDrag 因此不执行，定位与拖拽完全归本模组。
 *   - 框架的 Pet/FloatingPet 是单实例：mount 与 unmount 都会对
 *     this.container 做 clearBox()，而 configure() 会把参数写进共享的
 *     this.options。我们 render 之后 container 就是我们的 host，于是
 *     换装、开衣柜这类触发 <<updatesidebarimg>> → pet.sync() 的操作
 *     会把我们的 host 整个清空（模型消失），或在框架自己的开关为开时
 *     把画布搬去框架的元素上（出现第二个、尺寸还是我们设的那个小人）。
 *     对策两条：render 成功后把 container/canvas/model 交还给框架，
 *     让我们的 host 脱离它的清理范围；并在本模组占用期间持续关掉
 *     框架那一份（见 resolveFrameworkPet），不再是一次性接管。
 *   - 框架只在 CanvasModels.pet 不存在时才抄一份 main（capture 里
 *     if(!e?.layers||t.pet)return），换装时 DoL 只重建 main，所以我们
 *     每次 render 拿到的还是那份旧快照 —— 表现为衣柜里换完衣服模型不动、
 *     刷新后还是初始着装。对策：每次 render 前显式作废 pet 槽位，让它按
 *     当下的 main 重捕。实时触发则接在 <<updatesidebarimg>> 上（框架自己
 *     的实时跟随也是挂这个宏），见 ensureSidebarHook。
 *   - 背景模式这条路径只读游戏本体的 .mainCanvas / #startImg，不经过框架；
 *     开局抓不到侧栏时由背景循环自己在画成之后补一次呈现。
 *
 * 状态存放（本地浏览器优先）：
 *   内存里的 state 是唯一权威，$options.litterpc 只是面板宏的绑定副本，
 *   每次都用 state 就地覆盖它 —— 绝不借用它的引用。这样换装、开衣柜这类
 *   操作就地改写或整体替换那份副本时，动不到我们的设置，也不会被我们
 *   误当成玩家的选择写进存储（v1.1.0 的 bug 就是这么来的）。
 *   state 的持久镜像：localStorage 的 litterpc.settings 与同名 sessionStorage
 *   各一份，读时按 localStorage > sessionStorage > 旧版键回退，任何一份被
 *   外部清掉都能自愈。
 *   litterpc.pet.position  仅位置；同样只存本地，并留同名 sessionStorage 镜像
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */
  var OPTION_KEY = 'litterpc';
  var LS_STATE = 'litterpc.settings';
  var SS_STATE = 'litterpc.settings';                // 页签级镜像，主键被清掉时兜底
  var LS_LEGACY = 'floatingSprite.settings';        // 旧版本键，仅作迁移来源
  var LS_POS = 'litterpc.pet.position';
  var SS_POS = 'litterpc.pet.position';             // 位置的页签级镜像
  var LS_TAKEN_OVER = 'litterpc.frameworkPetTakenOver';  // v1.1.0 的一次性接管标记
  var LS_PET_PREV = 'litterpc.frameworkPetPrev';    // 框架桌宠原本是否开着（我们让位前记的）

  var BASE = 256;                                   // 与框架 displaySize 基准一致
  var MIN_SCALE = 0.5;
  var MAX_SCALE = 1.0;

  // mask 128 是框架双视图遮罩的取值；inset 百分比沿用旧版，画面保持不变
  var PET_MASK = 128;
  var PET_ROTATION = 0;
  var INSET_LEFT = 58;
  var INSET_RIGHT = 48;

  var MODE_CHAR = 'character';
  var MODE_BG = 'background';
  var CLIP_FULL = 'full';
  var CLIP_CLOSEUP = 'closeUp';
  var CLIP_MODEL = 'modelOnly';

  var MAX_RETRY = 30;                               // 模型未就绪时先按帧重试
  var SLOW_RETRY_MS = 1000;                         // 帧预算用完后降频继续等，直到就绪
  var MAX_SLOW_RETRY = 60;                          // 降频最多 60 次；换段落时重新给一轮
  var FRAME_MS = 1000 / 24;                         // 背景模式重绘节流

  var WRAP_ID = 'litterpc-pet';                     // 本模组拥有：定位、显隐、穿透
  var HOST_ID = 'litterpc-pet-host';                // 框架把角色模型画进这里
  var BG_ID = 'litterpc-bg';                        // 背景模式画布
  var FW_PET_ELEMENT_ID = 'maplebirch-character-pet'; // 框架桌宠自己的容器

  var DEFAULTS = {
    enabled: true,
    clickThrough: false,
    mode: MODE_CHAR,
    scale: 0.85,
    clip: CLIP_FULL
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
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

  // 框架的 register 用普通属性赋值挂载 char（rg.define("char", new Character(rg))），
  // pet 也是 Character 构造期字段，所以只需逐级存在性判断，不会抛。
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

  // 游戏本体的角色渲染管线是否已经就绪。
  // 实测（v1.0.2 控制台日志）：开局调 pet.render 会走进 DoL 的
  // CanvasModel.preprocess，那里读 setup.clothes.handheld —— setup.clothes
  // 要到 ModdedClothesAddon 初始化完才填好，比 :storyready 晚好几秒。
  // CanvasModels 是框架 render 自己的前置条件，拿来当就绪信号最贴合。
  // 认不出这两个 DoL 全局时不拦，交给框架判断，避免非 DoL 分支上永远不画。
  function gameReady() {
    var R = window.Renderer;
    var S = window.setup;
    if (!R || !S) return true;
    var CM = R.CanvasModels;
    return !!(CM && (CM.pet || CM.main) && S.clothes);
  }

  // 把 obj 收敛成新版字段形状（就地改，调用方传进来的应当是副本）。
  // 同时接受旧版字段形状：showBackground 布尔、closeUp/modelOnly 布尔、
  // petClipLeft/petClipRight 百分比数值。
  function normalize(obj) {
    obj.enabled = obj.enabled !== false;
    obj.clickThrough = !!obj.clickThrough;

    obj.mode = (obj.mode === MODE_BG || obj.showBackground) ? MODE_BG : MODE_CHAR;
    delete obj.showBackground;

    var s = Number(obj.scale);
    obj.scale = isFinite(s) ? clamp(s, MIN_SCALE, MAX_SCALE) : DEFAULTS.scale;

    if (obj.clip !== CLIP_CLOSEUP && obj.clip !== CLIP_MODEL) {
      obj.clip = obj.closeUp ? CLIP_CLOSEUP
        : (obj.modelOnly ? CLIP_MODEL
          // 旧版是百分比：>0 即代表勾选
          : ((parseInt(obj.petClipLeft, 10) || 0) > 0 ? CLIP_CLOSEUP
            : ((parseInt(obj.petClipRight, 10) || 0) > 0 ? CLIP_MODEL : CLIP_FULL)));
    }
    delete obj.closeUp;
    delete obj.modelOnly;
    delete obj.petClipLeft;
    delete obj.petClipRight;
    // 旧版本用来仲裁新旧的字段，本地优先之后不再需要，顺手清掉
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

  // 持久镜像：localStorage 主键 → sessionStorage 同名键 → 旧版键。读不到
  // 返回 null（不掺默认值，好区分“这台设备没存过”）。两份镜像内容相同、
  // 写时一起写：游戏或其他模组可能整体替换 $options，也可能连带清掉本模组
  // 的 localStorage 键，只要有一份还在就不回退默认值。
  function localState() {
    var stored = readLS(LS_STATE) || readSS(SS_STATE) || readLS(LS_LEGACY);
    if (!stored || typeof stored !== 'object') return null;
    return normalize(Object.assign({}, DEFAULTS, stored));
  }

  /* ------------------------------------------------------------------ *
   * 状态权威：内存里的 state
   *
   * 优先级：本地存储 > 存档带来的 $options.litterpc > 默认值。
   * 设置是设备和偏好，不是进度，所以刷新、换存档、读旧存档都不改变它。
   *
   * v1.1.0 的教训：state 曾经直接等于 $options.litterpc 那个对象（面板宏
   * 绑的就是它）。玩家实测：换装、开衣柜会把那份副本变回默认值 —— 具体
   * 由谁改的没在日志里见到（游戏侧有若干处会整体重建 V 的选项子树），
   * 但共享引用一被改，设置就跟着“连坐”，再由 commit() 写成持久值，
   * 看起来就是“做个操作立刻重置设置”。
   * 现在 state 只住在本模组的私有对象里，$options.litterpc 每次都用
   * state 就地覆盖（面板宏绑的是它，显示才和实际一致），外部怎么改、
   * 甚至整个换掉那份副本都影响不到我们；存储被清也还有页签镜像兜底。
   * ------------------------------------------------------------------ */
  var state = normalize(Object.assign({}, DEFAULTS, localState() || readSaveSlot()));

  // 存档里是否有本模组的设置（首次安装或从旧版升级时没有）
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

    // 面板宏绑定的就是这个对象，只能就地覆盖，不能换成新对象
    var slot = V.options[OPTION_KEY];
    if (!slot || typeof slot !== 'object') {
      slot = {};
      V.options[OPTION_KEY] = slot;
    }

    // 这里从不读 slot —— 它随时可能被游戏侧重写成默认值。要读只在
    // adoptFromSave()（开局与真正读档）里读，面板那条路走 adopt(key)。
    var local = localState();
    if (local) Object.assign(state, local);
    // 主键不在就补写一次（首次安装、从旧版升级、被外部清过库都走这里），
    // 顺带把页签镜像对齐；此后本地就是权威，旧版键只作为一次迁移来源。
    if (!readLS(LS_STATE)) writeState(snapshot());
    noteExternalReset(slot);
    pushToSlot(slot);
    return state;
  }

  // 开局与 :storyloaded 才允许拿存档副本兜底：本地镜像读不到时才采信它。
  function adoptFromSave() {
    if (localState()) return false;
    var fromSave = readSaveSlot();
    if (!fromSave) return false;
    Object.assign(state, normalize(Object.assign({}, DEFAULTS, fromSave)));
    // 采信存档值是正路，不该被当成外部改写，把比对基线让给下一次 push
    lastPushed = null;
    return true;
  }

  // 用 state 覆盖面板副本：先清掉外部塞进来的野字段，再写入我们的值
  function pushToSlot(slot) {
    for (var k in slot) {
      if (Object.prototype.hasOwnProperty.call(slot, k) &&
          !Object.prototype.hasOwnProperty.call(DEFAULTS, k)) delete slot[k];
    }
    Object.assign(slot, snapshot());
    lastPushed = JSON.stringify(snapshotOf(slot));
  }

  // 诊断：副本与“我们上次写进去的那份”不一致时，说明中间有外部改写过它 ——
  // 正是玩家报“换个衣服就重置”时的那一步。值照旧被我们盖回去，这里只在
  // 控制台留一条线索，同一种改法只报一次，免得刷屏。
  // 面板点选与开局/读档采信存档副本是两条正路，分别用 fromPanel 与
  // lastPushed 基线重置排除掉。
  var lastPushed = null;
  var lastReported = '';
  var fromPanel = false;
  function noteExternalReset(slot) {
    if (lastPushed === null || fromPanel) return;
    // 键整个没了（我们刚建了个空 slot）不算改写，那种情况直接盖回就行
    if (!hasSaveSettings(slot)) return;
    var current;
    try { current = JSON.stringify(snapshotOf(slot)); } catch (e) { return; }
    if (current === lastPushed || current === lastReported) return;
    lastReported = current;
    console.log('[小小PC] $options.litterpc 被外部改成 ' + current + '，已按本地设置盖回');
  }

  // 只取我们的字段，避免外部塞进来的野字段干扰比对
  function snapshotOf(obj) {
    var o = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = obj[k];
    }
    return o;
  }

  // 不做防抖：滑块一次拖动也就几十个值、每个几百字节，
  // 换来确定性，比省几次写入值得。
  function commit() {
    writeState(snapshot());
  }

  function writeState(snap) {
    writeLS(LS_STATE, snap);
    writeSS(SS_STATE, snap);
  }

  // 位置同样只存本地，并和设置一样留一份 sessionStorage 镜像：
  // 主键被外部清掉时不至于把玩家摆好的位置也丢了。
  function posLoad() {
    var p = readLS(LS_POS) || readSS(SS_POS);
    if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') {
      var legacy = readLS(LS_LEGACY);
      var lp = legacy && legacy.pos;
      p = (lp && typeof lp.left === 'number' && typeof lp.top === 'number')
        ? lp : { left: -1, top: -1 };
    }
    return { left: p.left, top: p.top };
  }

  var pos = posLoad();
  writePos();                   // 把读到的值（含旧版迁移来的）也留一份页签镜像
  var posTimer = null;

  function writePos() {
    var snap = { left: pos.left, top: pos.top };
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

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */
  var wrap = null, host = null, bgCanvas = null, bgCtx = null;
  var booted = false;
  var retryCount = 0;
  var slowRetryTimer = null;
  var slowRetryCount = 0;
  var rafId = null, lastDraw = 0, lastSrc = null;

  // <<updatesidebarimg>> 挂钩状态（见 ensureSidebarHook）
  var SIDEBAR_MACRO = 'updatesidebarimg';
  var SIDEBAR_MAX_TRIES = 20;        // 退避重试次数，够覆盖开局几秒的初始化窗口
  var sidebarInstalled = false;      // 顶层确实是我们那一层（挂成功后不再重试）
  var sidebarOriginal = null;        // wrapper 里转调的下一层 handler
  var sidebarRunning = false;        // 调用链绕回自己时的闸门
  var sidebarTimer = null;
  var sidebarTries = 0;
  var liveFrame = 0;                 // 本帧已经排了的换装重画

  function displayedSize() { return Math.round(BASE * state.scale); }

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

  // 框架的 clearBox() 会对 target 做 removeAttribute('style')，
  // 因此写在 host 上的内联样式必须在每次 render 之后重新施加。
  function applyClip() {
    if (!host) return;
    var l = state.clip === CLIP_CLOSEUP ? INSET_LEFT : 0;
    var r = state.clip === CLIP_MODEL ? INSET_RIGHT : 0;
    host.style.clipPath = (l || r) ? 'inset(0 ' + r + '% 0 ' + l + '%)' : '';
  }

  function applyPresentation() {
    if (!wrap) return;
    var size = displayedSize();

    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';
    wrap.style.display = (state.enabled && contentReady()) ? 'block' : 'none';
    wrap.classList.toggle('litterpc-locked', !!state.clickThrough);

    host.style.display = isBg() ? 'none' : 'block';
    bgCanvas.style.display = isBg() ? 'block' : 'none';
    bgCanvas.style.width = size + 'px';
    bgCanvas.style.height = size + 'px';

    var p = renderPos();
    wrap.style.left = p.left + 'px';
    wrap.style.top = p.top + 'px';

    applyClip();
    updatePosLabels();
  }

  // 渲染坐标：只在显示时夹紧，绝不写回 pos。
  // 视口变小（例如打开调试台）时模型贴边可见，
  // 视口恢复后仍回到 pos 里保存的原位置。
  function renderPos() {
    var w = displayedSize(), h = w;
    var l = pos.left, t = pos.top;
    if (l < 0 || t < 0) {
      l = window.innerWidth - w - 20;
      t = window.innerHeight - h - 20;
    }
    return {
      left: clamp(l, 0, Math.max(0, window.innerWidth - w)),
      top: clamp(t, 0, Math.max(0, window.innerHeight - h))
    };
  }

  /* ------------------------------------------------------------------ *
   * 角色模型：交给框架的公开 render，画进我们自己的 host
   * ------------------------------------------------------------------ */
  // 框架的 Pet/FloatingPet 是单实例，内部记着 container/canvas/model。
  // 我们 render 之后 container 就是 host，框架下次 sync()/mount()/unmount()
  // 都会对 container 做 clearBox() —— 画布和写在 host 上的内联样式（mask
  // 就在里面）会被一起清掉。所以成功后把引用交还：container 置空，
  // 框架的清理落不回我们头上（FloatingPet.unmount 里是
  // this.container ?? document.getElementById(...)，走它自己的元素）。
  // canvas/model 置空，则它不会再去 stop 我们这张画布的动画。
  function relinquishPet(pet) {
    try {
      pet.container = null;
      pet.canvas = undefined;
      pet.model = undefined;
    } catch (e) {}
  }

  // 框架的 render 内部会先 stopAnimation() 再 draw，但它只能停 this.canvas
  // 那一张 —— 交还引用之后那张画布归我们自己管。所以重画前按同样的路子
  // 把 host 上那张画布的动画停掉，免得每次换段落都叠一个新的动画循环。
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

  // 框架的 Pet.capture 只在 CanvasModels.pet 不存在时才把 main 抄一份：
  //   capture(e){let t=rv.renderer.CanvasModels;if(!e?.layers||t.pet)return;...}
  // 那份快照建好之后就一直是旧穿着（衣柜里 DoL 只重建 CanvasModels.main，
  // 不碰 pet），我们每次 render 走的又是 `r.pet||this.capture(r.main)`，
  // 于是换装后重画还是拿到初始着装 —— 只有等游戏自己清掉 CanvasModels
  // （换段落、读档）才看起来“关衣柜才更新”。所以每次 render 前显式作废，
  // 让框架按当下的 main 重捕。这个槽位本来就是框架自有的（它自己也这么建），
  // 我们没有别的使用者。
  function invalidatePetCapture() {
    try {
      var CM = window.Renderer && window.Renderer.CanvasModels;
      // 只在真有快照时作废：把不存在的键写成 null 会让 CanvasModels 多出
      // 一个空槽，DoL 自己遍历它的地方不少，没必要冒这个风险。
      if (CM && CM.pet) CM.pet = null;
    } catch (e) {}
  }

  // DoL 每次换装都是 <<updatesidebarimg>> 重画侧栏（衣柜里点“穿上”不换段落），
  // 框架的实时跟随靠的正是把同一个宏包一层、每次都 pet.sync()：
  //   e.once(":storyready",()=>{let n=...Macro.get("updatesidebarimg");
  //     n&&e.tool.macro.define("updatesidebarimg",function(){n.handler.call(this),t.sync()})})
  // 我们把框架那份关掉了（resolveFrameworkPet），sync 这条实时路径就断了，
  // 于是只能靠换段落才更新 —— 衣柜里换完衣服模型不动，关了衣柜才动。
  // 这里按同一个套路接回去，但目标是我们自己的 host。
  //
  // 框架也是这么读注册表的，所以 get/has/delete 都按存在处理；真要哪天读不到，
  // 认不出来时就不挂，换段落那条兜底路径照常工作。SCML 的 :storyready 与
  // 框架谁先执行没有保证，宏本身也可能要到 storyinit 才注册，所以按 0.5s
  // 退避重试；每轮 :storyloaded 重新给一次预算。
  function macroRegistry() {
    var SC = window.SugarCube;
    var M = (SC && SC.Macro) || window.Macro;
    if (!M || typeof M.add !== 'function' || typeof M.has !== 'function' ||
        typeof M.get !== 'function' || typeof M.delete !== 'function') return null;
    return M;
  }

  function sidebarWrapperFn() {
    var result;
    // 链路绕回自己时只走一层：框架可能把我们又接到它自己那层上面，
    // 没有这道闸就会互相转调下去。
    if (sidebarRunning) { queueLiveRender(); return result; }
    sidebarRunning = true;
    try {
      if (sidebarOriginal) result = sidebarOriginal.apply(this, arguments);
    } finally {
      // 原来那一层抛错时不吞：让 SugarCube 照旧按它自己的方式报错，
      // 但我们的重画照样排上（用 finally 保证这一点）。
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

  // 沿用读到的那份描述符，只换掉 handler：是不是 widget、要不要跳参数，
  // 都该跟 DoL 原本注册时一致，我们自己猜不准。注册表形状照框架的用法：
  //   install(e,t){let n=this.Macro;n.has(e)&&n.delete(e),n.add(e,t)}
  //   let n=...Macro.get("updatesidebarimg"); ... n.handler.call(this)
  // 挂完再回读一次确认，避免静默失效（失败就继续退避重试）。
  function installSidebarHook(M, def, original) {
    try {
      sidebarOriginal = original;
      if (M.has(SIDEBAR_MACRO)) M.delete(SIDEBAR_MACRO);
      M.add(SIDEBAR_MACRO, Object.assign({}, def, { handler: sidebarWrapperFn }));
    } catch (e) {
      // add 失败时宏已经被我们删掉了，必须原样放回去
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
    return true;
  }

  // 挂成功就不再抢顶层：框架要是随后又把我们盖在下面，它的 handler 里
  // 照样会转调我们的 wrapper，换装实时重画那条路还在 —— 再抢只会让两边
  // 互相把对方当下一层，越套越深。没挂上时按 0.5s 退避重试。
  //
  // 唯一要重新接管的时候是“顶层已经不是我们的了、而且下面也没我们的层”：
  // 读档换存档时 DoL 的 storyinit 脚本会重跑，宏是被重新注册的，那时
  // :storyloaded 会把 sidebarInstalled 清掉，这里就会重新挂一次。
  function ensureSidebarHook() {
    var M = macroRegistry();
    if (!M) return;

    var def = null;
    try { if (M.has(SIDEBAR_MACRO)) def = M.get(SIDEBAR_MACRO); } catch (e) {}
    // 宏还没注册（DoL 要到 storyinit 前后才加）或读不到 handler：再试
    if (!def || typeof def.handler !== 'function') {
      if (sidebarTries < SIDEBAR_MAX_TRIES) {
        sidebarTries++;
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(ensureSidebarHook, 500);
      }
      return;
    }
    // 顶层已经是我们的：什么都不用做（读档后重新对账时最常走这条）
    if (def.handler === sidebarWrapperFn) { sidebarInstalled = true; return; }
    if (sidebarInstalled) return;
    installSidebarHook(M, def, def.handler);
  }

  // 换装重画。每帧最多排一次：宏可能一次更新里连发多次。
  // 排到下一帧而不是就地画：一是省（DoL 一次更新常连发好几个宏），二是
  // 框架自己也是这么排的（sync() 里 requestAnimationFrame 再 render），
  // 那一帧之后侧栏模型才是新的。
  function queueLiveRender() {
    if (!booted || isBg() || !state.enabled || !host) return;
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(function () {
      liveFrame = 0;
      if (!booted || isBg() || !state.enabled) return;
      // 这一次更新里框架那份可能被游戏又打开过，先消解再画，
      // 免得实时重画反而把第二个小人一起带出来（v1.2.0 的那个问题）。
      resolveFrameworkPet();
      // 成功之后补一次呈现：之前 host 被清掉时整块是隐藏的，
      // 只调 render 的话画上了也看不见。
      if (renderCharacter()) applyPresentation();
    });
  }

  // 进入游戏后自动同步一次当前模型。
  // 为什么需要它：开局我们画的那一次，多半早于游戏把侧栏模型按存档穿着
  // 重建好（实测开局 setup 比 :storyready 晚好几秒，侧栏图标还要更晚），
  // 于是画面上留在初始着装；之后没有新的换装事件就没人再补画，只能靠玩家
  // 手动点开关或开合衣柜。这里在进游戏/读档之后按几个时间点各重画一次，
  // 把画面拉回游戏当前的穿着。每次重画前都会作废框架那份快照
  // （invalidatePetCapture），所以拿到的一定是当下的侧栏模型。
  //
  // 时间点要跨过"游戏 setup 晚好几秒"这段：只补一发的话，画早了还是画早了。
  // 最晚一档到 8s，是因为实测 setup.clothes 比 :storyready 晚好几秒，而这一串
  // 是从第一个段落才起算的 —— 两秒封顶会漏掉慢一点的机器。
  // 固定几步、跑完就结束，不做常驻轮询；重画出来的就是同一套穿着，画面
  // 看不出变化，代价与框架自己在每个段落末尾重画一次同量级。
  var GAME_SYNC_AT = [400, 1500, 4000, 8000];
  var gameSyncTimers = [];
  var entryPassages = 0;         // 本轮进游戏/读档后是否已经补过自动同步

  function resyncToGame() {
    if (!booted || isBg() || !state.enabled) return;
    resetRetryBudget();
    apply();
  }

  function clearGameSync() {
    for (var i = 0; i < gameSyncTimers.length; i++) clearTimeout(gameSyncTimers[i]);
    gameSyncTimers.length = 0;
  }

  function scheduleGameSync() {
    clearGameSync();
    for (var i = 0; i < GAME_SYNC_AT.length; i++) {
      gameSyncTimers.push(setTimeout(resyncToGame, GAME_SYNC_AT[i]));
    }
  }

  function renderCharacter() {
    var pet = frameworkPet();
    if (!pet) { scheduleRetry(); return false; }

    // 游戏本体没就绪时先不调 render。
    // 实测（v1.0.2 日志）：早调会走进 DoL 的 CanvasModel.preprocess，
    // 那里读还没建好的 setup.clothes.handheld；异常被 DoL 自己的 compile
    // 捕获，pet.render 照样返回 true、canvas 照样挂上，只是画布全空。
    // 旧版据此以为成功、停止重试，模型永久空白，只能靠玩家手动重开开关。
    if (!gameReady()) { scheduleRetry(); return false; }

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
      // 成功之后必须连闸门一起清：只 clearTimeout 的话 retryPending 会
      // 一直停在 true，之后每次 scheduleRetry 都直接 return，重试链死锁
      clearRetry();
      retryCount = 0;
      slowRetryCount = 0;
      // 把单实例的引用交还给框架，详见 relinquishPet 的说明
      relinquishPet(pet);
      host.style.display = isBg() ? 'none' : 'block';
      applyClip();
    } else {
      scheduleRetry();
    }
    return ok;
  }

  // 开局游戏本体的 setup 还没建完（实测比 :storyready 晚好几秒），
  // 所以要重试到就绪为止：前 30 次按帧（覆盖“只慢一帧”），之后降到 1 秒一次。
  // 降频有上限，不做常驻轮询——换段落事件会再给一轮预算。
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

  // 重新给一轮重试预算。换段落和玩家动设置都算“我现在就要看到模型”。
  function resetRetryBudget() {
    retryCount = 0;
    slowRetryCount = 0;
  }

  // 当前是否还在等一个角色模型
  function needsCharacter() {
    if (!booted || isBg() || !state.enabled) return false;
    // 框架没安装就永远等不到
    if (!window.maplebirch) return false;
    return !characterMounted();
  }

  function characterMounted() {
    return !!(host && host.querySelector('canvas'));
  }

  // 当前模式下是否真的有内容可显示。没有内容时必须整块隐藏，
  // 否则留下一个透明的方块挡住它覆盖区域的点击。
  function contentReady() {
    return isBg() ? !!lastSrc : characterMounted();
  }

  /* ------------------------------------------------------------------ *
   * 背景模式
   * ------------------------------------------------------------------ */
  function isDrawable(el) {
    return el instanceof HTMLCanvasElement || el instanceof HTMLImageElement;
  }

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

  function drawOnce() {
    if (!bgCtx) return false;
    var src = pickSource();
    if (!src) return false;
    try {
      if (src !== lastSrc || bgCanvas.width !== src.width || bgCanvas.height !== src.height) {
        bgCanvas.width = src.width;
        bgCanvas.height = src.height;
        lastSrc = src;
      }
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      bgCtx.drawImage(src, 0, 0);
      return true;
    } catch (e) { return false; }
  }

  function startBgLoop() {
    if (rafId) return;
    var tick = function (now) {
      if (!state.enabled || !isBg()) { rafId = null; return; }
      if (now - lastDraw >= FRAME_MS) {
        lastDraw = now;
        // 刷新后开局这几帧多半还抓不到 .mainCanvas（DoL 要到 :storyready
        // 之后的初始化段落才画侧栏），所以整块是隐藏的（contentReady() 认
        // lastSrc）。循环本来就会持续抓到，但显隐只在 apply() 末尾算过一
        // 次，于是画成了也看不见 —— 显示背景模式刷新后空白、非得手动点
        // 开关或开合一次衣柜才出现，就是这么来的。这里就地补一次呈现。
        if (drawOnce() && wrap && wrap.style.display !== 'block') applyPresentation();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopBgLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    lastSrc = null;
  }

  /* ------------------------------------------------------------------ *
   * 统一入口
   * ------------------------------------------------------------------ */
  function apply() {
    if (!booted) return;
    bindState();
    // 先消解冲突再画：两边抢的是同一个单实例
    resolveFrameworkPet();
    if (!ensureShell()) return;

    if (isBg()) {
      stopBgLoop();
      host.textContent = '';
      startBgLoop();
      drawOnce();
    } else {
      stopBgLoop();
      if (bgCtx) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      // 模型关着就别占单实例：那时框架桌宠归玩家自己用，
      // 我们每段都重画反而会把它的画布抢走（两边按事件反复拉扯）。
      if (state.enabled) renderCharacter();
    }
    applyPresentation();
  }

  // state 与面板副本分家后，面板的新值得由“哪个字段被改了”这条线索取回来。
  // 只认 key，其余字段一律以 state 为准 —— 外部同期写进副本的其他字段
  // （往往是默认值）不会被我们采信，这正是 v1.1.0 被“连坐”的那一步。
  function normalizeField(key, value) {
    switch (key) {
      case 'enabled': return value !== false;
      case 'clickThrough': return !!value;
      case 'mode': return value === MODE_BG ? MODE_BG : MODE_CHAR;
      case 'clip': return (value === CLIP_CLOSEUP || value === CLIP_MODEL) ? value : CLIP_FULL;
      case 'scale':
        var s = Number(value);
        return isFinite(s) ? clamp(s, MIN_SCALE, MAX_SCALE) : DEFAULTS.scale;
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
    if (state[key] === next) return false;        // 没变化，别白折腾渲染
    state[key] = next;
    return true;
  }

  function changed(key) {
    if (key) adopt(key);
    // 先落盘再 apply：apply 里的 bindState() 会用持久值归位，晚落盘就把
    // 玩家刚改的值压回去了。
    commit();
    if (!booted) return;
    // 玩家动了设置就是明确要模型出现，重试预算重新一轮
    resetRetryBudget();
    fromPanel = true;         // 这次副本与我们的差异是玩家自己改的，别报成外部改写
    try {
      apply();
    } finally {
      fromPanel = false;
    }
  }

  function set(key, value) {
    bindState();
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return;
    state[key] = value;
    changed();
  }

  /* ------------------------------------------------------------------ *
   * 拖拽：单套 Pointer Events
   * ------------------------------------------------------------------ */
  var drag = null;

  function bindDrag() {
    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('pointermove', onPointerMove);
    wrap.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', onResize);
  }

  function onPointerDown(e) {
    if (!state.enabled || state.clickThrough) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 以当前实际显示位置为基准，否则 pos 与显示位置不一致时
    // 首次移动会按差值跳一下
    var p = renderPos();
    pos.left = p.left;
    pos.top = p.top;
    drag = { id: e.pointerId, dx: e.clientX - p.left, dy: e.clientY - p.top };
    wrap.classList.add('litterpc-dragging');
    try { if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    var size = displayedSize();
    pos.left = clamp(e.clientX - drag.dx, 0, Math.max(0, window.innerWidth - size));
    pos.top = clamp(e.clientY - drag.dy, 0, Math.max(0, window.innerHeight - size));
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

  // 视口变化只影响显示，不改写 pos：
  // 调试台等导致的临时缩小不应该毁掉玩家摆好的位置。
  function onResize() {
    if (!wrap) return;
    applyPresentation();
  }

  function resetPos() {
    pos.left = -1;
    pos.top = -1;
    var p = renderPos();
    pos.left = p.left;
    pos.top = p.top;
    applyPresentation();
    writePos();
  }

  /* ------------------------------------------------------------------ *
   * 面板事件
   * 写入全部由 SugarCube 宏完成（<<checkbox>> / <<radiobutton>> 绑定
   * $options.litterpc.*）。state 与那份副本分家，所以收尾时必须带上
   * “刚改的是哪个字段”，changed(key) 只从副本取这一个字段，其余照旧。
   * 控件归属用容器上的 data-lpc 标记，不依赖宏的属性透传。
   * 宏的 handler 绑在元素上，先于这里的 document 级委托执行。
   * ------------------------------------------------------------------ */
  // 冲突消解入口。必须同步做完，不要延后到帧：
  // 框架的 Pet.sync() 两个分支都会先 this.cancel() 再排 rAF 去 mount，
  // 所以只要我们在它之后调用一次 sync()，它那帧预约的 mount 就被取消；
  // 反过来我们排在它之前也没关系，它读到的开关已经是关的，走 unmount。
  // 两头都会收敛，且不需要每帧检查。
  //
  // 触发时机：每次 apply（含 :passagedisplay、读档、面板改动）、
  // :passageend（框架自己的 sync 挂在这里，比我们晚一个事件）、以及
  // 玩家在框架面板里拨桌宠开关的那条 change —— 那条路不经过换段落。
  // 框架的开关是 delegated 在 document 上、且它先注册，所以它的 change
  // 里已经排好的 mount 会被我们这次的 sync() 取消掉。
  function reconcileFrameworkPet() {
    if (!booted) return;
    resolveFrameworkPet();
    // host 被抢走或清空过就要重画；正常情况这里什么都不做。
    if (!isBg() && state.enabled && !characterMounted()) {
      resetRetryBudget();
      apply();
    }
  }

  function onPanelEvent(e) {
    if (e.type !== 'change') return;                       // 滑块走 onInputChange，不经此处
    var el = e.target && e.target.closest ? e.target.closest('input') : null;
    if (!el || el.type === 'range') return;
    // 框架桌宠相关控件：名字与框架自己绑 updatePet 的选择器一致
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

  function updatePosLabels() {
    var list = document.querySelectorAll('.lpc-pos');
    for (var i = 0; i < list.length; i++) {
      list[i].textContent = 'X=' + Math.round(pos.left) + ', Y=' + Math.round(pos.top);
    }
  }

  /* ------------------------------------------------------------------ *
   * 与框架桌宠的冲突消解
   *
   * 同一个 Pet 单实例容不下两个使用者：谁后 render 谁占住画布。
   * 本模组的模型开关开着时，框架那份必须是关的；关掉前先记下玩家
   * 原本的开关（litterpc.frameworkPetPrev），本模组关掉时再原样还回去。
   * v1.1.0 的“一次性接管”之所以出问题：接管之后框架那份会被游戏重置回
   * “开”（框架自己也有往 #maplebirch-character-pet 渲染的路径），我们
   * 不再干预，两个小人就并存了 —— 现在按事件持续消解，不轮询。
   * ------------------------------------------------------------------ */
  var petPrevKnown = false;
  var petPrev = false;

  function frameworkPetOption() {
    var V = sugarV();
    var mb = V && V.options && V.options.maplebirch;
    return (mb && mb.character && mb.character.pet) || null;
  }

  function resolveFrameworkPet() {
    // 换装实时重画的入口在这里：这个函数每次 apply（含 :passagedisplay、
    // 读档、面板改动）与 :passageend 都会走，宏挂没挂上一并在这里对账。
    ensureSidebarHook();

    // 本模组的模型开关开着，就别再留框架那份桌宠：背景模式下它虽然不抢
    // 单实例，但会和我们的画布同屏，正是玩家截图里的“第二个小人”。
    // 关掉前先记下玩家原本的开关，等本模组关掉时再原样还回去。
    var ours = booted && state.enabled;
    var opt = frameworkPetOption();

    if (opt) {
      if (!petPrevKnown) {
        var stored = readLS(LS_PET_PREV);
        if (typeof stored !== 'boolean') {
          // 老版本只留了接管标记、没留原值：按“原本就是关的”处理，不擅自还原
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

    // 开局 :storyready 时 V 可能还不存在，上面这段读不到框架选项，框架那份
    // 桌宠照样会渲染进它自己的元素。这里补一刀：不依赖 V，直接清空它的容器。
    // 我们每次 render 前都会走这里，进段落也会，所以两个小人不会并存。
    if (ours) {
      var theirEl = document.getElementById(FW_PET_ELEMENT_ID);
      if (theirEl && theirEl.firstChild) theirEl.textContent = '';
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */
  function init() {
    if (booted) return;
    if (!document.body) { setTimeout(init, 50); return; }
    booted = true;

    adoptFromSave();          // 脚本比 V 更早求值时，这里才补得上存档副本
    bindState();
    ensureShell();
    apply();
    // 进入游戏后自动对一次账：开局我们多半在游戏的 worn / 侧栏模型就位之前
    // 就画了一次，画的是初始着装。玩家不该再手动点开关或开合衣柜。
    scheduleGameSync();

    document.addEventListener('change', onPanelEvent);
    // 设置已改成同步落盘，只有位置还是防抖的，离开页面前补一次
    window.addEventListener('pagehide', function () {
      if (posTimer) savePos();
    });

    // 换段落时重画一次。这是原版实测可用的自愈路径，也是唯一不需要轮询的
    // 补救时机：DoL 的 setup.clothes 与画布管线在首个 :passagedisplay 前后
    // 才补齐，而 init（:storyready）那时调 render 只会得到空白画布。
    $(document).on(':passagedisplay', onPassageEvent);

    // 框架的 pet.sync() 挂在 :passageend（比我们的 passagedisplay 晚），
    // 消解必须排在它之后，否则它会用刚被我们关掉的开关渲染出第二个小人。
    // SCML 不保证这个事件一定触发，所以它是补充时机，不是唯一依赖。
    $(document).on(':passageend', onPassageEndEvent);

    // 读档 / undo 会换掉 V 的对象图，面板副本需要重新归位
    $(document).on(':storyloaded', function () {
      if (!booted) return;
      // 换存档时 DoL 的 storyinit 脚本会重跑、宏是重新注册的，我们那一层
      // 已经没了：重试预算与挂装状态都要重新给一次
      sidebarInstalled = false;
      sidebarTries = 0;
      clearTimeout(sidebarTimer);
      adoptFromSave();
      pos = posLoad();
      apply();
      // 读档等同于重新进游戏：穿着是存档里的那一套，同样要等游戏侧就位
      entryPassages = 0;
      scheduleGameSync();
    });
  }

  function onPassageEvent() {
    if (!booted) return;
    // 框架在每个 :passageend 都会 pet.sync()，换装更是必触发；这里按事件
    // 把被它清掉的 host 重新画回来，不做轮询。apply() 里已经带了一次
    // 冲突消解，:passageend 那次由 onPassageEndEvent 补上。
    // 每进一个新段落重新给一轮重试预算（游戏 setup 就是在这前后才补齐的）
    if (!isBg() && !characterMounted()) resetRetryBudget();
    apply();
    // 真正"进入游戏"是第一个段落，脚本求值可能比它早得多 —— 自动同步的
    // 那几步要从这里重新起算才盖得住游戏侧的就位时间。只补第一个段落，
    // 之后的段落照常靠换段落与换装宏事件重画。
    if (entryPassages < 1 && !isBg()) {
      entryPassages++;
      scheduleGameSync();
    }
  }

  // :passageend 只做消解，不重画 —— 重画已由 :passagedisplay 负责，
  // 两边都画会让每个段落渲染两次。
  function onPassageEndEvent() {
    if (!booted) return;
    reconcileFrameworkPet();
  }

  // 单一入口守卫：避免 :storyready 与 readyState 兜底重复注册监听
  $(document).one(':storyready', init);
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function () {
      if (document.readyState !== 'loading') init();
    }, { once: true });
  } else {
    init();
  }

  /* ------------------------------------------------------------------ *
   * 对外接口
   * 只暴露 settings.twee 真正用到的成员。注意两处跨文件的字面量耦合：
   *   clip 的取值 'full' | 'closeUp' | 'modelOnly'
   *   scale 的区间 0.5 ~ 1
   * 都同时写在 settings.twee 的宏参数里，改动时必须同步。
   * ------------------------------------------------------------------ */
  window.FloatingSprite = {
    get data() { return bindState(); },
    get pos() { return { left: Math.round(pos.left), top: Math.round(pos.top) }; },
    ensure: bindState,
    set: set,
    changed: changed,
    resetPos: resetPos
  };
})();
