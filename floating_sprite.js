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
 *   - v1.6.0 改脸修复：捕 pet 前主动触发 <<updatesidebarimg>> 强制 main 重建，
 *     等一帧让框架的 pre-processor（改脸路径替换等）跑完再捕。旧版在
 *     :storyready / :passagedisplay 时直接捕，main 可能还没被预处理过，
 *     拿到的 pet 是默认脸；必须等玩家开衣柜触发一次 <<updatesidebarimg>> 才恢复。
 *     现在前 10 个段落每次 :passagedisplay 都先触发重建再捕，game sync 的时间窗口
 *     也从 8s 拉长到 30s。另外加了 MutationObserver 盯 .mainCanvas 元素替换，
 *     在 sidebar hook 没挂上时兜底重捕。
 *   - 裁掉画布四周的透明空白（两种模式都做）：只读像素量内容框，绝不调
 *     render —— 重演一次 1.4.x 的教训，我们每 render 一次框架就把 host 里的
 *     画布换成新的，DoL 挂在画布上的动画控制器跟着重建、时钟归零。模型模式
 *     因此只在显示层裁：框架 mount() 只 Object.assign host 的 width/height/
 *     overflow/mask，从不写 left/top，我们就把 host 负偏移、wrap 收成内容
 *     大小再 overflow:hidden，画布本身一个像素都不碰。
 *     量出来的内容框跨模式切换保留（stopPetBoxWatch 只停表不清框）：清掉就得
 *     重量，那期间浮窗退回 256 见方、位置又按方框夹紧，表现为「切回模型模式先
 *     错位一下再回正」。旧框与新画布尺寸不符时按旧尺寸换算，抢拍重测到了再改。
 *     host 的负偏移和 clipPath 一样挂在 applyClip() 上，因为每次 render 之后
 *     框架的 clearBox() 会把 host 的内联样式整个抹掉。
 *
 * 状态存放（本地浏览器优先）：
 *   内存里的 state 是唯一权威，$options.litterpc 只是面板宏的绑定副本，
 *   每次都用 state 就地覆盖它 —— 绝不借用它的引用。这样换装、开衣柜这类
 *   操作就地改写或整体替换那份副本时，动不到我们的设置，也不会被我们
 *   误当成玩家的选择写进存储（v1.1.0 的 bug 就是这么来的）。
 *   state 的持久镜像：localStorage 的 litterpc.settings 与同名 sessionStorage
 *   各一份，读时按 localStorage > sessionStorage > 旧版键回退，任何一份被
 *   外部清掉都能自愈。
 *   litterpc.pet.position  仅位置；同样只存本地，并留同名 sessionStorage 镜像。
 *     自 v1.5.5 起存的是「源画布原点 (0,0) 的屏幕位置」，不再是浮窗左上角：
 *     两种模式各裁各的边，把窗口左上角钉在同一个数上，等于把两张不同画布上的
 *     两个不同点钉在一起，小人一换模式就偏。锚在画布原点上，呈现时再补每个模式
 *     自己的裁框偏移（anchor）。记录里的 ref 字段用来认出老口径并换算一次。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */
  var VERSION = '1.6.0';                              // 与 boot.json 同步，debug() 用它确认线上跑的是哪版
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
  // 不给出 0：整块透明后玩家找不到模型，也就没法再点回来
  var MIN_OPACITY = 0.1;
  var MAX_OPACITY = 1;

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
    opacity: 1,
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

    var o = Number(obj.opacity);
    obj.opacity = isFinite(o) ? clamp(o, MIN_OPACITY, MAX_OPACITY) : DEFAULTS.opacity;

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
  //
  // v1.5.5 起 pos 存的是「源画布原点 (0,0) 的屏幕位置」，不是浮窗左上角：
  // 两种模式各自裁边之后，把窗口左上角钉在同一个数上，等于把两张不同画布上
  // 的两个不同点钉在一起，小人一换模式就偏（背景 216x194 的框起点是 (24,0)，
  // 模型 152x165 的框起点是 (78,11)）。锚在画布原点上，两边呈现的是同一个
  // 源画面的同一个点，小人在屏幕上就不动了。代价是老数据要换算一次：
  // ref 不是 canvas 的存档仍是「窗口左上角」口径，等第一次量出裁框偏移时扣掉，
  // 扣完当前这个模式的画面位置跟升级前一模一样。
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
    // 老口径：负数是「还没摆过」的哨兵，照旧按没摆过处理；正数才需要换算。
    if (p.left < 0 || p.top < 0) return { left: null, top: null, ref: POS_REF, rescale: false };
    return { left: p.left, top: p.top, ref: POS_REF, rescale: true };
  }

  var pos = posLoad();
  writePos();                   // 把读到的值（含旧版迁移来的）也留一份页签镜像
  var posTimer = null;

  function posKnown() {
    return typeof pos.left === 'number' && typeof pos.top === 'number';
  }

  function writePos() {
    var snap = { left: pos.left, top: pos.top };
    // 还没换算的老数据不要提前打上 ref：打了就等于宣称「这串数字已经是画布
    // 原点口径」，万一换算前页面被关掉，那个一次性跳偏移就永久留在档里了。
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

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */
  var wrap = null, host = null, bgCanvas = null, bgCtx = null;
  var booted = false;
  var retryCount = 0;
  var slowRetryTimer = null;
  // v1.6.0 防闪烁：pet.render() 每次都会替换 host 里的画布（动画控制器重建、时钟归零
  // → 视觉上闪一下）。如果画布还在且模型内容没变，就不该重画。
  // 判据三层：
  //   1. forceRerender：设置变了、读档 → 必须重画
  //   2. lastMainRef：CanvasModels.main 的对象引用变了 → 模型被重建 → 重画
  //   3. lastContentSig：V.worn + 脸的内容签名变了 → 即使引用没变（DoL 可能
  //      原地改 main）也要重画。这条是兜底，防引用不变但内容变了被漏掉。
  // 普通段落过渡三者都不变 → 跳过 → 不闪。
  var forceRerender = false;
  var lastMainRef = null;
  var lastContentSig = null;
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
  // v1.6.0：侧栏画布的 MutationObserver，sidebar hook 没挂上时的兜底路径。
  // 监听 .mainCanvas 元素被替换（<<updatesidebarimg>> 重建侧栏时会发生），
  // 触发后延迟一帧捕 pet——此时 main 已经被预处理过，改脸路径已替换。
  var sidebarObserver = null;
  var sidebarReCaptureFrame = 0;     // 防抖：同一帧只排一次兜底重捕

  function displayedSize() { return Math.round(BASE * state.scale); }

  // 浮窗该占多大（CSS 像素）。模型模式量不出内容框时沿用老规矩：正方形
  // BASE*scale，框架要的就是这个基准。量得出来就是裁完空白的实际画面大小。
  // 背景模式 = 裁完边的 bgCanvas * state.scale。两种模式下「缩放倍率」都表示
  // 原始像素的百分比，不再把一张非正方形的画面硬拉进正方形框里。
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

  // 裁边把窗口左上角挪到了源画布里的 (box.x, box.y)，换算成 CSS 像素就是
  // 这里的 anchor。pos 存的是画布原点，呈现时把这段补回去，窗口左上角才落在
  // 画布原点右下方对应的位置 —— 这样两种模式切换时小人在屏幕上不动。
  var NO_ANCHOR = { x: 0, y: 0 };

  function contentAnchor() {
    if (isBg()) {
      var b = bgState.box;
      // 量不到框时 bgCanvas 是整张拷贝、displayedDims 也按整张算，原点没挪
      if (!b) return NO_ANCHOR;
      return { x: Math.round(b.x * state.scale), y: Math.round(b.y * state.scale) };
    }
    var crop = petCrop();
    // petCrop 的 left/top 是负偏移，取负就是这段空白原本的宽度
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

  // 框架的 clearBox() 会对 target 做 removeAttribute('style')，
  // 因此写在 host 上的内联样式必须在每次 render 之后重新施加。
  // clipPath 和裁边的负偏移是同一类东西：都在 host 上、都会被 clearBox 抹掉，
  // 所以都放这里，别指望 applyPresentation 被调到（重画路径只调 applyClip）。
  function applyClip() {
    if (!host) return;
    var l = state.clip === CLIP_CLOSEUP ? INSET_LEFT : 0;
    var r = state.clip === CLIP_MODEL ? INSET_RIGHT : 0;
    host.style.clipPath = (l || r) ? 'inset(0 ' + r + '% 0 ' + l + '%)' : '';
    // 模型模式的裁边：wrap 已经收成内容大小并 overflow hidden，把 host 往
    // 左上挪掉空白那段，露出来的就正好是画着东西的那块。
    var crop = isBg() ? null : petCrop();
    host.style.left = crop ? crop.left + 'px' : '0px';
    host.style.top = crop ? crop.top + 'px' : '0px';
  }

  function applyPresentation() {
    if (!wrap) return;
    var dims = displayedDims();
    rescalePos();

    wrap.style.width = dims.w + 'px';
    wrap.style.height = dims.h + 'px';
    wrap.style.display = (state.enabled && contentReady()) ? 'block' : 'none';
    wrap.style.opacity = state.opacity;
    wrap.classList.toggle('litterpc-locked', !!state.clickThrough);

    host.style.display = isBg() ? 'none' : 'block';
    bgCanvas.style.display = isBg() ? 'block' : 'none';
    bgCanvas.style.width = dims.w + 'px';
    bgCanvas.style.height = dims.h + 'px';

    var p = renderPos();
    wrap.style.left = p.left + 'px';
    wrap.style.top = p.top + 'px';

    // host 的裁边偏移在 applyClip 里施加（那边管的是每次 render 后会被
    // clearBox 抹掉的样式），这里只负责 wrap 的尺寸。
    applyClip();
    updatePosLabels(p);
  }

  // 老存档的一次性换算（v1.5.5 的 ref 口径迁移）。以前这段挂在 renderPos
  // 里，结果「算个位置」会顺手写存储，而面板取值与 debug() 都算读位置 ——
  // 探测函数不该改状态。v1.5.7 起搬到呈现与按下拖拽之前，renderPos 是纯读。
  function rescalePos() {
    if (!pos.rescale) return;
    var a = contentAnchor();
    // 还没量出裁框就先不扣：老数字在那个时机就等于新口径，等真偏移出来
    // 再换算，画面一步不动。
    if (!a.x && !a.y) return;
    pos.left -= a.x;
    pos.top -= a.y;
    pos.rescale = false;
    writePos();
  }

  // 渲染坐标：pos 是画布原点，窗口落在原点 + anchor 上；纯读，既不写 pos
  // 也不写存储（换算由 rescalePos 负责）。只在显示时夹紧，视口变小（例如
  // 打开调试台）时模型贴边可见，视口恢复后仍回到 pos 里保存的原位置。
  // 夹紧的是窗口（画面不许出屏），夹的边界用当前模式自己的窗口尺寸 ——
  // 但起点是同一个画布原点，所以不贴边的时候两种模式切换完全不跳。
  function renderPos() {
    var d = displayedDims(), w = d.w, h = d.h;
    var a = contentAnchor();
    var l = pos.left, t = pos.top;
    if (!posKnown()) {
      // 还没摆过：按画面贴右下
      l = window.innerWidth - w - a.x - 20;
      t = window.innerHeight - h - a.y - 20;
    }
    return {
      left: clamp(l + a.x, 0, Math.max(0, window.innerWidth - w)),
      top: clamp(t + a.y, 0, Math.max(0, window.innerHeight - h))
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

  /* ------------------------------------------------------------------ *
   * 动画跟随（v1.6.0）
   *
   * 问题：pet.render() 每次替换 host 里的画布 → DoL 的按画布动画控制器
   * 重建、时钟归零，而侧栏那个控制器一直活着 → 两边动画错开。
   *
   * 修法（H 方案）：不自己跑动画时钟，改为跟随侧栏的 keyframe 事件。
   * 包一层 Renderer.animateLayers，只在目标是侧栏画布时把 listener 克隆
   * 一份，在克隆体的 keyframe 回调里把帧号/关键帧属性写到我们的控制器上
   * 再调 redraw()。渲染完立刻冻住我们自己的推进定时器（clearTimeout，
   * 不调 stop()），之后每一拍都由侧栏事件驱动 → 没有第二套时钟 → 不漂移。
   * ------------------------------------------------------------------ */

  var SIDEBAR_CANVAS_SEL = '#sidebar-img-container canvas.mainCanvas';
  var FOLLOW_MARK = '__litterpcFollowListener';
  var followPatched = false;
  var followOriginal = null;
  var followEvents = 0;
  var followDraws = 0;
  var followLast = null;

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

  // 冻住我们自己的推进定时器：逐条 clearTimeout，不调 stop()。
  // 链一断就再没有新的排程（scheduleNextKeyframe 只被 nextKeyframe 续），
  // 之后每一拍都由侧栏的 keyframe 事件驱动。
  function freezeOurAnimation() {
    var ac = ourAnimatingCanvas();
    if (!ac || !ac.animations) return;
    for (var i = 0; i < ac.animations.length; i++) {
      var a = ac.animations[i];
      if (a.timeoutId) { clearTimeout(a.timeoutId); a.timeoutId = 0; }
    }
  }

  // 复刻 DoL 的 applyKeyframe：把关键帧属性写到图层上。
  // layer.frames=[kf.frame]；dx/dy 特判成 frameDx/frameDy；
  // 其余按公开的 Renderer.AnimatableProps 照抄。
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

  // 把侧栏当前帧写到我们的控制器上：帧号 + keyframe + 图层属性。
  // 图层与侧栏共用时是同值重写；不共用（DoL 重建过 main 的图层）时
  // 它正是拉回同帧的那一步。
  function mirrorFrame(our, name, index, keyframe) {
    if (!our || !our.animations) return;
    for (var i = 0; i < our.animations.length; i++) {
      var a = our.animations[i];
      if (a.name !== name) continue;
      var kfCount = (a.keyframes && a.keyframes.length) || 0;
      a.keyframeIndex = kfCount > 0 ? (index % kfCount) : index;
      a.keyframe = keyframe;
      if (a.layers) applyKeyframeToLayers(a.layers, keyframe);
      break;
    }
  }

  // 渲染后从侧栏抄一次当前帧，对齐起点。
  function primeFromSidebar() {
    var sb = sidebarAnimatingCanvas();
    var our = ourAnimatingCanvas();
    if (!sb || !our || !sb.animations || !our.animations) return;
    for (var i = 0; i < sb.animations.length; i++) {
      var sa = sb.animations[i];
      if (sa.keyframe !== undefined) {
        mirrorFrame(our, sa.name, sa.keyframeIndex || 0, sa.keyframe);
      }
    }
    try { if (typeof our.redraw === 'function') our.redraw(); } catch (e) {}
  }

  // 克隆侧栏的 listener，只替 keyframe；其余函数包成转调原对象
  // （receiver 保持原 listener，DoL 内部用 this）。
  // 带 FOLLOW_MARK 的原样返回，防止 animateLayersAgain 重复套层。
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
      // 先跟帧再转调原 keyframe：我们出错也不会把侧栏那一拍带崩
      try {
        if (followWanted()) {
          var our = ourAnimatingCanvas();
          if (our) {
            mirrorFrame(our, name, index, keyframe);
            followEvents++;
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

  // 包 Renderer.animateLayers：只在目标是侧栏画布且 followWanted 时
  // 换成克隆 listener。只挂一次，被别人盖在上面也不抢回来。
  function ensureFollowPatch() {
    if (followPatched) return;
    var R = window.Renderer;
    if (!R || typeof R.animateLayers !== 'function') return;
    followOriginal = R.animateLayers;
    R.animateLayers = function (ctx, layerSpecs, listener, autoStop) {
      var l = listener;
      if (isSidebarTarget(ctx) && followWanted()) {
        l = followListener(listener);
      }
      return followOriginal.call(this, ctx, layerSpecs, l, autoStop);
    };
    followPatched = true;
  }

  // 读两边当前帧号，格式 “name#index”，用于 debug 对账。
  function animFrameStr(ac) {
    if (!ac || !ac.animations) return null;
    var parts = [];
    for (var i = 0; i < ac.animations.length; i++) {
      var a = ac.animations[i];
      parts.push(a.name + '#' + (a.keyframeIndex || 0));
    }
    return parts.join(',');
  }

  // DoL 每次换装都是 <<updatesidebarimg>> 重画侧栏（衣柜里点”穿上”不换段落），
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

  // v1.6.0：兜底路径。sidebar hook 可能因为宏注册晚、被别的模组覆盖等原因没挂上，
  // 这时 <<updatesidebarimg>> 重建侧栏后不会触发我们的 queueLiveRender()，
  // 改脸后的 main 模型不会被捕到 pet 里。MutationObserver 直接盯 DOM：
  // .mainCanvas 元素被替换（侧栏重建的典型特征）时排一次重捕。
  // 只在 hook 没挂上时生效——hook 在的时候它自己会处理，不需要 observer 重复触发。
  // 观察 document.body 的 subtree：侧栏可能在任何位置被重建。
  function onSidebarCanvasMutated(mutations) {
    if (!booted || isBg() || !state.enabled) return;
    // hook 已经挂上就不需要兜底
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
    // 防抖：同一帧只排一次
    if (sidebarReCaptureFrame) return;
    sidebarReCaptureFrame = requestAnimationFrame(function () {
      sidebarReCaptureFrame = 0;
      if (!booted || isBg() || !state.enabled || sidebarInstalled) return;
      // 侧栏画布被替换说明 <<updatesidebarimg>> 刚跑过，main 已经被预处理。
      // 等一帧让渲染管线跑完再捕。
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
      // v1.6.0 防闪烁：不再在这里设 forceRerender。<<updatesidebarimg>> 在每个
      // 段落过渡都会触发，如果每次都强制重画就会闪。renderCharacter() 里的
      // lastMainRef 引用比对会判断模型是否真的换了——换了才重画，没换就跳过。
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
  // v1.6.0：拉长尾部——改脸/BeautySelectorAddon 的预处理有时比 :storyready 晚十几秒，
  // 旧版 8s 封顶在慢机器上抓不到。每条都先触发 <<updatesidebarimg>> 强制 main 重建，
  // 再捕 pet，所以间隔不需要太密。
  var GAME_SYNC_AT = [500, 2000, 5000, 10000, 20000, 30000];
  var gameSyncTimers = [];
  var entryPassages = 0;         // 本轮进游戏/读档后是否已经补过自动同步

  // v1.6.0：主动触发一次 <<updatesidebarimg>>，让游戏按当前存档状态重建 CanvasModels.main。
  // 框架的 pre-processor（改脸路径替换、mask_src 等）只在 main 的渲染管线里跑，
  // 我们捕 pet 前必须确保 main 已经被完整处理过。<<updatesidebarimg>> 正是游戏里
  // 触发这条管线的标准入口——衣柜、换装、开局的侧栏重绘都走它。
  // 调用是同步的（Wikifier.wikifyEval 就地展开宏），但渲染管线内部可能排 rAF，
  // 所以调用方要等一帧再捕 pet。
  function triggerSidebarRebuild() {
    try {
      if (typeof Wikifier !== 'undefined' && typeof Wikifier.wikifyEval === 'function') {
        Wikifier.wikifyEval('<<updatesidebarimg true>>');
      }
    } catch (e) {}
  }

  // v1.6.0：限制 triggerSidebarRebuild 的调用次数。每次重建侧栏都会让侧栏画面
  // 闪一下，前 3 次够用（抓改脸初始化），之后只重画我们自己的 pet 就行。
  var syncRebuildCount = 0;
  var MAX_SYNC_REBUILDS = 3;

  function resyncToGame() {
    if (!booted || isBg() || !state.enabled) return;
    resetRetryBudget();
    // v1.6.0 防闪烁：画布已经挂上了就不强制重画。triggerSidebarRebuild 如果
    // 真的让 main 重建了（新对象引用），renderCharacter 里的 lastMainRef 比对
    // 会放行；没重建就跳过，不闪。只有画布还没挂上（初始渲染失败）时才强制。
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
      gameSyncTimers.push(setTimeout(resyncToGame, GAME_SYNC_AT[i]));
    }
  }

  // 框架桌宠的 draw 读的就是这份「侧栏已解析 options」当渲染参数：
  //   n=CanvasModelCaches?.main?.sidebar, r=n?.options ?? model.defaultOptions()
  // 缺失时回退 defaultOptions() → 裸体+默认脸。它比 CanvasModels.main 更晚建好
  // （要等侧栏真正渲染过一次），所以既是就绪信号，也是内容变化的权威来源。
  function sidebarCacheOptions() {
    try {
      var C = window.Renderer && window.Renderer.CanvasModelCaches;
      return (C && C.main && C.main.sidebar && C.main.sidebar.options) || null;
    } catch (e) { return null; }
  }

  // 内容签名：指纹化框架真正拿去渲染的那份侧栏 options。穿着/仪态/换形等
  // 任何改变画面的因素都会体现在这里；普通段落过渡 options 不变 → 签名不变。
  // 这比读 V.worn 更贴合画面（框架就是从这份画的），也覆盖缓存刚建好的那一跳。
  function contentSignature() {
    var o = sidebarCacheOptions();
    if (!o) return null;
    var keys = Object.keys(o);
    keys.sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = o[k];
      if (v === null || v === undefined) parts.push(k + '=');
      else if (typeof v === 'object') {
        if (Array.isArray(v)) parts.push(k + '[]' + v.length);
        else if (v.name !== undefined) parts.push(k + '=' + v.name);
        else parts.push(k + '={}' + Object.keys(v).length);
      } else parts.push(k + '=' + v);
    }
    return parts.join('|');
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

    // v1.6.0 就绪门：框架 draw 依赖的侧栏缓存 options 还没建好时，捕到的一定
    // 是 defaultOptions 的裸体+默认脸。等它出现再画，宁可不画也别画成裸体。
    if (!sidebarCacheOptions()) { scheduleRetry(); return false; }

    // v1.6.0 防闪烁：三层闸门——
    //   1. forceRerender 没设（没人明确要求重画）
    //   2. CanvasModels.main 的对象引用没变（模型没被游戏重建过）
    //   3. 侧栏缓存 options 的内容签名没变（框架就是照这份画的，签名=画面）
    // 三个都满足才跳过。任一变了就重画。普通段落过渡三者都不变 → 跳过 → 不闪。
    // 换装/改脸/开局缓存就位 → 引用或签名变 → 放行。
    var currentMain = (window.Renderer && window.Renderer.CanvasModels && window.Renderer.CanvasModels.main) || null;
    var currentSig = contentSignature();
    if (characterMounted() && !forceRerender &&
        currentMain === lastMainRef && currentSig === lastContentSig) return true;
    lastMainRef = currentMain;
    lastContentSig = currentSig;
    forceRerender = false;

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
      resetRetryBudget();
      // 把单实例的引用交还给框架，详见 relinquishPet 的说明
      relinquishPet(pet);
      // 能走到这里说明当前不是背景模式（apply 分流、needsCharacter、
      // resyncToGame 三条路都挡过），host 直接可见即可。
      host.style.display = 'block';
      applyClip();
      // 换装/换段落之后画面尺寸可能变，立刻重测一次内容框（at 清零绕过
      // BG_BOX_MS 节流）。只读像素，不再 render，所以不会碰动画时钟。
      petState.at = 0;
      refreshPetBox();
      // v1.6.0 动画跟随：渲染完立刻冻住我们自己的推进定时器，
      // 下一帧再从侧栏抄一次当前帧对齐起点（排下一帧是因为 DoL
      // 自己那次合成也在 rAF，busy 未清时 compose() 会 reject）。
      freezeOurAnimation();
      requestAnimationFrame(function () {
        freezeOurAnimation();
        primeFromSidebar();
      });
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

  // 游戏那张侧栏画布比它上面画的东西大：房间图不满幅，模型与特写各占一角，
  // 剩下的像素全是透明的（实测 264x256 的画布，内容只占 x=24..263、y=0..199，
  // 左边空 24、底下空 56）。整张拷过来，这圈透明就变成浮窗与导出图上的空白。
  // 两种模式都按「实际画出来的内容」裁：背景模式量我们自己的拷贝，模型模式
  // 量框架那张画布 —— 只读像素、不碰它的样式与 render，所以不会重演 1.4.x
  // 那种「我们一重画就把 DoL 的动画时钟清零」的老毛病。
  // alpha 低于下限算空白；重测最多每 BG_BOX_MS 一次；变窄要连续 BG_SHRINK_STREAK
  // 次量到同一个窄框才认，变宽立即认（宁可留白，不能切掉真画面）。
  var BG_ALPHA_MIN = 8;
  var BG_BOX_MS = 500;
  // 画布刚挂上时 DoL 未必已经把它画出来，那几拍量不到东西，密一点等它，
  // 最多抢 BG_BOX_FIRST_TRIES 拍，之后回到 BG_BOX_MS 的常态节奏。
  var BG_BOX_FIRST_MS = 120;
  var BG_BOX_FIRST_TRIES = 4;
  var BG_SHRINK_STREAK = 2;
  var BG_MIN_SIDE = 8;

  // srcW/srcH 记下「这个框是在多大的画布上量出来的」：框本身是那份画布的
  // 像素坐标，换算成 CSS 像素要除以它自己的那份尺寸，而不是现在这张的。
  // 画布中途变了大小（改缩放倍率最常见）时，先按比例解释旧框顶着用，
  // 下一次量边自然校正 —— 有了它才不会「先正方形闪一下」。
  function makeBoxState() { return { box: null, pending: null, pendingN: 0, at: 0, srcW: 0, srcH: 0, measured: false }; }
  function resetBox(st) {
    st.box = null; st.pending = null; st.pendingN = 0; st.at = 0;
    st.srcW = 0; st.srcH = 0; st.measured = false;
  }

  var bgState = makeBoxState();    // 背景模式：源画布坐标系
  var petState = makeBoxState();   // 模型模式：框架画布坐标系
  var fullCanvas = null, fullCtx = null;   // 离屏拷贝，两种模式共用一张来量边
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

  // 量出非透明像素的包围盒。读的是我们自己的 2D 拷贝，不会被画布污染挡住。
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

  // 保证离屏画布是 w×h 并给出它的 ctx；拿不到就 null
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

  // 把任意画布/图片整张拷进离屏画布，返回可量边的尺寸与 ctx
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

  // 读一次内容框并推进迟滞状态；返回是否要求重排浮窗。
  // st.measured 告诉调用方「这一拍到底量到东西没有」：被节流挡掉和量出来但
  // 框没变，返回值都是 false，光看返回值分不开这两种情况。
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
      // 内容涨出去了：立刻放大（走并集），慢一步就会切掉真画面
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
    // 要收窄：连续 BG_SHRINK_STREAK 次量到同一个窄框才认，避免逐帧抖
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
      // 源换了（换段落、画布重建），旧包围盒不作数，重测
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
    // 裁边会改浮窗大小：呈现（wrap 尺寸、位置夹紧、面板读数）得跟着重算
    if (resized) applyPresentation();
    return true;
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
    resetBox(bgState);
  }

  /* ------------------------------------------------------------------ *
   * 模型模式的裁边：量框架那张画布，靠「缩小浮窗 + 负偏移 host」裁掉空白
   *
   * 框架 mount() 里对 host 做的是 Object.assign(style, {width, height,
   * overflow, mask*})，对里面的画布是同样的 width/height —— 它从不写 host
   * 的 left/top，所以我们把 host 往左上挪、把 wrap 收成内容大小再 overflow
   * hidden，就能裁掉透明边而不去碰框架的画布。每次 render 框架都会
   * clearBox(host)（removeAttribute('style')），所以这个偏移和 applyClip
   * 一样必须在 render 之后重新施加。
   * ------------------------------------------------------------------ */
  function petCanvasEl() {
    return host ? host.querySelector('canvas') : null;
  }

  // 位图像素 → CSS 像素的比例。框架把画布钉成 displaySize 见方，位图尺寸由
  // DoL 决定，两者不一定相等（设备像素比、模型边界都会影响）。
  // 分母优先用「量出这个框的那张画布」的尺寸：框的坐标只有在它自己的那份
  // 画布里才有意义，画布后来变了大小也不能拿新尺寸去除旧框。
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

  // 模型模式的内容裁框（CSS 像素）；量不出来就返回 null，呈现退回老的正方形
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
    // 每次 render 框架都换掉 host 里那张画布，认出「换了画布」才抢拍重测，
    // 免得同一张画布被逐帧 getImageData。旧框先留着顶第一帧（见 stopPetBoxWatch），
    // 量到新框再由 stepBox 覆盖。
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

  // 模型会呼吸、会换姿势，内容框是随时间变的，所以要盯着量。这里只是读像素，
  // 不调任何 render，不会把 DoL 的动画时钟清零（1.4.x 的相位差就是这么来的）。
  // 用自排程的 setTimeout 链而不是 setInterval：画布刚挂上、DoL 还没画第一帧
  // 时量边最容易落空，那几拍按 BG_BOX_FIRST_MS 密一点，量到就回 BG_BOX_MS。
  // 密排有次数上限，量不出（画布被污染之类）就退回常态，不白烧 CPU。
  var petBoxTimer = null;
  var petBoxCv = null;
  var petFastTries = 0;

  function schedulePetBoxWatch() {
    petBoxTimer = setTimeout(function () {
      petBoxTimer = null;
      if (!booted || isBg() || !state.enabled) return;
      refreshPetBox();
      startPetBoxWatch();
    }, petFastTries > 0 ? BG_BOX_FIRST_MS : BG_BOX_MS);
  }

  function startPetBoxWatch() {
    if (petBoxTimer || !booted) return;
    schedulePetBoxWatch();
  }

  // 注意：离开模型模式时不清 petState。框是上次量到的结果，切回来第一帧就能
  // 用它裁边；清了就得重新量，那期间呈现退回 256 见方，renderPos 又按方框宽度
  // 夹紧位置，于是「切回来先错位一下再回正」—— 这正是 v1.5.3 实测到的症状。
  function stopPetBoxWatch() {
    if (petBoxTimer) { clearTimeout(petBoxTimer); petBoxTimer = null; }
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
      stopPetBoxWatch();
      host.textContent = '';
      startBgLoop();
      drawOnce();
    } else {
      stopBgLoop();
      if (bgCtx) bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      // 模型关着就别占单实例：那时框架桌宠归玩家自己用，
      // 我们每段都重画反而会把它的画布抢走（两边按事件反复拉扯）。
      if (state.enabled) { renderCharacter(); startPetBoxWatch(); }
      else stopPetBoxWatch();
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
    forceRerender = true;     // 设置变了，必须重画
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
    // 和 adopt() 同一套收敛：这个接口是导出给控制台用的，区间与取值合法性
    // 不能只靠面板滑块的参数兜着，否则越界值会被原样持久化。
    state[key] = normalizeField(key, value);
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
    // 按下先补一次换算，否则拿老数字当画布原点减 anchor，起点就错了一个偏移
    rescalePos();
    var p = renderPos();
    // 以当前实际显示位置为基准，否则 pos 与显示位置不一致时首次移动会跳一下
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
    // 拖的是窗口，夹紧也按窗口来（画面不许拖出屏幕），存起来再换成画布原点
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

  // 视口变化只影响显示，不改写 pos：
  // 调试台等导致的临时缩小不应该毁掉玩家摆好的位置。
  function onResize() {
    if (!wrap) return;
    applyPresentation();
  }

  function resetPos() {
    // 重设 = 回到「没摆过」，renderPos 会按当前画面贴右下；再把那个位置
    // 换算成画布原点存下来，免得重设之后一切模式又跑偏。
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

  // 位置由 applyPresentation 传进来：那一步刚算过同一个数，这里再算一遍就
  // 白付一次 displayedDims + contentAnchor，而拖拽时这条路径每帧都走。
  function updatePosLabels(p) {
    // 面板上给人看的是「画面现在钉在屏幕哪儿」，也就是窗口左上角；
    // pos 存的是画布原点，直接显示它既看不懂也可能是负数。
    var list = document.querySelectorAll('.lpc-pos');
    for (var i = 0; i < list.length; i++) {
      list[i].textContent = 'X=' + Math.round(p.left) + ', Y=' + Math.round(p.top);
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
    ensureFollowPatch();      // v1.6.0 动画跟随：包 Renderer.animateLayers
    apply();
    // 进入游戏后自动对一次账：开局我们多半在游戏的 worn / 侧栏模型就位之前
    // 就画了一次，画的是初始着装。玩家不该再手动点开关或开合衣柜。
    scheduleGameSync();

    document.addEventListener('change', onPanelEvent);
    // 设置已改成同步落盘，只有位置还是防抖的，离开页面前补一次
    window.addEventListener('pagehide', function () {
      if (posTimer) savePos();
    });

    // v1.6.0：启动侧栏画布 MutationObserver，兜底 sidebar hook 没挂上的情况
    watchSidebarCanvas();

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
      // v1.6.0：先触发侧栏重建（含改脸预处理），等一帧让管线跑完再 apply。
      // 不直接 apply()：存档里的改脸设置可能还没被预处理到 main 模型里，
      // 直接捕 pet 会拿到默认脸。
      forceRerender = true;
      lastMainRef = null;
      lastContentSig = null;
      triggerSidebarRebuild();
      requestAnimationFrame(function () {
        apply();
      });
      // 读档等同于重新进游戏：穿着是存档里的那一套，同样要等游戏侧就位
      entryPassages = 0;
      syncRebuildCount = 0;
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
    // v1.6.0 动画跟随：补一次挂装机会（init 时 Renderer 可能还没就绪）
    ensureFollowPatch();
    // v1.6.0 防闪烁：段落过渡不再触发 triggerSidebarRebuild——侧栏重建由
    // :storyloaded 和 game sync 定时器（前 3 次）负责。这里只调 apply()，
    // renderCharacter() 里 lastMainRef 比对发现 main 没变就跳过 → 不闪。
    // 换装等真正的模型变更让 main 引用改变 → 放行重画。
    apply();
    if (entryPassages < 10 && !isBg()) {
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

  /* ------------------------------------------------------------------ *
   * 导出 GIF：把当前模式正在显示的画面固定 2 秒采样成动图
   *
   * 采的是哪张画布由模式决定：模型模式采 host 里的角色画布，背景模式采
   * bgCanvas —— 它就是侧栏画面的 2D 拷贝，所以背景模式导出的天然带背景图。
   *
   * 采样就是每 GIF_INTERVAL 毫秒读一次画布，2 秒内的每一帧都进图。回放延时按
   * 每帧实测间隔写（gifDelays），因为 setTimeout 的间隔会被主线程占用和标签页
   * 节流拉长；照 GIF_INTERVAL 写死就等于把 2 秒压成 1.6 秒之类，比真实时间快。
   * 16x16 灰度指纹只用来判断「这两秒里画布
   * 到底动没动」，动不了就在状态里提醒玩家（多半是游戏侧的侧边栏动画关着），
   * 不再拿它去找周期。
   *
   * 编码是本模组自带的极简 GIF89a 写器（中位切数量化 + LZW），不引外部库：
   * 模组要靠 ModLoader 单文件加载，挂一个 CDN 依赖等于把功能绑在网络上。
   * ------------------------------------------------------------------ */
  var GIF_INTERVAL = 80;              // 采样间隔 ms；实际间隔逐帧量出来写进延时
  var GIF_DURATION_MS = 2000;         // 固定采 2 秒，这段时间里的每一帧都进图
  var GIF_DELAY_MIN_CS = 2;           // 每帧显示时长的夹界（cs）：低于 2 很多解码器会当 10 处理
  var GIF_DELAY_MAX_CS = 100;         // 上限防被卡顿拉长的一帧把循环卡成一秒半
  var GIF_MAX_FRAMES = 40;            // 内存上限（一帧 320x320 RGBA 约 410KB）
  var GIF_MAX_SIDE = 320;             // 导出尺寸上限，超了等比缩
  var GIF_TRANSPARENT = 255;          // 调色板最后一位留给透明
  var GIF_ALPHA_CUT = 128;            // 低于这个 alpha 直接当透明（GIF 只有 1 位透明）
  var gifBusy = false;
  // 最近一次导出的对象 URL，gifClearActions/下一次导出负责释放
  var gifUrl = null;

  function gifStatus(msg) {
    try {
      var el = document.getElementById('lpc-gif-status');
      if (el) el.textContent = msg;
    } catch (e) {}
    console.log('[小小PC] ' + msg);
  }

  // 一帧的可比较指纹：16x16 灰度（乘 alpha，透明处算 0，免得背景变化干扰）
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

  // 每帧显示多久（cs）。第 i 帧就该显示到第 i+1 帧采到为止；末帧那一次是
  // 「够了」的那次，间隔还没走完就被判停，所以沿用上一个实测间隔，
  // 循环里的节奏才不断档。单帧（画布全程静止）用名义间隔。
  function gifDelays(stamps) {
    var out = [];
    for (var i = 0; i < stamps.length; i++) {
      var ms = i + 1 < stamps.length ? stamps[i + 1] - stamps[i]
        : (i > 0 ? stamps[i] - stamps[i - 1] : GIF_INTERVAL);
      out.push(clamp(Math.round(ms / 10), GIF_DELAY_MIN_CS, GIF_DELAY_MAX_CS));
    }
    return out;
  }

  // rect 是可选的取样矩形（画布坐标系）：模型模式要按量出来的内容框取，
  // 免得把画布上那圈透明边一起导出去。背景模式的 bgCanvas 已经裁好，不传。
  function gifSample(canvas, rect, done) {
    var sx = rect ? rect.x : 0;
    var sy = rect ? rect.y : 0;
    var sw = rect ? rect.w : canvas.width;
    var sh = rect ? rect.h : canvas.height;
    // 画布可能在我们两次量边之间被框架换成更小的一张（换段落、换装），
    // 取样框得夹回画布范围内，否则会裁到不存在的像素上
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
    var stamps = [];                  // 每帧采到的时刻，回放延时按实测间隔算
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
      if (!moved && gifDistance(first, fp) > 2) moved = true;   // 只为在状态里提醒「没动」
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

  /* 量化：把若干帧的像素收成不超过 255 个颜色，255 号留给透明 */

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
    var boxes = [];     // 还能再切的
    var leaves = [];    // 已经是一种颜色的，直接进调色板

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
      // 单色或只剩一种：它就是调色板里的一条，丢了就少一种颜色
      if (list.length < 2 || m.span === 0) { leaves.push(list); return; }
      boxes.push({ items: list, m: m });
    }

    push(items);
    // 254 而不是 255：255 号下标要留给透明，调色板最多只能有 254 种实色
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
      // 两半都必须非空，否则这一盒颜色就并进别人的平均值里了
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
      for (var i = 0; i < d.length; i += 16) {                  // 每 4 个像素取 1 个
        if (d[i + 3] < GIF_ALPHA_CUT) continue;
        var c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    var items = [];
    map.forEach(function (n, c) { items.push({ c: c, n: n }); });
    return items;
  }

  // 15 位粗色 -> 调色板下标，缓存住，避免每个像素重算最近邻
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

  /* GIF89a 写器 */

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
        // 加档要等到「刚建出来的那条码本身放不下」为止：建到 511 还能按 9 位发，
        // 建到 512 才升 10 位。提前一档升，.NET/浏览器这类标准解码器就会把
        // 升档后的第一条码按宽一位去读，从那里开始整帧错位。
        if (next - 1 === (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        put(CLEAR);                                            // 先按 12 位发 CLEAR，再降回 9 位
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
    u8(0xF7);            // 有全局调色板 / 色深 8 位 / 256 色
    u8(0);               // 背景色下标
    u8(0);               // 像素宽高比
    for (var i = 0; i < 256; i++) {
      var c = pal[i] || [0, 0, 0];
      u8(c[0]); u8(c[1]); u8(c[2]);
    }
    // 无限循环
    u8(0x21); u8(0xFF); u8(11);
    str('NETSCAPE2.0');
    u8(3); u8(1); u16(0); u8(0);

    var delays = spec.delays || [];   // 每帧实测的显示时长（cs），与 frames 等长
    for (var f = 0; f < frames.length; f++) {
      u8(0x21); u8(0xF9); u8(4);
      u8(0x09);                              // disposal=2（回背景）+ 用了透明下标
      u16(delays[f] || GIF_INTERVAL / 10);   // 延时，单位 cs
      u8(GIF_TRANSPARENT);
      u8(0);
      u8(0x2C);
      u16(0); u16(0); u16(w); u16(h);
      u8(0);                                 // 无局部调色板、不交错
      u8(8);                                 // LZW 最小码长
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
    // 只留一份活着的对象 URL：下一次导出时先释放上一次的。
    // 不按桌面习惯定时 revoke —— 移动端玩家就是靠那条常驻链接拿文件的，
    // 撤早了链接就死了。
    gifUrl = url;
    gifRenderActions(url, blob, name);
    gifAutoClick(url, name);
  }

  // 自动那一下点击只是「尽力一试」：桌面浏览器认，iOS Safari 多半不认。
  // 两个原因叠在一起 —— 采样跑满 2 秒，回调里已经离开用户手势窗口（合成点击
  // 被静默拦掉，不报错），而且它对 blob: 常常连 download 属性都不理。真兜底
  // 的是 gifRenderActions 出来的、玩家自己戳的那条链接。
  function gifAutoClick(url, name) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      // 不用 display:none：老 WebKit 对不在布局里的 anchor 会忽略合成点击，
      // 所以挪到屏幕外面而不是藏起来。
      a.target = '_blank';
      a.rel = 'noopener';
      // 万一浏览器选择「打开」而不是「下载」，也要开在新标签 —— 不能把游戏
      // 这一页顶掉，那等于丢掉没写盘的进度。
      a.style.position = 'fixed';
      a.style.left = '-2000px';
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
    } catch (e) {}
  }

  // iOS 上只有走系统分享面板选「存储到文件」才保得住动画（存进照片会被压成
  // 首帧静图），所以能分享就多给一个按钮。这是能力检测不是 UA 嗅探：桌面
  // Chrome/Edge 支持时同样会亮。
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
    // 面板还没渲染出来（或玩家已经切走）就没有落点，链接照样能靠自动点击试一把
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
          // 玩家在面板上按取消不算失败
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

  // 面板按钮入口。采样是异步的（要跑满 2 秒），编码是同步的（几十毫秒量级）。
  //
  // 采哪个画布跟着当前模式走：模型模式画的是 host 里的角色画布，背景模式画
  // 的是 bgCanvas —— 它本身就是侧栏 .mainCanvas（开局页是 #startImg）的一份
  // 2D 拷贝并按内容裁好了边，所以背景模式下导出的天然就是带背景图、又不带
  // 空白边的画面。两种模式互斥（apply() 里背景模式会把 host 清空），因此
  // 不存在「两边都有」要合成的情况。
  //
  // 模型模式那张画布归框架，我们只在显示层裁（wrap 收小 + host 负偏移），
  // 画布本身的位图还是带空白的，所以导出时按量出来的内容框取矩形。
  function gifSource() {
    if (isBg()) {
      // lastSrc 为 null 说明 rAF 循环还没抓到过一次源画布，此时 bgCanvas 是
      // 空的可直接判掉；宽度为 0 同理（ensureShell 之后没画过）。
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
    // 采样要跑满 2 秒，中途玩家可能切了模式；提示语和文件名按按下按钮那一刻
    // 的模式定，别让它们跟着异步回调里的 isBg() 变。
    var bg = isBg();

    gifBusy = true;
    // 上一次的链接/分享按钮先收掉：这次不管是出错还是「画面没动」提前 return，
    // 留着旧链接都会让人以为导出成了
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
        // 回放总时长 = 各帧实测延时之和，报出来玩家不用找工具就能核对
        // 「导出这段到底是不是 2 秒」
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
   * 一次性探测：控制台敲 FloatingSprite.debug()
   *
   * 只读快照，不改任何状态。storage/localSource 那两组是专门给「设置到底
   * 从哪儿读出来的」这个问题准备的：优先级是 localStorage > sessionStorage >
   * 旧版键 > 存档副本 > 默认值，localSource 直接说明这一次是哪一路赢了。
   * ------------------------------------------------------------------ */
  function debug() {
    var R = window.Renderer;
    var V = sugarV();
    var mb = window.maplebirch;
    var opt = frameworkPetOption();
    var CM = R && R.CanvasModels;
    var M = macroRegistry();
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
      // pos 存的是画布原点（v1.5.5 起的口径），rendered 才是浮窗在屏幕上的
      // 落点；anchor 是原点与窗口左上角之间那段（= 裁框的左上角）。
      // 三者关系：rendered = clamp(pos + anchor)。viewport 用来判断夹紧有没有生效。
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
      // 读到的是哪一路、以及那一路的原样内容（优先级写死在 localState 里）
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
        // 我们的 animated 只认这一个存档字段；它和侧边栏实际动不动不一致，
        // 动作就会看着有先后
        optionKey: 'V.options.sidebarAnimations',
        optionValue: V && V.options ? V.options.sidebarAnimations : undefined,
        ourAnimated: frameworkAnimated(),
        petMask: PET_MASK,
        petRotation: PET_ROTATION,
        follow: {
          patched: followPatched,
          wanted: followWanted(),
          events: followEvents,
          draws: followDraws,
          last: followLast,
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
        // 顶层handler是不是我们那一层；false 且 sidebarInstalled 为 true
        // 说明被框架或别的模组盖到了下面（我们的层仍在链里）
        sidebarTopIsOurs: !!(M && sidebarTopHandler(M) === sidebarWrapperFn),
        sidebarTries: sidebarTries,
        retry: { fast: retryCount, slow: slowRetryCount, pending: retryPending },
        gameSyncPending: gameSyncTimers.length
      },
      gif: {
        busy: gifBusy,
        mode: state.mode,
        // 延时口径：每帧按实测间隔写，夹在这个区间（cs），nominal 是采样节奏
        delayCs: { min: GIF_DELAY_MIN_CS, max: GIF_DELAY_MAX_CS, nominal: GIF_INTERVAL / 10 },
        // 导出会采哪个画布、那个画布现在有没有内容
        source: gifSource().canvas ? (isBg() ? 'bgCanvas' : 'hostCanvas') : null,
        bgCanvas: bgCanvas ? [bgCanvas.width, bgCanvas.height] : null,
        bgHasSource: !!lastSrc,
        // 玩家到底靠哪条路拿到文件：自动点击不作保证（iOS 会静默拦），
        // 常驻链接要有那条状态行的落点，分享要浏览器支持 Web Share Level 2。
        // 手机上判「为什么没下载成」一次就能定，不用来回试。
        paths: {
          linkRow: !!document.getElementById('lpc-gif-actions'),
          share: gifShareFile(new Blob(['GIF89a'], { type: 'image/gif' })) !== null,
          // 手上还攥着上一次导出的对象 URL（没被新导出释放）
          held: !!gifUrl
        },
        ua: navigator.userAgent
      },
      // 裁边：srcCanvas 是量边用的那张画布尺寸（背景模式=侧栏画布，模型模式
      // =框架画布），bgBox/petBox 是量出来的内容框（位图坐标），bgCanvas 是裁
      // 完的显示画布，displayed 是浮窗 CSS 尺寸，hostBoxOffset 是模型模式给
      // host 施加的负偏移。框为 null 表示还没量出来（刚切模式/画布还没画/
      // 读像素被拒），此时呈现退回老的正方形。
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
          // petBoxOnCanvas：现在这张画布上量到过没有。false 说明手里这份框是
          // 上一张画布（甚至上一次进局）的，正在靠抢拍重测校正。
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

  /* ------------------------------------------------------------------ *
   * 对外接口
   * 只暴露 settings.twee 真正用到的成员，加排查用的 debug 与导出用的 exportGif。
   * 注意跨文件的字面量耦合：
   *   clip 的取值 'full' | 'closeUp' | 'modelOnly'
   *   scale 的区间 0.5 ~ 1
   *   opacity 的区间 0.1 ~ 1
   *   「重设」按钮写回的 0.85 与 1 —— 就是下面 DEFAULTS 里那两个默认值
   * 都同时写在 settings.twee 的宏参数里，改动时必须同步。
   * ------------------------------------------------------------------ */
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
