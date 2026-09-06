// ==UserScript==
// @name         Bandcamp Wishlist Year Filter
// @name:zh-CN   Bandcamp 收藏夹年份过滤器
// @namespace    https://bandcamp.com/
// @version      1.3.5
// @description  Add a release-year filter next to the wishlist search box on Bandcamp wishlist pages
// @description:zh-CN  在 Bandcamp 收藏夹（wishlist）页面搜索框右侧添加「发行年份」过滤器
// @author       WorkBuddy
// @match        *://bandcamp.com/*
// @match        *://www.bandcamp.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @noframes
// ==/UserScript==

/*
 * 工作原理
 * --------
 * 1. Bandcamp 的 wishlist 页面把条目渲染成
 *      li.collection-item-container[data-tralbumid][data-tralbumtype][data-bandid]
 *    搜索框容器是 #wishlist-search（含 <input>），本脚本把过滤器插到它里面，即搜索框右侧。
 * 2. 条目本身不带发行日期，需要调用站内接口补齐：
 *      POST https://bandcamp.com/api/mobile/25/tralbum_details
 *      { band_id, tralbum_id, tralbum_type }
 *    返回体中的 release_date（Unix 秒）即为发行时间。
 * 3. 结果按「当前登录账号 + 条目 ID」永久缓存（优先写油猴的 GM_setValue，
 *    它存在扩展自己的数据库里，不会被浏览器清站点数据、不会随刷新丢失；
 *    GM 不可用时回退 localStorage）。除非退出登录，否则不重置。
 * 4. 用 MutationObserver 兼顾「See all / 滚动加载」动态追加的条目。
 * 4b. v1.3.0 起：解析任务与 DOM 解耦。先用批量接口（每页 100 条）把整个 wishlist
 *     的条目清单拉下来存住，再从清单出发逐条补年份 —— 这样即使页面只渲染了
 *     前 20 个 li，后台也能继续补完剩下的一千多条。每解析一条立刻落盘，
 *     刷新 / 关页面都能接着上次继续，分几次访问就能把整张表补全。
 *     状态栏显示「全库 N/1238」的真实总进度。
 * 4c. v1.3.1 起：自愈加固。
 *     - 清单区分 complete / 续拉游标 nextToken：不完整的清单只短期复用并持续补建，
 *       不会再被当作完整清单缓存 7 天（曾导致「全库进度卡在断点」永久冻结）。
 *     - 后台 worker 单条异常被 try/catch 兜住，绝不让整个 worker 退出。
 *     - 看门狗定时巡检，停滞超过 rosterIdleRestartMs 强制重启一轮。
 *     - 工具栏新增「重建清单」按钮：丢弃旧 roster（保留年份缓存）从零重拉，
 *       旧 worker 通过 generation 自增自行退出；DOM 占位条目立即开工。
 * 4d. v1.3.3 起：过滤也能作用于全库（按需加载）。
 *     解析早已全库化，但过滤只能作用于当前 DOM 渲染出来的 li；页面默认只有 20 个，
 *     于是选中一个页面里还没出现的年份时这 20 条全被隐藏，看起来就像「内容空了」。
 *     现在选中年份后会比对「缓存里该区间的条目数」与「页面已渲染的匹配数」，
 *     不足时自动触发页面的 view all / 滚动懒加载把条目加载出来；新 li 的年份
 *     直接从 store.data 回填（已解析过的不产生网络请求）。
 * 4e. v1.3.4 起：修复 v1.3.3 引入的「view all 加载不出结果 + 控制台报
 *     e.completeCallback is not a function」。
 *     根因：v1.3.3 的 applyFilter 用 display:none 把非选中 li 全部隐藏，
 *     Bandcamp 的 view all ajax 在完成回调里基于 jQuery :visible 扫描已渲染条目，
 *     发现「全部不可见」时走到 reject 分支但 completeCallback 未设 → 抛错。
 *     修法：autoLoad 期间用 rootEl 的 visibility:hidden 整体隐藏（li 的 display
 *     仍为 block，Bandcamp 的 :visible 仍能选到），同时 applyFilter 顶部加
 *     autoLoad.running 守卫短路所有路径的隐藏；加载完毕由 finally 一次性 applyFilter。
 * 4f. v1.3.5 起：view all 触发方式加固 + 报错自动降级。
 *     - clickViewAll 优先用 jQuery trigger（Bandcamp 的绑定多在 jQuery 上），
 *       其次 dispatchEvent 模拟完整鼠标序列（mousedown→mouseup→click），
 *       最后才 fallback 到原生 el.click()。
 *     - findViewAllEl 增加调试日志，输出找到的元素 tag/class/id/text 便于诊断。
 *     - 全局 error 监听捕获 completeCallback 报错后自动降级为「手动模式」：
 *       不再自动点 view all，状态栏提示用户手动点击，避免反复报错。
 * 5. 所有出站请求统一经过限流器（默认 2 次/秒 + 滑动窗口）；一旦收到 429 就整体冷却，
 *    按 8s→16s→…→120s 指数退避（优先采用响应头的 Retry-After），冷却期间状态栏倒计时提示，
 *    冷却结束后自动重试。被限流导致失败的条目不会写入缓存，避免被永久误判为「无年份」。
 *    若仍频繁 429，把 CFG.requestsPerSecond 调小（1 或 0.5）即可。
 */

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CFG = {
    target: 'wishlist',                  // 目标区域：wishlist（改成 collection 即可作用于已购收藏）
    itemSelector: 'li.collection-item-container',
    gridSelector: '.collection-grid',
    waitTimeout: 20000,                  // 等待 wishlist 容器出现的最大时长(ms)
    // —— 限速（429 相关，若仍被限流就把 requestsPerSecond 调到 1 或 0.5）——
    requestsPerSecond: 2,                // 稳态请求速率：每秒最多 N 个请求
    burst: 2,                            // 允许的瞬时突发（滑动窗口上限）
    concurrency: 2,                      // 并发请求数（真正的并发上限由限流器控制）
    cooldownBase: 8,                     // 触发 429 后的首次冷却秒数
    cooldownMax: 120,                    // 冷却上限（秒），指数退避的天花板
    maxRetries: 6,                       // 单个条目因 429 重试的最大次数
    pageSize: 100,                       // 拉取 band_id 索引时的分页大小
    // —— 存储（账号绑定 / 持久化）——
    storagePrefix: 'bcYearFilter.v2',    // 存储命名空间
    flushDelay: 300,                     // 合并写入的防抖延迟(ms)；页面卸载前会强制落盘
    clearOnLogout: true,                 // 检测到「已登录 → 未登录」时清除该账号的数据
    logoutConfirmTicks: 3,               // 连续几次重扫都判为未登录才执行清除（防误判）
    showYearBadge: true,                 // 在每个条目封面右下角显示年份角标
    keepUnknownVisible: true,            // 年份未知的条目是否始终显示
    viewportFirst: true,                 // 优先解析视口内/附近的条目
    rescanInterval: 3000,                // 兜底重扫间隔(ms)
    // —— 后台全量解析（与 DOM 解耦，跨页面续跑）——
    rosterEnabled: true,                 // 是否后台拉取全量清单并持续解析
    rosterPageSize: 100,                 // 建清单时的分页大小（接口可能只给 20 条/页）
    rosterMaxAge: 7 * 864e5,             // 「完整清单」的有效期(ms)，过期重建
    rosterPartialMaxAge: 30 * 1000,      // 「不完整清单」隔多久再续拉一次
    rosterMaxPages: 400,                 // 单次续拉的翻页上限
    rosterMaxAttempts: 4,                // 单条在一轮里最多重试几次（被限流时）
    rosterIdleRestartMs: 25000,          // 后台解析停滞多久后判定卡死并重启
    // —— 按需加载条目（让「过滤」也能作用于全库，而不只是当前渲染的 20 个 li）——
    autoLoadOnFilter: true,              // 选中年份后自动把未渲染的条目加载出来
    autoLoadMaxRounds: 40,               // 自动加载最多循环几轮
    autoLoadRoundDelay: 700,             // 每轮等待多久让 Bandcamp 渲染(ms)
    autoLoadStableRounds: 3              // 连续几轮条目数没增长就判定加载完毕
  };

  const TAG = '[BC-YearFilter]';
  const log = (...args) => console.log(TAG, ...args);

  /* ============================ 状态 ============================ */
  let rootEl = null;                     // #wishlist-items
  const items = new Map();               // DOM 节点 -> 条目记录
  const byKey = new Map();               // tralbum key -> 条目记录（供后台解析回填角标）
  const queue = [];
  let active = 0;
  let ui = null;                         // { wrap, from, to, reset, clear, status }
  const stats = { rateLimited: 0, retried: 0 };
  const counts = { total: 0, resolved: 0, unknown: 0, shown: 0, pending: 0 };

  /* ============================ 工具 ============================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(predicate, timeout = CFG.waitTimeout, interval = 150) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function check() {
        const v = predicate();
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(check, interval);
      })();
    });
  }

  /* ============================ 运行环境适配 ============================ */
  /*
   * 一旦声明了 @grant，脚本就跑在油猴沙箱里：window 是包装对象，页面自己的全局变量
   * （FanData 等）读不到。所以统一通过 unsafeWindow 访问页面上下文，并保留回退。
   */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow
    : (typeof globalThis !== 'undefined' ? globalThis : window);
  const doc = W.document || (typeof document !== 'undefined' ? document : null);
  const doFetch =
    typeof W.fetch === 'function' ? W.fetch.bind(W)
      : typeof fetch === 'function' ? fetch.bind(W)
        : null;
  const cssOf = (el) => (W.getComputedStyle ? W.getComputedStyle(el) : (typeof getComputedStyle==="function"?getComputedStyle(el):null));

  /* ============================ 持久存储（账号绑定） ============================ */
  /*
   * 优先用油猴的 GM_setValue：数据存在扩展自己的数据库里，
   * 不受浏览器「清除站点数据」影响，也不会像 localStorage 那样被站点或 ITP 清掉。
   * 同时镜像写一份 localStorage 作为回退（油猴 API 不可用或换脚本管理器时仍可用）。
   * 存储按「当前登录账号 fan_id」分区，切换账号互不干扰。
   */
  const gm = {
    has: typeof GM_getValue === 'function' && typeof GM_setValue === 'function',
    get(k, d) { try { return GM_getValue(k, d); } catch (e) { return d; } },
    set(k, v) { try { GM_setValue(k, v); return true; } catch (e) { return false; } },
    del(k) { try { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); } catch (e) { /* ignore */ } }
  };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  const store = {
    owner: 'anon',      // 当前账号 fan_id；未登录用 'anon'
    data: {},           // { tralbumKey: {year, ts} }
    timer: null,

    dataKey(owner) { return CFG.storagePrefix + '.data.' + owner; },
    ownerKey() { return CFG.storagePrefix + '.owner'; },

    readRaw(owner) {
      const k = this.dataKey(owner);
      if (gm.has) {
        const v = gm.get(k, null);
        if (v != null) return String(v);
      }
      return ls.get(k);
    },

    load(owner) {
      this.owner = owner;
      this.data = {};
      const raw = this.readRaw(owner);
      if (raw) {
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === 'object') this.data = o;
        } catch (e) { /* 数据损坏则从头开始 */ }
      }
      log('载入账号 [' + owner + '] 的年份数据：', Object.keys(this.data).length, '条');
    },

    write() {
      if (!this.owner) return;
      const raw = JSON.stringify(this.data);
      const k = this.dataKey(this.owner);
      if (gm.has) gm.set(k, raw);
      ls.set(k, raw);
      // 记住「最后一次是哪个账号」，供退出登录检测使用
      if (gm.has) gm.set(this.ownerKey(), this.owner);
      ls.set(this.ownerKey(), this.owner);
    },

    scheduleFlush() {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.write();
      }, CFG.flushDelay);
    },

    flush() {                    // 页面卸载前必须调用，否则最后一批会丢
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.write();
    },

    get(key) { return this.data[key]; },
    set(key, val) { this.data[key] = val; this.scheduleFlush(); },

    clear(owner) {
      const target = owner || this.owner;
      if (gm.has) gm.del(this.dataKey(target));
      ls.del(this.dataKey(target));
      if (target === this.owner) {
        this.data = {};
        this.write();
      }
    },

    readLastOwner() {
      if (gm.has) {
        const v = gm.get(this.ownerKey(), null);
        if (v) return String(v);
      }
      return ls.get(this.ownerKey());
    },

    // 全量待办清单（与年份数据分开存，避免互相覆盖）
    rosterKey(owner) { return CFG.storagePrefix + '.roster.' + owner; },
    readRoster(owner) {
      const k = this.rosterKey(owner || this.owner);
      const raw = gm.has ? gm.get(k, null) : null;
      const s = raw != null ? String(raw) : ls.get(k);
      if (!s) return null;
      try {
        const o = JSON.parse(s);
        return (o && Array.isArray(o.items)) ? o : null;
      } catch (e) { return null; }
    },
    writeRoster(owner, obj) {
      const k = this.rosterKey(owner || this.owner);
      const raw = JSON.stringify(obj);
      if (gm.has) gm.set(k, raw);
      ls.set(k, raw);
    },
    clearRoster(owner) {
      const target = owner || this.owner;
      if (gm.has) gm.del(this.rosterKey(target));
      ls.del(this.rosterKey(target));
    }
  };

  /* ======================= 全量待办清单（后台解析） ======================= */
  /*
   * 问题：wishlist 有上千条时，页面默认只渲染前 20 个 li。
   * 如果只在 DOM 里出现的条目才去解析，那么刷新后页面又只剩 20 个 li，永远追不上。
   * 解决办法：先用批量接口把整个 wishlist 的条目清单拉下来存住，之后解析任务从
   * 这个清单出发，跟 DOM 渲染与否无关。解析结果随时落盘，跨刷新续跑。
   *
   * 关键教训（v1.3.0 曾在这里翻车）：
   *   清单拉取很容易被 429 打断，一旦把「半截清单」当成完整清单缓存起来，
   *   之后每次刷新都直接复用它，进度就永久冻结在断点上（表现为「全库进度卡住不动」）。
   *   因此清单必须区分 complete / 续拉游标 nextToken：
   *     - complete 的清单才允许长期复用；
   *     - 不完整的清单只短期复用，并持续用 nextToken 往下补，直到拉全。
   */
  const roster = {
    items: [],          // [{ key, tralbumId, bandId, tralbumType }]
    total: 0,           // wishlist 总条目数（接口给的 item_count）
    builtAt: 0,
    complete: false,    // 清单是否已拉全
    nextToken: null,    // 续拉游标；null 表示要从头开始
    keyIndex: null,     // key -> entry，供 DOM 回填 band_id

    pending: [],        // 本轮还没解析完的条目
    workers: 0,
    generation: 0,      // 每次 start() 自增，旧 worker 据此自行退出
    running: false,
    built: false,
    buildPromise: null,
    extendPromise: null,
    saveTimer: null,
    lastProgressAt: 0,
    doneCount: 0,       // 清单里已经拿到年份的条数

    /* ---------- 持久化 ---------- */
    persist() {
      const owner = store.owner;
      if (!owner || owner === 'anon') return;
      store.writeRoster(owner, {
        items: this.items,
        total: this.total,
        builtAt: this.builtAt,
        complete: this.complete,
        nextToken: this.nextToken
      });
    },

    // 条目被补了 band_id 等字段时，延迟合并落盘，避免每条都写一次
    markDirty() {
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.persist();
      }, 3000);
    },

    index() {
      if (!this.keyIndex) this.keyIndex = new Map(this.items.map((e) => [e.key, e]));
      return this.keyIndex;
    },

    // DOM 里的 li 带 data-bandid，而接口返回的条目未必有；
    // 页面滚动过哪些条目，就把那些条目的 band_id 补进清单，让它能真正被解析。
    noteBandId(key, bandId) {
      if (!bandId || !this.built) return;
      const e = this.index().get(key);
      if (e && !e.bandId) {
        e.bandId = String(bandId);
        invalidateBandIdMap();
        this.markDirty();
      }
    },

    /* ---------- 载入 ---------- */
    load() {
      const owner = store.owner;
      if (!owner || owner === 'anon') return false;
      const saved = store.readRoster(owner);
      if (!saved || !Array.isArray(saved.items) || !saved.items.length) return false;
      this.items = saved.items;
      this.total = saved.total || saved.items.length;
      this.builtAt = saved.builtAt || 0;
      // 老版本存的清单没有 complete 字段，一律按「不完整」处理 → 自动续拉补齐
      this.complete = saved.complete === true;
      this.nextToken = saved.nextToken || null;
      this.keyIndex = null;
      this.built = true;
      return true;
    },

    // 保证清单在内存里就绪；并发调用只会真正载入一次
    ensure() {
      if (this.built) return Promise.resolve(this.items);
      if (!this.buildPromise) {
        this.buildPromise = Promise.resolve(this.load()).then(() => this.items);
      }
      return this.buildPromise;
    },

    // 丢弃本地缓存的清单（含磁盘上的），让旧 worker 自退出（generation 自增），
    // 之后 ensureComplete() 会从头拉。用于「重建清单」按钮或彻底重新开始。
    async reset() {
      this.generation++;          // 旧 worker 下轮 while 检查时自行退出
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      const owner = store.owner;
      if (owner && owner !== 'anon') store.clearRoster(owner);
      this.items = [];
      this.total = 0;
      this.builtAt = 0;
      this.complete = false;
      this.nextToken = null;
      this.keyIndex = null;
      this.pending = [];
      this.doneCount = 0;
      this.built = false;
      this.buildPromise = null;
      this.running = false;
      this.workers = 0;
      invalidateBandIdMap();
    },

    /* ---------- 续拉：从 nextToken 往下补 ---------- */
    async extend() {
      if (this.extendPromise) return this.extendPromise;
      this.extendPromise = (async () => {
        const owner = store.owner;
        if (!CFG.rosterEnabled || !owner || owner === 'anon') return 0;
        const fanId = getFanId();
        if (!fanId) return 0;

        const pd = getPageData();
        const listData = pd && pd[CFG.target + '_data'];
        if (listData && (listData.item_count || listData.count)) {
          this.total = listData.item_count || listData.count;
        }

        const startedFromScratch = !this.nextToken;
        let token = this.nextToken
          || (listData && listData.last_token)
          || Math.floor(Date.now() / 1000) + '::a::';

        const seen = new Set(this.items.map((e) => e.key));
        const entries = this.items.slice();
        let added = 0;
        let walked = 0;
        let sawData = false;

        for (let page = 0; page < CFG.rosterMaxPages; page++) {
          let data = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await apiRequest(
              'https://bandcamp.com/api/fancollection/1/' + CFG.target + '_items',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                  fan_id: Number(fanId),
                  older_than_token: token,
                  count: CFG.rosterPageSize
                })
              }
            );
            if (r.rateLimited) {
              // 冷却可能很长（上限 120s），这里只等一小段就跳出，剩下的交给下一轮
              await sleep(Math.min(45000, limiter.cooldownLeft * 1000 + 500));
              continue;
            }
            if (!r.ok) break;
            data = r.data;
            break;
          }
          if (!data || !Array.isArray(data.items) || !data.items.length) break;

          sawData = true;
          walked++;

          for (const it of data.items) {
            const tralbumId = it.item_id || it.tralbum_id;
            if (!tralbumId) continue;
            const type = normalizeType(it.tralbum_type || it.item_type);
            const key = type + tralbumId;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({
              key,
              tralbumId: String(tralbumId),
              bandId: it.band_id ? String(it.band_id) : null,
              tralbumType: type
            });
            added++;
          }

          if (this.total && entries.length >= this.total) {
            this.complete = true;
            this.nextToken = null;
            break;
          }
          if (!data.more_available) {
            this.complete = true;
            this.nextToken = null;
            break;
          }
          // 接口的 last_token 有 bug（恒为第 20 条的 token），必须取最后一条的
          const last = data.items[data.items.length - 1];
          const next = (last && last.token) || data.last_token;
          if (!next || next === token) {
            this.complete = true;
            this.nextToken = null;
            break;
          }
          token = next;
          this.nextToken = next;
        }

        // 从头走了一圈却一条新增都没有 → 说明清单其实已经齐了，标记为完整，
        // 否则每次刷新都会把整份清单重拉一遍，白白浪费配额。
        if (!this.complete && sawData && added === 0 && startedFromScratch && walked >= 2) {
          this.complete = true;
          this.nextToken = null;
        }

        if (added > 0) {
          this.items = entries;
          this.keyIndex = null;
          invalidateBandIdMap();
        }
        if (!this.total) this.total = this.items.length;
        if (this.items.length) this.built = true;
        this.builtAt = Date.now();
        this.persist();
        if (added) log('清单续拉：新增', added, '条，累计', this.items.length, '/', this.total,
          this.complete ? '（已拉全）' : '（未拉全，下次继续）');
        return added;
      })().finally(() => { this.extendPromise = null; });
      return this.extendPromise;
    },

    // 反复续拉直到拉全；拉不动（限流/出错）就停下，保留游标等下次会话
    async ensureComplete(maxRounds = 8) {
      await this.ensure();
      if (this.complete && this.items.length) return 0;
      let total = 0;
      for (let round = 0; round < maxRounds; round++) {
        if (this.complete) break;
        const n = await this.extend();
        total += n;
        if (n === 0) break;
      }
      return total;
    },

    // 清单里已有年份的条数
    refreshDoneCount() {
      let n = 0;
      for (const e of this.items) {
        const c = store.get(e.key);
        if (c && typeof c.year === 'number') n++;
      }
      this.doneCount = n;
      return n;
    },

    /* ---------- 后台持续解析 ---------- */
    start() {
      if (!CFG.rosterEnabled || !this.built) return 0;
      const gen = ++this.generation;   // 让上一轮残留的 worker 自行退出
      this.refreshDoneCount();
      this.pending = this.items.filter((e) => {
        const c = store.get(e.key);
        return !(c && typeof c.year === 'number');
      });
      if (!this.pending.length) {
        this.running = false;
        return 0;
      }

      this.running = true;
      this.lastProgressAt = Date.now();
      log('后台解析启动：待解析', this.pending.length, '条，已完成', this.doneCount, '条');

      const worker = async () => {
        this.workers++;
        try {
          while (gen === this.generation && this.pending.length) {
            const entry = this.pending.shift();
            if (!entry) break;
            let outcome = 'skip';
            try {
              outcome = await this.resolveOne(entry);
            } catch (e) {
              // 单条异常绝不能让整个 worker 死掉——v1.3.0 就是这么卡住的
              log('后台解析单条异常，已跳过：', entry.key, e);
            }
            if (outcome !== 'limited') this.lastProgressAt = Date.now();
            if (outcome === 'limited') {
              // 被限流：放回队尾等冷却，但限制单条重试次数，避免无限循环
              entry._fails = (entry._fails || 0) + 1;
              if (entry._fails < CFG.rosterMaxAttempts) this.pending.push(entry);
              await sleep(Math.min(20000, Math.max(1500, limiter.cooldownLeft * 1000)));
            }
          }
        } finally {
          this.workers--;
          if (this.workers === 0 && gen === this.generation) {
            this.running = false;
            this.refreshDoneCount();
            log('后台解析本轮结束，累计完成', this.doneCount, '/', this.items.length);
          }
        }
      };

      const n = Math.min(CFG.concurrency, this.pending.length);
      for (let i = 0; i < n; i++) worker().catch((e) => log('worker 异常退出', e));
      return this.pending.length;
    },

    // 卡死自愈：worker 全退了但还有活没干 / 长时间没有任何进展 → 重启一轮
    watchdog() {
      if (!CFG.rosterEnabled || !this.built) return;
      const remaining = this.items.length - this.doneCount;
      if (remaining <= 0) return;

      if (!this.running && this.workers === 0) {
        log('后台解析未在运行，但有', remaining, '条待解析 → 重启');
        this.start();
        return;
      }
      const idle = Date.now() - this.lastProgressAt;
      if (idle > CFG.rosterIdleRestartMs && !limiter.cooling) {
        log('后台解析停滞', Math.round(idle / 1000), 's 且无进展 → 重启');
        this.start();
      }
    },

    // 解析清单中的一条（与 DOM 无关），结果落盘；
    // 若该条目当前正好渲染在页面上，顺手把角标画上去。
    // 返回 'ok' | 'limited' | 'skip'
    async resolveOne(entry) {
      if (!entry.bandId) {
        const map = await getBandIdMap();
        const b = map.get(entry.key);
        if (b) entry.bandId = String(b);
      }
      if (!entry.bandId) return 'skip'; // 缺 band_id，等页面滚动到它时从 DOM 补

      // 被限流时等冷却结束后重试一次；仍不行就交回上层（放回队尾）
      const retryAfterLimit = async (fn) => {
        let r = await fn();
        if (!r.rateLimited) return r;
        await sleep(Math.min(20000, Math.max(1200, limiter.cooldownLeft * 1000)) + 300);
        return fn();
      };

      let r = await retryAfterLimit(
        () => tralbumDetails(entry.bandId, entry.tralbumId, entry.tralbumType)
      );
      if (r.rateLimited) return 'limited';

      let year = extractYear(r.data);
      if (year == null) {
        const alt = entry.tralbumType === 'a' ? 't' : 'a';
        r = await retryAfterLimit(() => tralbumDetails(entry.bandId, entry.tralbumId, alt));
        if (r.rateLimited) return 'limited';
        year = extractYear(r.data);
      }
      if (year == null) return 'skip'; // 拿不到就不写缓存，下次再试

      store.set(entry.key, { year, ts: Date.now() });
      this.doneCount++;

      // 页面上看得见的同款条目，立即补上角标
      const rec = byKey.get(entry.key);
      if (rec && rec.node && rec.node.isConnected) {
        rec.year = year;
        rec.resolved = true;
        rec.gaveUp = false;
        decorate(rec);
      }
      return 'ok';
    }
  };

  // 当前登录账号：优先页面全局 FanData，其次 #pagedata 的 blob
  function currentOwner() {
    let id = null;
    try {
      if (W.FanData && W.FanData.fan_id) id = W.FanData.fan_id;
    } catch (e) { /* ignore */ }
    if (!id) {
      const pd = getPageData();
      if (pd && pd.fan_data && pd.fan_data.fan_id) id = pd.fan_data.fan_id;
    }
    return id ? String(id) : null; // null = 未登录 / 暂时拿不到
  }

  /* ============================ 页面数据 ============================ */
  let _pagedata;
  function getPageData() {
    if (_pagedata !== undefined) return _pagedata;
    _pagedata = null;
    try {
      const el = doc.getElementById('pagedata');
      const raw = el && el.getAttribute('data-blob');
      if (raw) _pagedata = JSON.parse(raw);
    } catch (e) {
      log('pagedata 解析失败', e);
    }
    return _pagedata;
  }

  function getFanId() {
    try {
      if (W.FanData && W.FanData.fan_id) return W.FanData.fan_id;
    } catch (e) { /* ignore */ }
    const pd = getPageData();
    return (pd && pd.fan_data && pd.fan_data.fan_id) || null;
  }

  /* ============================ 限流器（防 429） ============================ */
  /*
   * 三层保护：
   *   1) 令牌间隔：相邻请求至少间隔 1000/requestsPerSecond 毫秒
   *   2) 滑动窗口：任意 1 秒窗口内不超过 burst 个请求
   *   3) 429 冷却：收到 429 后整体停摆，按指数退避（8s→16s→…→120s）逐步恢复，
   *      并优先采用响应头里的 Retry-After
   * 所有请求都必须经过 limiter.acquire()，因此 band_id 索引的批量拉取同样受限。
   */
  const limiter = {
    stamps: [],
    nextSlot: 0,
    cooldownUntil: 0,
    strikes: 0,          // 连续触发 429 的次数
    successes: 0,

    get minInterval() {
      return Math.max(120, Math.ceil(1000 / Math.max(0.1, CFG.requestsPerSecond)));
    },
    get cooling() {
      return Date.now() < this.cooldownUntil;
    },
    get cooldownLeft() {
      return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    },

    async acquire() {
      for (;;) {
        const now = Date.now();
        const gate = Math.max(this.cooldownUntil, this.nextSlot);
        if (now < gate) {
          await sleep(Math.min(gate - now, 1000));
          continue;
        }
        // 滑动窗口：清理 1 秒以外的记录
        while (this.stamps.length && now - this.stamps[0] >= 1000) this.stamps.shift();
        if (this.stamps.length >= Math.max(1, CFG.burst)) {
          await sleep(1000 - (now - this.stamps[0]) + 15);
          continue;
        }
        this.stamps.push(now);
        this.nextSlot = now + this.minInterval;
        return;
      }
    },

    penalize(retryAfterSec) {
      const now = Date.now();
      stats.rateLimited++;
      if (now < this.cooldownUntil) {
        // 已在冷却中：不叠加倍数，只取更长的那个
        if (retryAfterSec > 0) this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfterSec * 1000);
        return;
      }
      this.strikes++;
      const backoff = Math.min(CFG.cooldownMax, CFG.cooldownBase * Math.pow(2, this.strikes - 1));
      const wait = Math.max(retryAfterSec || 0, backoff);
      this.cooldownUntil = now + wait * 1000;
      log(`触发 429，冷却 ${wait}s（第 ${this.strikes} 次，退避 ${backoff}s）`);
    },

    reward() {
      this.successes++;
      if (this.successes >= 10) {
        this.successes = 0;
        if (this.strikes > 0) this.strikes--; // 稳定一段时间后放宽退避
      }
    }
  };

  /* ============================ 网络请求 ============================ */
  // 统一出口：自动限速、识别 429、读取 Retry-After，且永不抛异常
  async function apiRequest(url, opts = {}) {
    await limiter.acquire();
    try {
      const res = await doFetch(url, Object.assign({ credentials: 'same-origin' }, opts));
      if (res.status === 429) {
        let ra = 0;
        try {
          ra = Number(res.headers.get('Retry-After')) || 0;
        } catch (e) { /* 跨域限制下读不到头，忽略 */ }
        limiter.penalize(isFinite(ra) ? ra : 0);
        return { ok: false, rateLimited: true, status: 429, data: null };
      }
      if (!res.ok) return { ok: false, status: res.status, data: null };
      const data = await res.json();
      limiter.reward();
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: e };
    }
  }

  function postJSON(url, body) {
    return apiRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
  }

  // 发行详情：返回 release_date 等字段
  // 优先 POST /api/mobile/25/tralbum_details，失败再退回 GET /api/mobile/24/tralbum_details
  // 返回 { data, rateLimited }；data 为 null 表示确实拿不到
  async function tralbumDetails(bandId, tralbumId, tralbumType) {
    const payload = {
      band_id: Number(bandId),
      tralbum_id: Number(tralbumId),
      tralbum_type: tralbumType
    };

    const qs = new URLSearchParams({
      band_id: String(payload.band_id),
      tralbum_id: String(payload.tralbum_id),
      tralbum_type: tralbumType
    });
    const url24 = 'https://bandcamp.com/api/mobile/24/tralbum_details?' + qs;

    const attempts = [
      () => postJSON('https://bandcamp.com/api/mobile/25/tralbum_details', payload),
      () => apiRequest(url24, { headers: { Accept: 'application/json' } })
    ];

    for (const run of attempts) {
      const r = await run();
      if (r.rateLimited) return { data: null, rateLimited: true }; // 被限流：立即中止，交回上层重试
      if (!r.ok) continue;                                          // HTTP/网络错误：试备用版本
      if (r.data && !r.data.error) return { data: r.data, rateLimited: false };
      if (r.data) return { data: null, rateLimited: false };        // 接口明确报错：不再重试
    }
    return { data: null, rateLimited: false };
  }

  // 分批次拉取整个 wishlist，建立 `${type}${tralbum_id}` -> band_id 的索引（仅在 DOM 缺 data-bandid 时使用）
  let bandIdMapPromise = null;
  // 清单新增条目 / 回填了 band_id 后必须让索引失效，否则新数据永远进不来
  function invalidateBandIdMap() { bandIdMapPromise = null; }
  function getBandIdMap() {
    if (bandIdMapPromise) return bandIdMapPromise;
    bandIdMapPromise = (async () => {
      const map = new Map();

          // 清单已经建好就直接复用，避免为同一份数据重复打接口
      // （重复请求既浪费配额，又会增加触发 429 的概率）
      if (!roster.built) {
        // 清单还在建（或还没开始）：等它建完再复用，
        // 否则这里会先自己拉一遍，随后 roster 又拉一遍 —— 白白翻倍的请求量。
        try { await roster.ensure(); } catch (e) { /* 建清单失败则走下面的原路径 */ }
      }
      if (roster.built && roster.items.length) {
        for (const e of roster.items) if (e.bandId) map.set(e.key, e.bandId);
        return map;
      }

      const fanId = getFanId();
      if (!fanId) return map;

      const pd = getPageData();
      const listData = pd && pd[CFG.target + '_data'];
      let token = (listData && listData.last_token) || Math.floor(Date.now() / 1000) + '::a::';

      for (let page = 0; page < 100; page++) {
        // 同样走限流器；被 429 时等冷却结束后自动重试同一页
        let r = null;
        for (let attempt = 0; attempt < CFG.maxRetries; attempt++) {
          r = await postJSON('https://bandcamp.com/api/fancollection/1/' + CFG.target + '_items', {
            fan_id: Number(fanId),
            older_than_token: token,
            count: CFG.pageSize
          });
          if (!r.rateLimited) break;
        }
        if (!r || r.rateLimited || !r.ok) {
          if (r && r.rateLimited) map.incomplete = true;
          break;
        }

        const data = r.data;
        if (!data || !Array.isArray(data.items) || !data.items.length) break;

        for (const it of data.items) {
          if (it.tralbum_id == null) continue;
          const t = String(it.tralbum_type || 'a').trim().toLowerCase()[0];
          map.set((t === 't' ? 't' : 'a') + it.tralbum_id, it.band_id);
        }
        if (!data.more_available) break;
        // 注意：接口的 last_token 有 bug（始终返回第 20 条的 token），必须取最后一条的 token
        const last = data.items[data.items.length - 1];
        const next = (last && last.token) || data.last_token;
        if (!next || next === token) break;
        token = next;
      }
      log('band_id 索引构建完成，共', map.size, '条');
      return map;
    })().catch((e) => {
      log('band_id 索引构建失败', e);
      return new Map();
    });
    return bandIdMapPromise;
  }

  /* ============================ 年份解析 ============================ */
  function extractYear(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
      data.release_date,
      data.album_release_date,
      data.publish_date,
      data.current && data.current.release_date,
      data.current && data.current.album_release_date
    ];
    for (const c of candidates) {
      if (c === undefined || c === null || c === '') continue;
      if (typeof c === 'number' || /^\d{5,}$/.test(String(c).trim())) {
        const n = Number(c);
        if (!isFinite(n) || n <= 0) continue;
        const ms = n > 1e11 ? n : n * 1000; // 兼容毫秒时间戳
        const y = new Date(ms).getFullYear();
        if (y >= 1900 && y <= 2200) return y;
        continue;
      }
      // 形如 "17 May 2019 00:00:00 GMT" / "2019-05-17"
      const m = String(c).match(/(?:19|20)\d{2}/);
      if (m) return Number(m[0]);
    }
    return null;
  }

  // 返回 { done: true, year } 或 { retry: true }（被限流，交回调度器稍后重试）
  async function resolveYear(rec) {
    let bandId = rec.bandId;
    if (!bandId) {
      const map = await getBandIdMap();
      bandId = map.get(rec.key);
      if (bandId) {
        rec.bandId = bandId;
      } else if (map.incomplete) {
        return { retry: true }; // 索引因限流没拉全，别急着判“无年份”
      }
    }
    if (!bandId) return { done: true, year: null };

    let r = await tralbumDetails(bandId, rec.tralbumId, rec.tralbumType);
    if (r.rateLimited) return { retry: true };

    let year = extractYear(r.data);
    if (year == null) {
      // 专辑/单曲类型猜错时再试一次
      const alt = rec.tralbumType === 'a' ? 't' : 'a';
      r = await tralbumDetails(bandId, rec.tralbumId, alt);
      if (r.rateLimited) return { retry: true };
      year = extractYear(r.data);
    }
    return { done: true, year };
  }

  /* ============================ 条目注册与调度 ============================ */
  function normalizeType(raw) {
    if (!raw) return 'a';
    const c = String(raw).trim().toLowerCase()[0];
    return c === 't' ? 't' : 'a';
  }

  function registerNode(node) {
    if (!node || items.has(node)) return null;
    const ds = node.dataset || {};
    const tralbumId = ds.tralbumid || node.getAttribute('data-tralbumid');
    if (!tralbumId) return null;
    const type = normalizeType(ds.tralbumtype || ds.itemtype || node.getAttribute('data-tralbumtype'));
    const bandId = ds.bandid || node.getAttribute('data-bandid') || null;

    const rec = {
      node,
      tralbumId: String(tralbumId),
      tralbumType: type,
      bandId: bandId ? String(bandId) : null,
      key: type + tralbumId,
      year: null,
      resolved: false,
      queued: false
    };
    items.set(node, rec);
    byKey.set(rec.key, rec);

    // DOM 上的 data-bandid 是 band_id 最可靠的来源，回填进清单，
    // 让那些接口没返回 band_id、一直解析不了的条目有机会补上。
    roster.noteBandId(rec.key, rec.bandId);

    const cached = store.get(rec.key);
    if (cached && typeof cached.year === 'number') {
      rec.year = cached.year;
      rec.resolved = true;
      decorate(rec);
    } else if (cached && cached.year === null && cached.ts && Date.now() - cached.ts < 7 * 864e5) {
      rec.resolved = true; // 7 天内确认过的「无年份」不再重复请求
      decorate(rec);
    } else {
      enqueue(rec);
    }
    return rec;
  }

  function enqueue(rec) {
    if (rec.queued) return;
    rec.queued = true;
    queue.push(rec);
    pump();
  }

  // 优先挑离视口最近的条目，滚动时「看到的先出年份」
  function pickFromQueue() {
    if (!CFG.viewportFirst || queue.length < 3) return queue.shift();
    const vh = (W.innerHeight || 800);
    let best = 0;
    let bestScore = Infinity;
    const limit = Math.min(queue.length, 40);
    for (let i = 0; i < limit; i++) {
      const r = queue[i].node.getBoundingClientRect();
      const score = r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : 0;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
      if (score === 0) break;
    }
    return queue.splice(best, 1)[0];
  }

  function pump() {
    while (active < CFG.concurrency && queue.length) {
      const rec = pickFromQueue();
      if (!rec) continue;
      if (rec.node && !rec.node.isConnected) continue; // 已被移除的条目直接丢弃
      active++;
      process(rec).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function process(rec) {
    if (rec.resolved || !rec.node.isConnected) return;

    let result;
    try {
      result = await resolveYear(rec);
    } catch (e) {
      log('解析年份失败', rec.key, e);
      result = { done: true, year: null };
    }

    if (result.retry) {
      rec.attempts = (rec.attempts || 0) + 1;
      stats.retried++;
      if (rec.attempts > CFG.maxRetries) {
        // 重试用尽：判为未知以便继续筛选，但不写缓存，下次访问会重新尝试
        log('重试次数用尽，暂时放弃：', rec.key);
        rec.resolved = true;
        rec.gaveUp = true;
        rec.year = null;
        decorate(rec); // 仍然打上「年份未知」角标，避免看起来像没处理
        refreshYearOptions();
        applyFilter();
        return;
      }
      rec.queued = false;
      enqueue(rec); // 重新入队；限流器会在冷却结束后自动放行
      renderStatus();
      return;
    }

    rec.resolved = true;
    rec.year = result.year;
    store.set(rec.key, { year: result.year, ts: Date.now() });
    decorate(rec);
    refreshYearOptions();
    applyFilter();
  }

  /* ============================ 视觉装饰 ============================ */
  function decorate(rec) {
    if (!CFG.showYearBadge) return;
    if (!rec.node.isConnected) return;
    rec.node.dataset.bcYear = rec.year == null ? '' : String(rec.year);

    const host =
      rec.node.querySelector('div.collection-item-gallery-container') ||
      rec.node.querySelector('div.collection-item-art-container') ||
      rec.node.firstElementChild ||
      rec.node;

    let badge = host.querySelector(':scope > .bc-year-badge');
    if (!badge) {
      const cs = cssOf(host);
      if (cs && cs.position === 'static') host.style.position = 'relative';
      badge = doc.createElement('div');
      badge.className = 'bc-year-badge';
      host.appendChild(badge);
    }
    badge.textContent = rec.year == null ? '年份未知' : String(rec.year);
    badge.style.opacity = rec.year == null ? '0.55' : '1';
  }

  /* ============================ 过滤 ============================ */
  function getRange() {
    if (!ui) return [null, null];
    const from = parseInt(ui.from.value, 10);
    const to = parseInt(ui.to.value, 10);
    return [isNaN(from) ? null : from, isNaN(to) ? null : to];
  }

  function applyFilter() {
    // 自动加载期间不隐藏 li：Bandcamp 的 view all ajax 完成回调基于 jQuery :visible
    // 扫描已渲染条目，若我们用 display:none 把非选中 li 全部隐藏，
    // Bandcamp 会以为"已加载完"走到 reject 分支但 completeCallback 未设，
    // 抛 "e.completeCallback is not a function"。加载完毕后由 autoExpandForFilter
    // 的 finally 一次性 applyFilter。
    if (autoLoad && autoLoad.running) return;
    if (!items.size) return;
    const [from, to] = getRange();
    let shown = 0;
    let unknown = 0;
    let resolved = 0;

    for (const rec of items.values()) {
      if (!rec.node.isConnected) continue;
      if (rec.resolved) resolved++;

      let visible = true;
      if (rec.year == null) {
        unknown++;
        visible = CFG.keepUnknownVisible;
      } else if ((from != null && rec.year < from) || (to != null && rec.year > to)) {
        visible = false;
      }
      rec.node.classList.toggle('bc-yf-hidden', !visible);
      if (visible) shown++;
    }

    counts.total = items.size;
    counts.resolved = resolved;
    counts.unknown = unknown;
    counts.shown = shown;
    counts.pending = queue.length;
    renderStatus();
  }

  /* ==================== 按需加载（让过滤作用于全库） ==================== */
  /*
   * 问题：解析已经全库化（store.data 里有 1238 条的年份），但过滤只能作用于
   * 当前 DOM 里渲染出来的 li。页面默认只渲染 20 个，于是选中一个页面里
   * 还没出现的年份时，这 20 条全被隐藏 —— 看起来就是「内容空了」。
   *
   * 解决：选中年份后，如果缓存里该区间的条目数 > 页面已渲染的匹配数，
   * 就自动触发 Bandcamp 的「view all」/ 滚动懒加载把条目加载出来。
   * 新出现的 li 会被 MutationObserver + scan() 捕获，年份直接从 store.data
   * 回填（已解析过的条目不产生任何网络请求）。
   */
  const autoLoad = {
    running: false,
    cancelled: false,
    want: 0,      // 缓存里该区间应有的条目数
    loaded: 0,    // 当前 DOM 中已渲染且匹配区间的条目数
    rounds: 0,
    stalled: 0,
    degraded: false  // 检测到 Bandcamp completeCallback 报错后降级为纯监听模式
  };

  // 全局错误监听：捕获 Bandcamp view all ajax 的 completeCallback 报错，
  // 自动降级为纯监听模式（不再自动点 view all，只提示用户手动点击），避免反复报错。
  if (W.addEventListener) {
    W.addEventListener('error', (ev) => {
      const msg = (ev && ev.message) || '';
      if (msg.indexOf('completeCallback') !== -1 && !autoLoad.degraded) {
        autoLoad.degraded = true;
        log('检测到 Bandcamp view all ajax 报错（completeCallback），' +
            '已降级为手动模式：请直接点击页面上的「view all」加载剩余条目');
        renderStatus();
      }
    }, true);
  }

  // 全库（年份缓存）中落在 [from, to] 区间的条目数
  function countInCache(from, to) {
    let n = 0;
    for (const v of Object.values(store.data)) {
      const y = v && v.year;
      if (typeof y !== 'number') continue;
      if ((from == null || y >= from) && (to == null || y <= to)) n++;
    }
    return n;
  }

  // 当前 DOM 中已渲染且落在 [from, to] 区间的条目数
  function countInDom(from, to) {
    let n = 0;
    for (const rec of items.values()) {
      if (!rec.node.isConnected) continue;
      if (rec.year == null) continue;
      if ((from == null || rec.year >= from) && (to == null || rec.year <= to)) n++;
    }
    return n;
  }

  // 模糊查找页面上的「view all」元素（Bandcamp 各版本写法不一，用文本匹配兜底）
  function findViewAllEl() {
    if (!doc || !doc.getElementById || !doc.querySelectorAll) return null;
    const scope =
      doc.getElementById(CFG.target + '-grid') ||
      doc.getElementById(CFG.target + '-items-container') ||
      rootEl || doc.body;
    if (!scope || !scope.querySelectorAll) return null;
    let best = null;
    let bestLen = Infinity;
    const cands = scope.querySelectorAll('a, button, span, div, li, p');
    for (const el of cands) {
      if (el.closest && el.closest('.bc-year-filter')) continue;  // 排除自己的控件
      const t = (el.textContent || '').trim();
      if (!t || t.length > 60) continue;
      if (!/view\s*all/i.test(t)) continue;
      if (el.querySelector(CFG.itemSelector)) continue;           // 排除装着条目的大容器
      if (t.length < bestLen) { best = el; bestLen = t.length; }  // 取文本最短的（最内层）
    }
    if (best) {
      log('找到 view all 元素：', best.tagName,
          'class="' + (best.className || '') + '"',
          'id="' + (best.id || '') + '"',
          'text="' + (best.textContent || '').trim().slice(0, 40) + '"');
    } else {
      log('未找到 view all 元素（scope=' + (scope.id || scope.tagName) + '）');
    }
    return best;
  }

  function clickViewAll() {
    const el = findViewAllEl();
    if (!el) return false;
    try {
      // 优先用 jQuery trigger（Bandcamp 的 view-all 绑定多在 jQuery 上，
      // 原生 el.click() 的合成事件可能缺少 handler 期望的属性导致 completeCallback 丢失）
      if (W.jQuery && W.jQuery.fn && W.jQuery.fn.trigger) {
        W.jQuery(el).trigger('click');
      } else if (typeof W.MouseEvent === 'function') {
        // fallback：dispatchEvent 模拟完整的鼠标事件序列，比 el.click() 更接近真实点击
        const opts = { bubbles: true, cancelable: true, view: W };
        el.dispatchEvent(new W.MouseEvent('mousedown', opts));
        el.dispatchEvent(new W.MouseEvent('mouseup', opts));
        el.dispatchEvent(new W.MouseEvent('click', opts));
      } else {
        el.click();
      }
      log('已触发页面「view all」以加载全部条目');
      return true;
    } catch (e) {
      log('触发 view all 失败：', e && e.message);
      return false;
    }
  }

  function scrollToBottom() {
    try {
      if (doc.body) W.scrollTo(0, doc.body.scrollHeight);
    } catch (e) { /* ignore */ }
  }

  // 选中年份后，把尚未渲染的条目加载出来（幂等：重复调用不会叠加）
  async function autoExpandForFilter() {
    if (!CFG.autoLoadOnFilter || autoLoad.running) return;
    const [from, to] = getRange();
    if (from == null && to == null) return;      // 没选年份，不需要加载

    const want = countInCache(from, to);
    if (!want) return;                            // 全库该区间本来就没有条目
    let have = countInDom(from, to);
    if (have >= want) return;                     // 页面已经加载够了

    autoLoad.running = true;
    autoLoad.cancelled = false;
    autoLoad.want = want;
    autoLoad.loaded = have;
    autoLoad.rounds = 0;
    autoLoad.stalled = 0;

    // 关键修复：先把过滤隐藏的 li 全部恢复显示，再用 rootEl 整体 visibility:hidden
    // 让用户看不到"一闪而过"，但 li 的 display 仍是 block，Bandcamp 的 :visible
    // 选择器能正常扫描到条目。
    const restoreLoading = rootEl && !rootEl.classList.contains('bc-yf-loading');
    if (restoreLoading) rootEl.classList.add('bc-yf-loading');
    const hiddenLis = rootEl
      ? Array.from(rootEl.querySelectorAll(CFG.itemSelector + '.bc-yf-hidden'))
      : [];
    if (hiddenLis.length) hiddenLis.forEach(li => li.classList.remove('bc-yf-hidden'));

    // degraded 模式：检测到 completeCallback 报错后不再自动点 view all，
    // 只监听 DOM 变化（用户手动点 view all 后新 li 会被 MutationObserver 捕获）
    const canAutoClick = !autoLoad.degraded;
    if (canAutoClick) {
      log('所选年份在页面尚未全部渲染，自动加载条目：', have, '/', want);
    } else {
      log('所选年份在页面尚未全部渲染（手动模式），请点击 Bandcamp 的「view all」：', have, '/', want);
    }

    try {
      if (canAutoClick && clickViewAll()) {
        await sleep(CFG.autoLoadRoundDelay);
        if (rootEl) scan(rootEl);
        // 注意：这里不调 applyFilter()——autoLoad.running 期间 applyFilter 已被短路，
        // 等加载完由 finally 一次性应用过滤。
      }

      let lastCount = items.size;
      for (let i = 0; i < CFG.autoLoadMaxRounds; i++) {
        if (autoLoad.cancelled) break;
        autoLoad.rounds++;

        scrollToBottom();                         // 触发懒加载
        await sleep(CFG.autoLoadRoundDelay);
        if (rootEl) scan(rootEl);
        autoLoad.loaded = countInDom(from, to);
        renderStatus();

        if (autoLoad.loaded >= want) break;        // 已经够显示

        if (items.size === lastCount) {
          autoLoad.stalled++;
          // 停滞时再点一次（仅未降级时；degraded 模式下靠用户手动点）
          if (canAutoClick && autoLoad.stalled === 1) clickViewAll();
          if (autoLoad.stalled >= CFG.autoLoadStableRounds) break;
        } else {
          autoLoad.stalled = 0;
          lastCount = items.size;
        }
      }
      log('自动加载结束：页面匹配', countInDom(from, to), '/ 全库', want);
    } catch (e) {
      log('自动加载条目出错：', e && e.message);
    } finally {
      // 加载结束：先移除整体隐藏，再一次 applyFilter 把非选中 li 隐藏回去
      if (restoreLoading && rootEl) rootEl.classList.remove('bc-yf-loading');
      autoLoad.running = false;                    // 必须先复位，否则 applyFilter 仍被短路
      applyFilter();
      renderStatus();
    }
  }

  function renderStatus() {
    if (!ui) return;
    const parts = [];

    // 全库进度（清单维度）：这才是用户关心的「整个 wishlist 解析了多少」
    // 清单没拉全时要把「清单进度」也标出来，否则容易误以为解析卡死
    if (roster.built && roster.total) {
      if (roster.complete) {
        parts.push(`全库 ${roster.doneCount}/${roster.total}`);
      } else {
        parts.push(`全库 ${roster.doneCount}/${roster.total} · 清单 ${roster.items.length}（补建中）`);
      }
    } else if (roster.built && !roster.total && roster.items.length) {
      // 清单已被强制重置（重建清单但还没拉到 total），提示用户正在补建
      parts.push(`全库 ${roster.doneCount}/${roster.items.length}（清单补建中，点「重建清单」可重置）`);
    } else if (!roster.built && Object.keys(store.data).length) {
      // 有缓存但清单没载入（例如被外部清掉 roster），提示用户可点「重建清单」
      parts.push(`清单暂未加载（已缓存 ${Object.keys(store.data).length} 条年份）`);
    }
    parts.push(`已解析 ${counts.resolved}/${counts.total}`, `显示 ${counts.shown}`);
    if (counts.unknown) parts.push(`未知 ${counts.unknown}`);
    if (counts.pending) parts.push(`待解析 ${counts.pending}`);

    if (limiter.cooling) {
      parts.push(`限速冷却 ${limiter.cooldownLeft}s`);
      ui.status.style.color = '#e0a33a';
      ui.status.style.opacity = '1';
      ui.status.title = `Bandcamp 返回 429（请求过于频繁），暂停 ${limiter.cooldownLeft}s 后自动继续`;
    } else {
      ui.status.style.color = '';
      ui.status.style.opacity = '0.65';
      ui.status.title = '';
    }

    // 后台还在补解析时给个明确提示，避免看起来像卡住
    if (roster.running && roster.pending.length) {
      parts.push(`后台补解析中（剩 ${roster.pending.length}）`);
      ui.status.title = '后台正在补全尚未解析的条目，结果随时落盘，可随时刷新或关闭页面，下次自动继续';
    }

    // 按需加载：选中年份后正在把未渲染的条目加载出来
    if (autoLoad.running) {
      const totalHint = roster.total || items.size;
      if (autoLoad.degraded) {
        parts.push(`请点击「view all」加载条目（目标年份 ${autoLoad.loaded}/${autoLoad.want}）`);
        ui.status.title = '自动点击 view all 触发 Bandcamp 报错，已改为手动模式：请直接点击页面上的「view all」按钮';
      } else {
        parts.push(`加载条目 ${items.size}/${totalHint}（目标年份 ${autoLoad.loaded}/${autoLoad.want}）`);
        ui.status.title = '正在让 Bandcamp 加载更多条目，以便显示所选年份的专辑';
      }
      ui.status.style.opacity = '1';
    } else if (autoLoad.want && autoLoad.loaded < autoLoad.want) {
      // 加载结束仍不够：告诉用户剩下的要手动点 view all（Bandcamp 自身限制）
      parts.push(`该年份 ${autoLoad.loaded}/${autoLoad.want} 张已在页面，其余请点「view all」`);
      ui.status.title = '页面没有渲染出全部条目，点 Bandcamp 的「view all」后会自动补上';
    }
    ui.status.textContent = parts.join(' · ');
  }

  function fillSelect(sel, years, placeholder) {
    const prev = sel.value;
    sel.innerHTML = '';
    const opt = doc.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    sel.appendChild(opt);
    for (const y of years) {
      const o = doc.createElement('option');
      o.value = String(y);
      o.textContent = String(y);
      sel.appendChild(o);
    }
    if (prev && years.includes(Number(prev))) sel.value = prev;
    else if (!prev) sel.value = '';
  }

  function refreshYearOptions() {
    if (!ui) return;
    // 从 store.data（账号绑定全库年份 KV）收集，而不是当前 DOM 里的 20 个 li。
    // 否则「不点 view all」时下拉菜单就只看得到前 20 张专辑的年份，
    // 跟后台全库解析进度脱钩。
    const years = Array.from(
      new Set(
        Object.values(store.data)
          .map((v) => v && v.year)
          .filter((y) => typeof y === 'number')
      )
    ).sort((a, b) => a - b);
    if (!years.length) return;
    const sig = years.join(',');
    if (ui._sig === sig) return;
    ui._sig = sig;
    fillSelect(ui.from, years, '全部');
    fillSelect(ui.to, years, '全部');
    applyFilter();
  }

  /* ============================ 界面 ============================ */
  function injectStyles() {
    if (doc.getElementById('bc-year-filter-style')) return;
    const css = `
      .bc-year-filter{display:inline-flex;align-items:center;gap:6px;margin-left:12px;
        font-size:13px;line-height:1.2;font-family:inherit;color:inherit;vertical-align:middle;white-space:nowrap;}
      .bc-year-filter .bc-yf-label{opacity:.85;}
      .bc-year-filter .bc-yf-dash{opacity:.6;}
      .bc-year-filter select{font:inherit;font-size:12px;padding:3px 4px;border-radius:3px;
        border:1px solid rgba(128,128,128,.55);background:rgba(128,128,128,.14);color:inherit;cursor:pointer;}
      .bc-year-filter button{font:inherit;font-size:12px;padding:3px 8px;border-radius:3px;cursor:pointer;
        border:1px solid rgba(128,128,128,.55);background:rgba(128,128,128,.14);color:inherit;}
      .bc-year-filter button:hover{background:rgba(128,128,128,.28);}
      .bc-year-filter .bc-yf-status{margin-left:4px;font-size:12px;opacity:.65;font-variant-numeric:tabular-nums;}
      li.collection-item-container.bc-yf-hidden{display:none !important;}
      /* 自动加载期间整体隐藏（visibility 而非 display），让 Bandcamp 的 :visible 仍能选到 li */
      .bc-yf-loading{visibility:hidden !important;}
      .bc-year-badge{position:absolute;right:4px;bottom:4px;padding:1px 5px;border-radius:3px;
        font-size:11px;line-height:1.5;background:rgba(0,0,0,.68);color:#fff;
        pointer-events:none;z-index:3;letter-spacing:.02em;}
    `;
    const style = doc.createElement('style');
    style.id = 'bc-year-filter-style';
    style.textContent = css;
    doc.head.appendChild(style);
  }

  // 找到 wishlist 搜索框所在的容器，把控件插到它末尾 = 搜索框右侧
  function findAnchor() {
    const sels = [
      '#' + CFG.target + '-search',
      '#' + CFG.target + '-grid #' + CFG.target + '-search',
      '#' + CFG.target + '-grid .search',
      '#' + CFG.target + '-grid .collection-search',
      '.collection-container #' + CFG.target + '-search'
    ];
    for (const s of sels) {
      const el = doc.querySelector(s);
      if (el) return el;
    }

    // 兜底：定位到包含搜索输入框的最近容器
    const scope =
      doc.getElementById(CFG.target + '-grid') ||
      doc.getElementById(CFG.target + '-items-container') ||
      (rootEl && rootEl.parentElement) ||
      doc.body;
    const input = scope.querySelector(
      'input[type="search"], input.search, input[placeholder*="Search" i], input[placeholder*="搜索" i]'
    );
    if (input) return input.parentElement || input.closest('div') || scope;

    // 最后兜底：插到条目列表上方
    return doc.getElementById(CFG.target + '-items-container') || rootEl;
  }

  function buildUI() {
    if (ui && ui.wrap.isConnected) return;

    injectStyles();
    const anchor = findAnchor();
    if (!anchor) {
      log('未找到搜索框容器，跳过注入');
      return;
    }

    const wrap = doc.createElement('div');
    wrap.className = 'bc-year-filter';
    wrap.id = 'bc-year-filter-' + CFG.target;
    wrap.innerHTML =
      '<span class="bc-yf-label">发行年份</span>' +
      '<select class="bc-yf-from" title="起始年份（含）"></select>' +
      '<span class="bc-yf-dash">–</span>' +
      '<select class="bc-yf-to" title="结束年份（含）"></select>' +
      '<button type="button" class="bc-yf-reset">重置</button>' +
      '<button type="button" class="bc-yf-clear" title="清除当前账号已缓存的年份数据并重新解析">清除缓存</button>' +
      '<button type="button" class="bc-yf-rebuild" title="丢弃已缓存的条目清单，重新从 Bandcamp 拉取完整列表">重建清单</button>' +
      '<span class="bc-yf-status"></span>';

    anchor.appendChild(wrap);

    ui = {
      wrap,
      from: wrap.querySelector('.bc-yf-from'),
      to: wrap.querySelector('.bc-yf-to'),
      reset: wrap.querySelector('.bc-yf-reset'),
      clear: wrap.querySelector('.bc-yf-clear'),
      rebuild: wrap.querySelector('.bc-yf-rebuild'),
      status: wrap.querySelector('.bc-yf-status'),
      _sig: ''
    };

    // 选完年份先按现有条目过滤，再把尚未渲染的条目加载出来（否则页面只剩 20 条时
    // 选中一个页面里没有的年份会「全部隐藏」= 看起来内容空了）
    const onRangeChange = () => {
      applyFilter();
      autoExpandForFilter();
    };
    ui.from.addEventListener('change', onRangeChange);
    ui.to.addEventListener('change', onRangeChange);
    ui.reset.addEventListener('click', () => {
      ui.from.value = '';
      ui.to.value = '';
      autoLoad.cancelled = true;
      autoLoad.want = 0;
      autoLoad.loaded = 0;
      applyFilter();
    });
    ui.clear.addEventListener('click', () => {
      if (!W.confirm) { doClearCache(); return; }
      const ownerLabel = store.owner === 'anon' ? '未登录' : ('账号 ' + store.owner);
      if (W.confirm(`清除 ${ownerLabel} 已缓存的 ${Object.keys(store.data).length} 条年份数据？\n清除后需要重新联网解析。`)) {
        doClearCache();
      }
    });
    ui.rebuild.addEventListener('click', () => {
      const ownerLabel = store.owner === 'anon' ? '未登录' : ('账号 ' + store.owner);
      const msg =
        `丢弃 ${ownerLabel} 已缓存的 ${roster.items.length || 0} 条条目清单，重新从 Bandcamp 拉取。\n` +
        `同时清掉 ${Object.keys(store.data).length} 条年份数据。\n` +
        `后续会消耗较多网络流量（每页 100 条翻页），建议确认后再点。`;
      if (!W.confirm) { doRebuildRoster(); return; }
      if (W.confirm(msg)) doRebuildRoster();
    });
  }

  // 清空当前账号缓存，并让所有已渲染条目重新解析
  function doClearCache() {
    store.clear();
    store.flush();
    let n = 0;
    for (const rec of items.values()) {
      rec.year = null;
      rec.resolved = false;
      rec.queued = false;
      rec.gaveUp = false;
      rec.attempts = 0;
      if (rec.node && rec.node.isConnected) {
        enqueue(rec);
        n++;
      }
    }
    log('已清除缓存，重新解析', n, '条');
  }

  // 重建清单：丢弃 roster，重新从 Bandcamp 拉完整清单。
  // 注意：年份缓存（store.data）保留——已经解析过的条目不需要重解析。
  async function doRebuildRoster() {
    log('手动重建清单：丢弃旧清单', roster.items.length, '条；保留', Object.keys(store.data).length, '条年份缓存');
    await roster.reset();

    // 让现有 DOM 条目在重建后立刻可解析：把这些条目的 band_id 写回新清单
    // （reset 已清空 items，需要等 ensureComplete 拉到带 band_id 的页面再补；
    // 这里先把可见条目的 key 占位，等 extend() 拉到同一 key 时合并不重复即可）
    // —— 实际做法：让 enqueue 把 DOM 端条目也排进 roster.pending，roster.start() 会顺带处理
    for (const rec of items.values()) {
      rec.year = null;
      rec.resolved = false;
      rec.queued = false;
      rec.gaveUp = false;
      rec.attempts = 0;
      if (rec.node && rec.node.isConnected) {
        // 占位写一条到 roster，确保 roster.start() 启动后立刻有这一批 DOM 条目可解析
        const key = rec.key;
        if (!roster.items.some((e) => e.key === key)) {
          roster.items.push({
            key,
            tralbumId: rec.tralbumId,
            bandId: rec.bandId ? String(rec.bandId) : null,
            tralbumType: rec.tralbumType
          });
        }
        enqueue(rec);
      }
    }
    roster.total = Math.max(roster.total, roster.items.length);
    if (roster.items.length) {
      roster.built = true;
      roster.keyIndex = null;
    }
    roster.persist();
    renderStatus();
    // 立刻用现有清单开工（DOM 占位的会优先解析），同时异步续拉真正的清单
    roster.start();
    roster.ensureComplete().then((grew) => {
      roster.refreshDoneCount();
      if (grew) roster.start();
      renderStatus();
    });
  }

  /* ============================ 扫描与观察 ============================ */
  function scan(root) {
    let dirty = false;
    if (!root) root = rootEl;
    if (!root) return false;

    if (root.matches && root.matches(CFG.itemSelector) && registerNode(root)) dirty = true;
    root.querySelectorAll(CFG.itemSelector).forEach((n) => {
      if (registerNode(n)) dirty = true;
    });
    return dirty;
  }

  function observe() {
    const grid = (rootEl && rootEl.querySelector(CFG.gridSelector)) || rootEl;
    if (!grid) return;
    const mo = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches(CFG.itemSelector) && registerNode(n)) dirty = true;
          if (n.querySelectorAll) {
            n.querySelectorAll(CFG.itemSelector).forEach((x) => {
              if (registerNode(x)) dirty = true;
            });
          }
        });
      }
      if (dirty) {
        refreshYearOptions();
        applyFilter();
      }
    });
    mo.observe(grid, { childList: true, subtree: true });
  }

  /* ============================ 启动 ============================ */
  async function main() {
    rootEl = await waitFor(() => doc.getElementById(CFG.target + '-items'));
    if (!rootEl) {
      log('当前页面没有 wishlist 区域，脚本退出');
      return;
    }

    // —— 绑定当前账号后再载入数据 ——
    let owner = currentOwner();
    const lastOwner = store.readLastOwner();
    store.load(owner || 'anon');

    buildUI();
    scan(rootEl);
    observe();
    refreshYearOptions();
    applyFilter();

    // FanData 可能比脚本晚一点才有；补探测一次，拿到真实账号就切到对应分区
    setTimeout(async () => {
      const o2 = currentOwner();
      if (o2 && o2 !== owner) {
        owner = o2;
        store.load(o2);
        reapplyFromStore();
        log('账号已识别：', o2);
      }
      // 拿到账号后再处理清单，否则清单会落到 anon 分区
      await roster.ensure();       // 先复用本地清单（秒开，不发请求）
      roster.start();              // 立刻用现有清单开工
      renderStatus();

      // 清单不完整就后台续拉，拉到多少补多少，拉全了再启动一轮
      roster.ensureComplete().then((grew) => {
        if (grew) {
          roster.refreshDoneCount();
          roster.start();
        }
        renderStatus();
      });
    }, 2500);

    // 看门狗：worker 死掉 / 长时间无进展时自动重启，避免进度冻死
    setInterval(() => roster.watchdog(), 10000);

    // 清单不完整时定期重试续拉（限流打断了也能自己恢复）
    setInterval(() => {
      if (!roster.built || roster.complete) return;
      if (Date.now() - (roster.builtAt || 0) < CFG.rosterPartialMaxAge) return;
      if (limiter.cooling) return;
      roster.ensureComplete().then((grew) => {
        if (grew) {
          roster.refreshDoneCount();
          roster.start();
          renderStatus();
        }
      });
    }, CFG.rosterPartialMaxAge);

    // 页面卸载/隐藏前强制落盘，避免防抖窗口内的数据随刷新丢失
    const flushNow = () => store.flush();
    W.addEventListener('pagehide', flushNow);
    W.addEventListener('beforeunload', flushNow);
    W.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') flushNow();
    });

    // 后台解析期间定期刷新状态栏进度（每 1.5s 一次，且只在有变化时重绘）
    setInterval(() => {
      if (roster.built) renderStatus();
    }, 1500);

    // 退出登录检测：曾登录过，现在连续多次重扫都读不到账号 → 清除该账号数据
    let logoutTicks = 0;
    const watchLogout = () => {
      if (!CFG.clearOnLogout) return;
      const prev = store.readLastOwner();
      if (!prev || prev === 'anon') return;      // 从来没有登录态，不做清除
      if (currentOwner()) { logoutTicks = 0; return; }
      logoutTicks++;
      if (logoutTicks >= CFG.logoutConfirmTicks) {
        logoutTicks = 0;
        store.clear(prev);
        log('检测到退出登录，已清除账号 [' + prev + '] 的缓存');
        reapplyFromStore();
      }
    };

    // 兜底：定时重扫，补回被 Bandcamp 重新渲染掉的过滤器，并重试此前因限流放弃的条目
    setInterval(() => {
      if (ui && !ui.wrap.isConnected) ui = null;
      if (!ui) buildUI();

      if (scan(rootEl)) {
        refreshYearOptions();
        applyFilter();
      }

      // 队列已空且不在冷却中时，把之前因 429 放弃的条目重新排进队列
      if (queue.length === 0 && !limiter.cooling) {
        let revived = 0;
        for (const rec of items.values()) {
          if (rec.gaveUp && rec.node && rec.node.isConnected) {
            // 必须把 resolved / queued 一起复位，否则重新入队后会被 process 直接跳过
            rec.gaveUp = false;
            rec.resolved = false;
            rec.queued = false;
            rec.attempts = 0;
            enqueue(rec);
            if (++revived >= 20) break; // 一次只复活少量，避免又瞬间打满
          }
        }
        if (revived) log('重试此前因限流放弃的条目：', revived);
      }

      watchLogout();
    }, CFG.rescanInterval);

    // 冷却倒计时：让状态栏秒级刷新，不至于看起来像卡死
    setInterval(() => {
      if (limiter.cooling) renderStatus();
    }, 1000);

    log('已启动，账号：', store.owner, '，条目数：', items.size,
      '，限速：', CFG.requestsPerSecond, 'req/s',
      '，存储：', gm.has ? '油猴 GM_setValue（持久）' : 'localStorage（回退）');
  }

  // 账号切换 / 退出登录后，用新分区的数据重新装饰所有已渲染条目
  function reapplyFromStore() {
    for (const rec of items.values()) {
      const c = store.get(rec.key);
      if (c && typeof c.year === 'number') {
        rec.year = c.year;
        rec.resolved = true;
        rec.gaveUp = false;
        decorate(rec);
      } else if (!rec.resolved) {
        rec.queued = false;
        enqueue(rec);
      }
    }
    refreshYearOptions();
    applyFilter();
  }

  main();
})();
