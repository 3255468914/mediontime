/*!
 * app.js — 界面渲染与交互
 */
(function (global) {
  'use strict';

  var S = global.Scheduler;
  var Store = global.Store;
  var RE = global.ReminderEngine;
  var PF = global.Platform;

  var current = 'today';
  var editState = null;      // 药品编辑表单的临时状态
  var makeupReminder = null; // 当前正在补救的提醒

  function $(id) { return document.getElementById(id); }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hhmm(iso) {
    var d = new Date(iso);
    return S.pad2(d.getHours()) + ':' + S.pad2(d.getMinutes());
  }
  function dateCn(iso) {
    var d = new Date(iso);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function dayCn(d) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  var STATUS_TEXT = { on_time: '已按时', delayed: '延迟', missed: '漏服', skipped: '已跳过', makeup: '补服' };
  var STATUS_CLASS = { on_time: 'ok', delayed: 'warn', missed: 'bad', skipped: 'wait', makeup: 'ok' };

  function logFor(reminder) {
    return Store.state.logs.filter(function (l) {
      return l.planId === reminder.planId && l.scheduledAt === reminder.scheduledAt && !l.isMakeup;
    })[0] || null;
  }

  /* ============================================================
   * Toast
   * ============================================================ */
  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ============================================================
   * 弹层
   * ============================================================ */
  var lastFocus = null;   // 打开弹层前的焦点，关闭后要还回去
  var lastFocusPath = null;  // 用户最近一次聚焦的控件"位置"（由 focusin 持续记录）
  var fsRestorePath = null;  // 全屏强提醒关闭后要归还焦点的位置

  /* 焦点的"定位器"——为什么不直接存元素引用：
     本应用大量使用 innerHTML 重渲染。焦点所在的控件（尤其 appbar 里的图标按钮）
     会在一次 render() 之后变成游离节点，之后再对它 focus() 是空操作，
     焦点就掉回 document.body，用户的位置彻底丢失。
     所以存一条**能在重渲染后重新找到同一位置控件**的路径，而不是存节点本身。 */
  function focusLocator(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return null;
    if (el.id) return '#' + el.id;
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement) {
      if (n.id) { parts.unshift('#' + n.id); break; }   // 遇到带 id 的祖先就锚定，路径更稳
      var i = 1, sib = n;
      while ((sib = sib.previousElementSibling)) i++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + i + ')');
      n = n.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  function openSheet(html) {
    lastFocus = document.activeElement;
    var sh = $('sheet');
    sh.innerHTML = html;

    // 弹层是一个对话框：必须有可访问名称，且焦点要移进来。
    // 否则屏幕阅读器和键盘用户仍停在被遮住的页面上，完全不知道发生了什么。
    var title = sh.querySelector('h3');
    var ov = $('overlay');
    if (title) {
      title.id = 'sheetTitle';
      ov.setAttribute('aria-labelledby', 'sheetTitle');
      ov.removeAttribute('aria-label');
    } else {
      ov.removeAttribute('aria-labelledby');
      ov.setAttribute('aria-label', '对话框');
    }

    ov.classList.add('show');
    sh.setAttribute('tabindex', '-1');
    sh.focus();
  }

  function closeSheet() {
    $('overlay').classList.remove('show');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* 元素可能已被移除 */ } }
    lastFocus = null;
  }

  /* 键盘可达性：让 role="switch" 这类可点 div 也能用 Enter / 空格操作，
     并把 Esc 接成「关闭弹层」。这两个键在原生控件上是免费的，
     但我们的开关是 div，不补就会变成只有鼠标能用。 */
  function initA11y() {
    // 持续记录"用户最近聚焦在哪个控件上"。
    // 不能等要用的时候再读 document.activeElement：提醒引擎的 onLevel 回调会先
    // render()，把聚焦中的控件换掉，那一刻 activeElement 已经变回 body，
    // 想"归还焦点"时信息已经不存在了（这正是此前 L3 关闭后焦点掉回页面顶部的根因）。
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || t === document.body) return;
      // 对话框自己的焦点不算"用户位置"，其余都记
      if (t.closest && (t.closest('#fsAlert') || t.closest('#overlay'))) return;
      lastFocusPath = focusLocator(t);
    }, true);

    document.addEventListener('keydown', function (e) {
      var ov = $('overlay');
      if (e.key === 'Escape' && ov && ov.classList.contains('show')) { closeSheet(); return; }
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target;
      if (!t || t.tagName !== 'DIV' || !t.classList || !t.classList.contains('switch')) return;
      e.preventDefault();   // 阻止空格滚动页面
      t.click();
    });
  }

  function confirmDialog(title, body, okText, onOk) {
    openSheet(
      '<h3>' + title + '</h3><p>' + body + '</p>' +
      '<div style="display:flex;gap:10px;">' +
      '<button class="btn ghost" style="flex:1" onclick="App.closeSheet()">取消</button>' +
      '<button class="btn" style="flex:1" id="dlgOk">' + okText + '</button></div>'
    );
    $('dlgOk').onclick = function () { closeSheet(); onOk(); };
  }

  /* BR-08：危险操作的独立二次确认。
     与普通保存流程分开走，且必须写清后果与改动前后——
     这类操作不能混在「保存」里悄悄生效。取消时保持原状。 */
  function confirmDanger(title, body, okText, onOk) {
    openSheet(
      '<h3>' + title + '</h3>' +
      '<div class="note">' + body + '</div>' +
      '<div style="display:flex;gap:10px;">' +
      '<button class="btn ghost" style="flex:1" onclick="App.closeSheet()">取消，保持原样</button>' +
      '<button class="btn" style="flex:1;background:var(--danger)" id="dlgDanger">' + okText + '</button></div>'
    );
    $('dlgDanger').onclick = function () { closeSheet(); onOk(); };
  }

  /* ============================================================
   * 导航
   * ============================================================ */
  var TAB_OF = { today: 'today', plan: 'today', meds: 'meds', edit: 'meds', log: 'log', stats: 'log', me: 'me' };

  function go(page, opts) {
    current = page;
    if (page === 'edit' && opts !== false && !editState) editState = null;
    render();
    $('screen').scrollTop = 0;
  }

  /* ============================================================
   * 全屏强提醒（L3）
   * ============================================================ */
  /* 全屏强提醒（L3）对外声明的是 aria-modal="true" 的 alertdialog。
     既然声明了"模态"，焦点就必须真的被它接管——否则读屏器会一边宣布
     "这是模态对话框"，一边把焦点留在被它盖住的时间轴上。
     声明与事实不符正是本项目最防的一类问题（见 docs/04 §4.4），所以这里
     配套三件事：弹出时把焦点移进对话框、关闭时还给原来的控件、原控件没了就退到主内容区。 */
  function showFullscreen(reminder, desc) {
    $('fsTime').textContent = hhmm(reminder.scheduledAt);
    $('fsName').textContent = desc.title;
    $('fsDose').textContent = desc.body;
    var fs = $('fsAlert');
    // 升级链会在同一剂上反复调用（L2→L3），只在"从关到开"那一次记录归还目标
    if (!fs.classList.contains('show')) fsRestorePath = lastFocusPath;
    fs.classList.add('show');
    fs.setAttribute('aria-hidden', 'false');
    fs.dataset.reminderId = reminder.id;
    // 焦点给对话框本身，不直接给"我已服药"——避免用户还没看清就误确认一剂药。
    // 对话框带 tabindex="-1"，Tab 一次即可到"我已服药"。
    try { fs.focus(); } catch (e) { /* 极老浏览器不支持时忽略 */ }
  }
  function hideFullscreen() {
    var fs = $('fsAlert');
    fs.classList.remove('show');
    fs.setAttribute('aria-hidden', 'true');
    var path = fsRestorePath;
    fsRestorePath = null;
    // 归还焦点要放到本轮渲染之后：调用方（fsConfirm / fsSnooze）紧接着会 render()，
    // 重新生成 appbar 与 screen，把原来的元素整个换掉——
    // 先聚焦再重渲染等于白做，焦点最后掉回 document.body，用户的位置就丢了。
    setTimeout(function () {
      var el = path ? document.querySelector(path) : null;
      if (el && el.focus) { try { el.focus(); return; } catch (e) { /* 继续兜底 */ } }
      // 原位置确实找不回来了：退到主内容区，让读屏器从"主内容"继续，
      // 而不是回到文档根。比丢焦点好，也比乱猜一个控件好。
      var s = $('screen');
      if (s) { try { s.focus(); } catch (e) { /* 忽略 */ } }
    }, 0);
  }

  function fsConfirm() {
    var id = $('fsAlert').dataset.reminderId;
    var r = Store.findReminderById(id);
    if (r) {
      var log = Store.confirmReminder(r, 'in_app');
      cancelWatch(id);   // 已确认：撤销中继计时，家属不再被打扰
      toast('已记录服药 · ' + (STATUS_TEXT[log.status] || ''));
    }
    hideFullscreen();
    RE.reschedule();
    render();
  }
  function fsSnooze() {
    var id = $('fsAlert').dataset.reminderId;
    var r = Store.findReminderById(id);
    if (r) {
      r.level = 0;                     // 重置等级，10 分钟后重新走一遍 L1
      r.scheduledAt = new Date(Date.now() + 10 * 60000).toISOString();
      Store.save();
      toast('已推迟，将在 10 分钟后再次提醒');
    }
    hideFullscreen();
    RE.reschedule();   // 这条被推到 10 分钟后，唤醒时刻必须跟着重排
    render();
  }

  /* ============================================================
   * 漏服补救（L5）
   * ============================================================ */
  function showMakeup(reminder) {
    makeupReminder = reminder;
    var plan = Store.getPlan(reminder.planId);
    var med = plan ? Store.getMedicine(plan.medicineId) : null;
    var nextAt = S.nextScheduledAfter(Store.state.reminders, reminder.planId, new Date());
    var safety = (plan && plan.safetyGapMinutes) || Store.state.user.safetyGapMinutes || 120;
    var d = S.makeUpDecision(new Date(), nextAt, safety);

    var name = Store.state.user.hideDrugName ? '••••••' : (med ? med.name : '该药品');
    var gapText = d.gapMinutes == null
      ? '暂无后续服药计划。'
      : '距离下次服药还有 ' + Math.floor(d.gapMinutes / 60) + ' 小时 ' + (d.gapMinutes % 60) + ' 分钟。';

    var note = '<div class="note">本应用不提供任何医疗建议。是否补服、是否需要调整用药方案，请咨询医生或药师。</div>';

    if (d.allow) {
      openSheet(
        '<h3>你漏服了 ' + h(hhmm(reminder.scheduledAt)) + ' 的' + h(name) + '</h3>' +
        '<p style="margin-bottom:10px;">' + gapText + '</p>' + note +
        '<div style="display:flex;gap:10px;">' +
        '<button class="btn ghost" style="flex:1" id="mkSkip">跳过本次</button>' +
        '<button class="btn" style="flex:1" id="mkDo">现在补服</button></div>'
      );
      $('mkDo').onclick = function () { doMakeup(reminder); };
      $('mkSkip').onclick = function () {
        Store.skipReminder(reminder);
        cancelWatch(reminder.id);   // 已跳过：撤销中继计时
        RE.reschedule();
        closeSheet(); toast('已标记跳过，原漏服记录保留'); render();
      };
    } else {
      openSheet(
        '<h3>你漏服了 ' + h(hhmm(reminder.scheduledAt)) + ' 的' + h(name) + '</h3>' +
        '<p style="margin-bottom:10px;">' + gapText + '</p>' + note +
        '<button class="btn block" onclick="App.closeSheet()">知道了</button>'
      );
    }
  }

  function doMakeup(reminder) {
    Store.makeupReminder(reminder);
    cancelWatch(reminder && reminder.id);   // 已补服：撤销中继计时
    RE.reschedule();
    closeSheet();
    toast('已记录补服 · 原漏服记录同时保留');
    render();
  }

  /* ============================================================
   * 渲染：今日
   * ============================================================ */
  /**
   * 今日时间轴：按「计划时间点」构建，而非只读提醒对象。
   * 这样即便某个时间点还没有提醒记录（如应用整天未运行），今日页也不会漏项。
   */
  function todayTimeline() {
    var st = Store.state;
    var now = new Date();
    var items = [];
    st.plans.filter(function (p) { return p.isActive; }).forEach(function (p) {
      var med = Store.getMedicine(p.medicineId);
      if (!med || med.isArchived) return;
      if (!S.planCoversDay(p, now)) return;
      (p.times || []).forEach(function (t) {
        var at = S.resolveScheduledAt(p, now, t);
        var iso = at.toISOString();
        items.push({
          plan: p, med: med, at: at, iso: iso,
          reminder: Store.findReminderBySlot(p.id, iso)
        });
      });
    });
    items.sort(function (a, b) { return a.at - b.at; });
    return items;
  }

  function renderToday() {
    var items = todayTimeline();
    var now = Date.now();
    var done = items.filter(function (it) {
      return it.reminder && it.reminder.status === 'confirmed';
    }).length;
    var total = items.length;
    var pct = total ? Math.round((done / total) * 100) : 0;

    var next = items.filter(function (it) {
      return it.at.getTime() > now && !(it.reminder && it.reminder.status === 'confirmed');
    })[0];

    var nextText;
    if (next) {
      var label = Store.state.user.hideDrugName ? '••••••' : next.med.name;
      nextText = '下一剂：' + hhmm(next.at.toISOString()) + ' ' + h(label);
    } else if (total) {
      nextText = done === total ? '今日用药计划已全部完成' : '今天的用药时间点已全部过去';
    } else {
      nextText = '今天没有用药安排，去「用药」添加一条吧';
    }

    var rows = items.map(function (it) {
      var p = it.plan, med = it.med, rem = it.reminder;
      var log = rem ? logFor(rem) : null;
      var name = Store.state.user.hideDrugName ? '••••••' : med.name;
      var meta = p.doseAmount + ' ' + p.doseUnit + (p.mealLabel ? ' · ' + p.mealLabel : '');
      // 读屏器/键盘用户是按控件跳的，不是按视觉整行读的。
      // 今日页同一天可能有 4 个"我已服药"按钮，光念按钮文字根本分不清在给哪一剂打卡——
      // 所以操作按钮的可访问名称必须自带时间与药名（药名已按隐私模式遮蔽）。
      var doseLabel = hhmm(it.iso) + ' ' + name;
      var passed = it.at.getTime() <= now;
      var right, faded = false, ctaCls = '';

      if (rem && rem.status === 'confirmed') {
        var st = log ? log.status : 'on_time';
        var actual = log && log.actualTakenAt ? hhmm(log.actualTakenAt) : '';
        if (actual) meta += ' · 已服 ' + actual;   // 时间放副标题，避免挤压药名
        right = '<span class="badge ' + (STATUS_CLASS[st] || 'ok') + '">' + (STATUS_TEXT[st] || '已服') + '</span>';
        faded = true;
      } else if (rem && rem.status === 'missed') {
        // 漏服是本品最核心的信号，必须**写出来**而不是靠按钮文字暗示。
        // 此前这一支只有一个「补服处理」按钮，于是今日页上
        // 「已按时 / 延迟 / 已跳过」都有徽标，唯独漏服没有——
        // 而记录页对同一状态用的是「漏服」徽标，两处不一致。
        ctaCls = ' stack';
        right = '<span class="badge bad">' + STATUS_TEXT.missed + '</span>' +
          '<button class="btn sm ghost" aria-label="' + h('补服处理：' + doseLabel) + '"' +
          ' onclick="App.openMakeup(\'' + rem.id + '\')">补服处理</button>';
      } else if (rem && rem.status === 'cancelled') {
        right = '<span class="badge wait">已跳过</span>';
        faded = true;
      } else if (passed) {
        // 已过时间点但尚无记录：允许补录，避免静默丢失
        right = '<button class="btn sm ghost" aria-label="' + h('补录：' + doseLabel) + '"' +
          ' onclick="App.confirmTime(\'' + p.id + '\',\'' + it.iso + '\')">补录</button>';
      } else {
        right = '<button class="btn sm" aria-label="' + h('打卡：' + doseLabel) + '"' +
          ' onclick="App.confirmTime(\'' + p.id + '\',\'' + it.iso + '\')">我已服药</button>';
      }

      return '<div class="dose">' +
        '<div class="dose-time"' + (faded ? ' style="color:var(--sub)"' : '') + '>' + hhmm(it.iso) + '</div>' +
        '<div class="pill-icon"><svg viewBox="0 0 24 24"><path d="M10.5 3.5 3.5 10.5a5 5 0 0 0 7 7l7-7a5 5 0 0 0-7-7Z"/></svg></div>' +
        '<div class="col"><div class="dose-name">' + h(name) + '</div><div class="dose-meta">' + h(meta) + '</div></div>' +
        '<div class="dose-cta' + ctaCls + '">' + right + '</div></div>';
    }).join('');

    return '<div class="pad">' +
      reliabilityBanner() +
      '<div class="card">' +
        '<div class="prog-head"><span class="prog-num">' + done + '/' + total + '</span><span class="muted">今日服药完成</span></div>' +
        '<div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%"></div></div>' +
        '<p class="tiny" style="margin-top:10px;">' + nextText + '</p>' +
      '</div>' +
      '<div class="card"><div class="card-title"><span>今日时间轴</span>' +
        '<span class="more" onclick="App.go(\'plan\')">查看 7 天</span></div>' +
        (rows || '<p class="tiny" style="padding:14px 0;text-align:center;">今天还没有用药安排</p>') +
      '</div>' +
      '<div class="card" style="background:var(--primary-soft);border-color:#cfe0fb;">' +
        '<div class="row"><div class="pill-icon" style="background:#fff;"><svg viewBox="0 0 24 24" style="stroke:var(--primary);fill:none;stroke-width:1.9"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg></div>' +
        '<div class="col"><div style="font-size:.86em;font-weight:600;margin-bottom:2px;">漏服了怎么办？</div><div class="tiny">查看漏服补救流程说明</div></div>' +
        '<span style="color:var(--primary);font-size:1.2em;cursor:pointer" onclick="App.missFlowInfo()">›</span></div>' +
      '</div>' +
    '</div>';
  }

  /* ============================================================
   * 渲染：药箱
   * ============================================================ */
  function renderMeds() {
    var st = Store.state;
    var active = st.medicines.filter(function (m) { return !m.isArchived; });
    var plans = st.plans.filter(function (p) { return p.isActive; });

    var rows = active.map(function (m) {
      var ps = plans.filter(function (p) { return p.medicineId === m.id; });
      var desc = ps.length
        ? ps.map(function (p) {
            return p.times.join(' / ') + (p.mealLabel ? ' ' + p.mealLabel : '');
          }).join('；')
        : '未设置用药计划';

      var low = m.stockAmount != null && m.stockAmount <= 3 * ps.reduce(function (a, p) { return a + p.times.length; }, 0);
      // 可点击的行用真 <button>：键盘 Tab / Enter 与读屏器天然可用，
      // 不需要自己补 tabindex + keydown（补漏一处就成了「只有鼠标能用」）。
      return '<button type="button" class="list-row" aria-label="编辑药品：' + h(m.name) + '" onclick="App.editMedicine(\'' + m.id + '\')">' +
        '<span class="pill-icon"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.5 3.5 3.5 10.5a5 5 0 0 0 7 7l7-7a5 5 0 0 0-7-7Z"/></svg></span>' +
        '<span class="col"><span class="dose-name">' + h(m.name) + '</span>' +
        '<span class="dose-meta">' + h((m.strength || m.specification || '') + ' · ' + desc) + '</span></span>' +
        (low ? '<span class="badge warn">余量不足</span>' : '<span class="chev" aria-hidden="true">›</span>') +
      '</button>';
    }).join('');

    return '<div class="pad">' +
      '<div class="card">' + (rows || '<p class="tiny" style="padding:16px 0;text-align:center;">药箱是空的，点下方按钮添加</p>') + '</div>' +
      '<button class="btn block ghost" style="padding:14px;" onclick="App.newMedicine()">+ 添加药品</button>' +
      '<p class="tiny" style="text-align:center;margin-top:14px;line-height:1.7;">' +
        '共 ' + st.medicines.filter(function (m) { return !m.isArchived; }).length + ' 种药品 · ' + plans.length + ' 条用药计划<br>' +
        '已生成未来提醒 ' + RE.pendingCount() + ' 条' +
      '</p>' +
    '</div>';
  }

  /* ============================================================
   * 渲染：药品编辑
   * ============================================================ */
  function newMedicine() {
    editState = {
      id: null, mode: 'new',
      name: '', specification: '', dosageForm: 'tablet', strength: '',
      doseAmount: 1, doseUnit: '片',
      frequencyType: 'daily', times: ['08:00'],
      mealRelation: 'none', mealLabel: '不限',
      isLongTerm: true, endDate: '', note: ''
    };
    go('edit');
  }

  function editMedicine(medicineId) {
    var m = Store.getMedicine(medicineId);
    if (!m) return;
    var p = Store.state.plans.filter(function (x) { return x.medicineId === medicineId && x.isActive; })[0];
    editState = {
      id: m.id, mode: 'edit',
      name: m.name, specification: m.specification, dosageForm: m.dosageForm, strength: m.strength,
      doseAmount: p ? p.doseAmount : 1, doseUnit: p ? p.doseUnit : '片',
      frequencyType: p ? p.frequencyType : 'daily',
      times: p ? p.times.slice() : ['08:00'],
      mealRelation: p ? p.mealRelation : 'none',
      mealLabel: p ? (p.mealLabel || '不限') : '不限',
      isLongTerm: p ? p.isLongTerm : true,
      endDate: p && p.endDate ? p.endDate : '',
      note: m.note || ''
    };
    go('edit');
  }

  var MEALS = [
    { k: 'none', label: '不限' },
    { k: 'fasting', label: '空腹' },
    { k: 'before_meal', label: '餐前 30 分钟' },
    { k: 'with_meal', label: '餐中' },
    { k: 'after_meal', label: '餐后 30 分钟' },
    { k: 'bedtime', label: '睡前' }
  ];
  var UNITS = ['片', '半片', '粒', 'ml', '滴', '喷'];

  function renderEdit() {
    if (!editState) { editState = { id: null, mode: 'new', name: '', specification: '', dosageForm: 'tablet', strength: '', doseAmount: 1, doseUnit: '片', frequencyType: 'daily', times: ['08:00'], mealRelation: 'none', mealLabel: '不限', isLongTerm: true, endDate: '', note: '' }; }
    var e = editState;

    function seg(items, field, currentVal, labelKey, valKey) {
      return items.map(function (it) {
        var v = valKey ? it[valKey] : it;
        var lb = labelKey ? it[labelKey] : it;
        var sel = String(v) === String(currentVal) ? ' class="sel"' : '';
        return '<span' + sel + ' onclick="App.setField(\'' + field + '\',\'' + v + '\',' + (labelKey ? '\'' + lb + '\'' : 'null') + ')">' + h(lb) + '</span>';
      }).join('');
    }

    var timesHtml = e.times.map(function (t, i) {
      return '<div class="row" style="margin-bottom:8px;">' +
        '<input type="time" value="' + t + '" onchange="App.setTime(' + i + ',this.value)" style="flex:1">' +
        (e.times.length > 1
          ? '<button class="btn ghost sm" onclick="App.removeTime(' + i + ')">删除</button>'
          : '') +
        '</div>';
    }).join('');

    return '<div class="pad">' +
      '<div class="card">' +
        '<div class="field"><label>药品名称</label>' +
          '<input id="fName" value="' + h(e.name) + '" placeholder="如：苯磺酸氨氯地平片" oninput="App.setField(\'name\',this.value)"></div>' +
        '<div class="field"><label>规格</label>' +
          '<input value="' + h(e.specification) + '" placeholder="如：5mg × 7 片/盒" oninput="App.setField(\'specification\',this.value)"></div>' +
        '<div class="field" style="margin-bottom:0;"><label>每次剂量</label>' +
          '<div class="row"><input type="number" min="0.25" step="0.25" value="' + e.doseAmount + '" style="width:88px" oninput="App.setField(\'doseAmount\',this.value)">' +
          '<div class="seg" style="flex:1;">' + seg(UNITS, 'doseUnit', e.doseUnit) + '</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">用药时间</div>' +
        timesHtml +
        '<button class="btn ghost sm" style="width:100%;margin-top:4px" onclick="App.addTime()">+ 添加一个时间点</button>' +
      '</div>' +

      '<div class="card">' +
        '<div class="field" style="margin-bottom:0;"><label>与进餐的关系</label>' +
          '<div class="seg">' + seg(MEALS, 'mealRelation', e.mealRelation, 'label', 'k') + '</div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="field" style="margin-bottom:0;"><label>疗程</label>' +
          '<div class="seg"><span' + (e.isLongTerm ? ' class="sel"' : '') + ' onclick="App.setLongTerm(true)">长期服用</span>' +
          '<span' + (!e.isLongTerm ? ' class="sel"' : '') + ' onclick="App.setLongTerm(false)">指定结束日期</span></div>' +
          (!e.isLongTerm ? '<input type="date" value="' + h(e.endDate) + '" style="margin-top:10px" onchange="App.setField(\'endDate\',this.value)">' : '') +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="field" style="margin-bottom:0;"><label>备注</label>' +
          '<input value="' + h(e.note) + '" placeholder="如：血压高时服用（选填）" oninput="App.setField(\'note\',this.value)"></div>' +
      '</div>' +

      '<button class="btn block lg" onclick="App.saveMedicine()">保存并生成排程</button>' +
      (e.mode === 'edit'
        ? '<button class="btn block ghost" style="padding:14px;margin-top:10px;color:var(--danger);border-color:#f3c9c9" onclick="App.archiveCurrent()">停用并归档该药品</button>'
        : '') +
      '<p class="tiny" style="text-align:center;margin-top:12px;line-height:1.7;">' +
        '保存后将重建未来 ' + S.DEFAULT_PLAN_DAYS + ' 天的提醒<br>修改仅影响未来排程，历史记录不会被改写</p>' +
    '</div>';
  }

  function setField(field, value) {
    if (!editState) return;
    if (field === 'doseAmount') value = Number(value) || 0;
    editState[field] = value;
    if (field === 'mealRelation') {
      var m = MEALS.filter(function (x) { return x.k === value; })[0];
      if (m) editState.mealLabel = m.label;
      render();
    }
    if (field === 'dosageForm' || field === 'doseUnit') render();
  }
  function setTime(i, v) { editState.times[i] = v; }
  function addTime() {
    editState.times.push('12:00');
    render();
  }
  function removeTime(i) {
    editState.times.splice(i, 1);
    render();
  }
  function setLongTerm(v) {
    editState.isLongTerm = v;
    if (v) editState.endDate = '';
    else if (!editState.endDate) {
      var d = new Date(); d.setDate(d.getDate() + 7);
      editState.endDate = S.dateKey(d);
    }
    render();
  }

  function saveMedicine() {
    var e = editState;
    if (!e.name || !e.name.trim()) { toast('请填写药品名称'); return; }

    var endDate = e.isLongTerm ? null : (e.endDate || null);
    if (!e.isLongTerm && !endDate) { toast('请选择疗程结束日期'); return; }

    var existPlan = e.id
      ? Store.state.plans.filter(function (p) { return p.medicineId === e.id && p.isActive; })[0]
      : null;

    // BR-08：剂量属于处方内容，修改必须有独立二次确认，并写明改动前后。
    // 这里只拦「已有计划被改剂量」的情况，新增药品不打扰。
    if (existPlan && existPlan.doseAmount !== e.doseAmount) {
      confirmDanger(
        '确认修改剂量？',
        '「' + h(e.name.trim()) + '」的剂量将从 <b>' + h(existPlan.doseAmount + ' ' + existPlan.doseUnit) +
        '</b> 改为 <b>' + h(e.doseAmount + ' ' + e.doseUnit) + '</b>。<br>' +
        '剂量属于处方内容，改动后请再次核对医嘱。',
        '确认修改',
        commitMedicineEdit
      );
      return;
    }
    commitMedicineEdit();
  }

  /** 真正落盘的部分。被 saveMedicine 直接调用，或在 BR-08 二次确认通过后调用。 */
  function commitMedicineEdit() {
    var e = editState;
    var endDate = e.isLongTerm ? null : (e.endDate || null);

    var medId = e.id;
    if (medId) {
      Store.updateMedicine(medId, {
        name: e.name.trim(), specification: e.specification, dosageForm: e.dosageForm,
        strength: e.strength || e.specification, note: e.note
      });
    } else {
      var m = Store.addMedicine({
        name: e.name.trim(), specification: e.specification, dosageForm: e.dosageForm,
        strength: e.strength || e.specification, note: e.note
      });
      medId = m.id;
    }

    var existPlan = Store.state.plans.filter(function (p) { return p.medicineId === medId && p.isActive; })[0];
    var payload = {
      medicineId: medId, doseAmount: e.doseAmount, doseUnit: e.doseUnit,
      frequencyType: 'daily', anchorType: 'absolute',
      mealRelation: e.mealRelation, mealLabel: e.mealLabel,
      times: e.times.slice().sort(), endDate: endDate, isLongTerm: e.isLongTerm
    };
    if (!payload.times.length) payload.times = ['08:00'];

    if (existPlan) Store.updatePlan(existPlan.id, payload);
    else Store.addPlan(payload);

    RE.reschedule();   // 排程变了，立刻重排唤醒时刻（否则新药可能要等兜底上限才响应）
    var pending = RE.pendingCount();
    editState = null;
    go('meds');
    toast('已保存，未来 ' + S.DEFAULT_PLAN_DAYS + ' 天共 ' + pending + ' 条提醒已生成');
  }

  function archiveCurrent() {
    if (!editState || !editState.id) return;
    var id = editState.id;
    confirmDialog('确认停用？', '停用后该药品不再产生新的提醒，但<b>历史服药记录会完整保留</b>，随时可恢复。', '确认停用', function () {
      Store.archiveMedicine(id);
      RE.reschedule();   // 该药的待触发提醒已取消，最近的下一个事件多半变了
      editState = null;
      go('meds');
      toast('已停用并归档，历史记录保留');
    });
  }

  /* ============================================================
   * 渲染：排程预览
   * ============================================================ */
  function renderPlan() {
    var today = new Date();
    var html = '';
    for (var d = 0; d < 7; d++) {
      var day = S.addDays(today, d);
      var key = S.dateKey(day);
      var items = Store.state.reminders.filter(function (r) {
        return S.dateKey(new Date(r.scheduledAt)) === key && r.status !== 'cancelled';
      }).sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });

      var chips = items.map(function (r) {
        var p = Store.getPlan(r.planId);
        var m = p ? Store.getMedicine(p.medicineId) : null;
        var cls = r.status === 'confirmed' ? 'ok' : (r.status === 'missed' ? 'bad' : 'wait');
        var nm = Store.state.user.hideDrugName ? '••••' : (m ? m.name.replace(/片$|胶囊$|缓释片$/, '').slice(0, 5) : '');
        return '<span class="badge ' + cls + '" style="padding:8px 11px;">' + hhmm(r.scheduledAt) + ' ' + h(nm) + '</span>';
      }).join('');

      html += '<div class="card"><div class="card-title"><span>' + dateCn(day.toISOString()) + ' · ' +
        (d === 0 ? '今天' : (d === 1 ? '明天' : dayCn(day))) + '</span>' +
        '<span class="more" style="color:var(--sub);cursor:default;">' + items.length + ' 次</span></div>' +
        (chips || '<p class="tiny">无用药安排</p>') + '</div>';
    }

    return '<div class="pad">' + html +
      '<div class="card" style="text-align:center;">' +
        '<p class="tiny">未来 ' + S.DEFAULT_PLAN_DAYS + ' 天共 ' + RE.pendingCount() + ' 条待触发提醒</p>' +
        '<p class="tiny" style="margin-top:6px;">修改处方仅影响未来排程，历史记录不会被改写</p>' +
      '</div></div>';
  }

  /* ============================================================
   * 渲染：记录
   * ============================================================ */
  function renderLog() {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    var first = new Date(y, m, 1);
    var daysInMonth = new Date(y, m + 1, 0).getDate();

    var byDay = {};
    Store.state.logs.forEach(function (l) {
      var d = new Date(l.scheduledAt);
      if (d.getFullYear() !== y || d.getMonth() !== m) return;
      var k = d.getDate();
      if (!byDay[k]) byDay[k] = { on_time: 0, delayed: 0, missed: 0 };
      if (byDay[k][l.status] != null) byDay[k][l.status]++;
    });

    var cells = '<div class="cal-h">日</div><div class="cal-h">一</div><div class="cal-h">二</div><div class="cal-h">三</div><div class="cal-h">四</div><div class="cal-h">五</div><div class="cal-h">六</div>';
    for (var i = 0; i < first.getDay(); i++) cells += '<div class="cal-d" style="background:transparent"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var o = byDay[d];
      var cls = '';
      if (o) cls = o.missed > 0 ? 'bad' : (o.delayed > 0 ? 'warn' : 'ok');
      var isToday = d === now.getDate();
      cells += '<div class="cal-d ' + cls + (isToday ? ' today' : '') + '">' + d +
        (o ? '<span class="dot"></span>' : '') + '</div>';
    }

    // 最近一天的明细
    var recent = Store.state.logs.slice().sort(function (a, b) {
      return a.scheduledAt < b.scheduledAt ? 1 : -1;
    }).slice(0, 8);

    var rows = recent.map(function (l) {
      var med = Store.getMedicine(l.medicineId);
      var nm = Store.state.user.hideDrugName ? '••••••' : (med ? med.name : '未知药品');
      var time = hhmm(l.scheduledAt);
      var meta;
      if (l.status === 'missed') meta = l.missReason ? '未记录 · ' + h(l.missReason) : '未记录';
      else if (l.isMakeup) meta = '补服于 ' + hhmm(l.actualTakenAt);
      else if (l.delayMinutes == null) meta = '已记录';
      else meta = '实际 ' + hhmm(l.actualTakenAt) + ' · ' + (l.delayMinutes >= 0 ? '延迟 ' + l.delayMinutes : '提前 ' + (-l.delayMinutes)) + ' 分钟';

      return '<div class="dose">' +
        '<div class="dose-time" style="color:var(--sub)">' + time + '</div>' +
        '<div class="col"><div class="dose-name">' + h(nm) + '</div><div class="dose-meta">' + meta + '</div></div>' +
        '<span class="badge ' + (STATUS_CLASS[l.status] || 'wait') + '">' + (STATUS_TEXT[l.status] || l.status) + '</span>' +
        '</div>';
    }).join('');

    return '<div class="pad">' +
      '<div class="card"><div class="card-title"><span>' + (m + 1) + ' 月热力图</span>' +
        '<span class="row" style="gap:9px;font-size:.8em;font-weight:400;color:var(--sub);">' +
        '<span style="color:var(--ok)">● 按时</span><span style="color:var(--warn)">● 延迟</span><span style="color:var(--danger)">● 漏服</span></span></div>' +
        '<div class="cal-grid">' + cells + '</div></div>' +
      '<div class="card"><div class="card-title"><span>最近记录</span>' +
        '<span class="more" onclick="App.exportData()">导出数据</span></div>' +
        (rows || '<p class="tiny" style="padding:12px 0;text-align:center;">还没有服药记录</p>') + '</div>' +
    '</div>';
  }

  /* ============================================================
   * 渲染：统计
   * ============================================================ */
  function renderStats() {
    var from = new Date();
    from.setDate(from.getDate() - 29);
    from.setHours(0, 0, 0, 0);
    var sum = S.summarize(Store.state.logs, from, new Date());
    var total = sum.onTime + sum.delayed + sum.missed;

    var hourRows = Object.keys(sum.byHour).sort().map(function (k) {
      var o = sum.byHour[k];
      var color = o.rate >= 90 ? 'var(--ok)' : (o.rate >= 75 ? 'var(--warn)' : 'var(--danger)');
      return '<div class="hbar"><span class="lbl">' + k + '</span>' +
        '<div class="track"><div class="fill" style="width:' + o.rate + '%;background:' + color + '"></div></div>' +
        '<span class="val">' + o.rate + '%</span></div>';
    }).join('');

    var medRows = Object.keys(sum.byMedicine).map(function (k) {
      var o = sum.byMedicine[k];
      var med = Store.getMedicine(k);
      var nm = med ? med.name.replace(/片$|胶囊$/, '').slice(0, 6) : '未知';
      var color = o.rate >= 90 ? 'var(--ok)' : (o.rate >= 75 ? 'var(--warn)' : 'var(--danger)');
      return '<div class="hbar"><span class="lbl">' + h(nm) + '</span>' +
        '<div class="track"><div class="fill" style="width:' + o.rate + '%;background:' + color + '"></div></div>' +
        '<span class="val">' + o.rate + '%</span></div>';
    }).join('');

    // 找出最易漏服的时段
    var worst = null;
    Object.keys(sum.byHour).forEach(function (k) {
      if (sum.byHour[k].total >= 2 && (!worst || sum.byHour[k].rate < worst.rate)) {
        worst = { k: k, rate: sum.byHour[k].rate };
      }
    });
    var tip = worst
      ? '发现：<b>' + worst.k + '</b> 时段按时率最低（' + worst.rate + '%），建议把该时段的提醒改为「全屏强提醒」。'
      : '记录还不够多，坚持打卡几天后这里会给出时段分析。';

    var pct = function (n) { return total ? Math.round((n / total) * 100) : 0; };

    return '<div class="pad">' +
      '<div class="card"><div class="stat-grid">' +
        '<div class="stat"><b style="color:var(--ok)">' + sum.onTimeRate + '%</b><span>按时率</span></div>' +
        '<div class="stat"><b style="color:var(--warn)">' + pct(sum.delayed) + '%</b><span>延迟率</span></div>' +
        '<div class="stat"><b style="color:var(--danger)">' + pct(sum.missed) + '%</b><span>漏服率</span></div>' +
      '</div><p class="tiny" style="margin-top:12px;text-align:center;">近 30 天共 ' + total + ' 次应服药记录</p></div>' +

      '<div class="card"><div class="card-title">各时段按时率</div>' +
        (hourRows || '<p class="tiny">暂无数据</p>') +
        '<p class="tiny" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">' + tip + '</p></div>' +

      '<div class="card"><div class="card-title">单药依从率</div>' +
        (medRows || '<p class="tiny">暂无数据</p>') + '</div>' +

      '<div class="card"><div class="card-title">复诊报告</div>' +
        '<p class="tiny" style="line-height:1.8;margin-bottom:12px;">' +
        '按时 ' + sum.onTime + ' 次 · 延迟 ' + sum.delayed + ' 次 · 漏服 ' + sum.missed + ' 次 · 补服 ' + sum.makeup + ' 次<br>' +
        '报告可直接导出，复诊时给医生查看完整服药情况。</p>' +
        '<button class="btn block" onclick="App.exportReport()">导出复诊报告</button></div>' +
    '</div>';
  }

  /* ============================================================
   * 渲染：我的
   * ============================================================ */
  /* ============================================================
   * 系统级闹钟同步与可靠性体检
   * 提醒能否送达是产品的生命线，所以这里既不静默失败，也不粉饰限制。
   * ============================================================ */
  var syncResult = null;
  var syncTimer = null;
  var permState = 'unknown';
  var exactAlarmState = 'unknown';   // Android 12+ 的精确闹钟独立开关
  var pendingTz = null;   // 待用户确认的时区变化

  function refreshPermission() {
    var p = PF.get();
    return Promise.all([p.permissionState(), p.exactAlarmState()]).then(function (r) {
      permState = r[0];
      exactAlarmState = r[1];
      if (current === 'me') patchSyncCard();
      return permState;
    }, function () { return permState; });
  }

  /** 同步节奏做去抖：连续操作只在最后一次真正落盘后同步一次 */
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, 250);
  }

  function buildJobs() {
    return PF.buildJobs(Store.state.reminders, {
      // L1 到点、L2 催办、L3 强催办都交给系统托管；L4 通知家属由中继计时，
      // L5 漏服结算由页面负责，这两级不产生系统通知。
      // L3 走「用药催办」渠道（与 L2 同渠道），且不带 allowWhileIdle，
      // 允许 Doze 推迟到维护窗口——不会挤占 L1 的准时额度。
      levels: [1, 2, 3],
      speedFactor: Store.state.user.demoFast ? RE.DEMO_SPEED : 1,
      describe: function (r) { return RE.describe(r); }
    });
  }

  function doSync() {
    return PF.get().sync(buildJobs()).then(function (res) {
      syncResult = res;
      patchSyncCard();               // 只补写卡片，不整体重渲染，避免触发同步循环
      // 系统闹钟对齐之后，中继计时待办也跟着对齐——两份"时刻表"来自同一次
      // 排程变化，不能只对内不对外，否则中继按旧时刻推送
      syncCaregiverWatches();
      return res;
    }, function (e) {
      syncResult = { error: (e && e.message) || String(e), registered: 0, deferred: 0, overflow: false, supported: false };
      patchSyncCard();
      return syncResult;
    });
  }

  function syncHeadline() {
    var p = PF.get();
    if (!p.canScheduleSystemAlarm) return '页面内提醒';
    if (!syncResult) return '同步中…';
    if (syncResult.error) return '注册失败';
    // systemCount 是同步后从系统读回的真实数量（null=未知）。
    // 账面数（registered）说「我们交了什么」，systemCount 说「系统里真有什么」，
    // 两者不一致时必须按系统侧说，不能拿账面数充数。
    if (typeof syncResult.systemCount === 'number' && syncResult.systemCount < syncResult.registered) {
      if (syncResult.systemCount === 0) return '系统闹钟已丢失';
      return '系统闹钟仅剩 ' + syncResult.systemCount + '/' + syncResult.registered + ' 条';
    }
    var s = '系统已托管 ' + syncResult.registered + ' 条';
    if (syncResult.overflow) s += ' · 推迟 ' + syncResult.deferred + ' 条';
    return s;
  }

  /**
   * 「提醒现在不可靠」的统一判定。
   *
   * 为什么要有这个函数：这些状态原先只出现在「我的 → 提醒可靠性」卡片里，
   * 而长者几乎不会点进那一页。于是「通知权限被关闭 / 精确闹钟未开启 →
   * 到点一声不响」这件事在界面上是**隐形的**：首页照常显示今日时间轴，
   * 一切看起来正常，只是什么都不发生——这正是最贵的一类缺陷
   * （不报错、不崩溃，只是悄悄不成立）。
   *
   * 返回 null 表示没有会让提醒失效的问题。
   * 注意这里只判定**会让提醒失效**的红线，比可靠性卡片窄：
   * 卡片还会展示「超出托管上限」这类非致命提示（那只影响远未来的提醒）。
   */
  function reliabilityIssue() {
    if (permState === 'denied') {
      return {
        title: '通知权限已被关闭，用药提醒不会响',
        detail: '到点不会有横幅、声音或振动。请在系统设置里允许「药准时」发送通知。'
      };
    }
    if (exactAlarmState === 'denied' || exactAlarmState === 'prompt') {
      return {
        title: '「闹钟和提醒」未授权，提醒可能被推迟',
        detail: 'Android 12 起需单独授权；未授权时提醒可能晚几分钟甚至更久。'
      };
    }
    if (syncResult && syncResult.error) {
      return {
        title: '系统闹钟注册失败，提醒可能不会准时送达',
        detail: '系统返回：' + syncResult.error
      };
    }
    if (syncResult && syncResult.supported && syncResult.registered === 0 && RE.pendingCount() > 0) {
      return {
        title: '还没有提醒交给系统托管',
        detail: '应用不在前台时提醒不会响。请重新同步一次。'
      };
    }
    // 系统侧对账：账面注册了 N 条，但同步后从系统读回的数量更少。
    // 「已托管」的账面记录不代表闹钟活着——ROM 深度清理、重启未恢复、
    // 系统删闹钟都会造成账实分离，此时必须按系统侧说真话。
    if (syncResult && syncResult.supported && typeof syncResult.systemCount === 'number' &&
        syncResult.systemCount < syncResult.registered && syncResult.registered > 0) {
      return {
        title: syncResult.systemCount === 0
          ? '系统闹钟已被清理，提醒不会响'
          : '部分系统闹钟已丢失（剩 ' + syncResult.systemCount + '/' + syncResult.registered + ' 条）',
        detail: '手机清理、省电策略或重启可能删掉系统闹钟。回到本应用会自动重新同步；若反复出现，请在系统设置里允许自启动与后台运行。'
      };
    }
    return null;
  }

  /** 首页顶部的红色横幅：把「现在提醒不可靠」说在用户不用点进去就能看到的地方 */
  function reliabilityBanner() {
    var m = reliabilityIssue();
    if (!m) return '';
    return '<div class="card" style="background:var(--danger-soft);border-color:#f0c4c4;">' +
      '<div class="row"><div class="pill-icon" style="background:#fff;">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="stroke:#b3261e;fill:none;stroke-width:1.9">' +
      '<path d="M10.3 3.9 2.6 17.4A1.9 1.9 0 0 0 4.3 20.3h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"/>' +
      '<path d="M12 9.5v4M12 16.8h.01"/></svg></div>' +
      '<div class="col"><div style="font-size:.86em;font-weight:600;">' + h(m.title) + '</div>' +
      '<div class="tiny">' + h(m.detail) + '</div></div></div>' +
      '<button class="btn block sm ghost" style="margin-top:10px" onclick="App.go(\'me\')">去处理</button>' +
      '</div>';
  }

  function reliabilityHtml() {
    var d = PF.diagnose({ permission: permState, exactAlarm: exactAlarmState });
    var MARK = { ok: '✓', bad: '✕', warn: '!' };
    var CLS = { ok: 'ok', bad: 'bad', warn: 'warn' };
    var rows = d.checks.map(function (c) {
      return '<div class="list-row" style="cursor:default">' +
        '<span class="badge ' + (CLS[c.level] || 'wait') + '" style="flex:none;min-width:1.6em;text-align:center;">' + MARK[c.level] + '</span>' +
        '<div class="col"><div style="font-size:.86em;font-weight:600;">' + h(c.label) + '</div>' +
        '<div class="tiny">' + h(c.detail) + '</div></div></div>';
    }).join('');

    // 三种情况互斥，且都要说真话：
    //  - 无法托管：绝不能展示"已保证 N 条"这种虚假承诺
    //  - 注册失败：如实暴露，不假装成功
    //  - 超出配额：说明推迟策略与用户需要做什么
    var p = PF.get();
    var extra = '';
    if (Store.state.user.demoFast) {
      // 演示加速会制造"系统里没有近期闹钟"的观测假象：演示触发的 L1 在 3 秒内
      // 响完即消失，其余提醒的 L1 都在真实的每日时刻。不在这一页说明，
      // 用户就会拿演示模式测熄屏送达并得出错误结论（P10 排障实录）。
      extra = '<div class="note" style="margin-top:12px;">' +
        '<b>演示加速开启中</b>——「立即触发演示」的提醒 3 秒内就响完，' +
        '此后系统里没有近期闹钟。要验证后台/熄屏送达，请先关闭演示加速，' +
        '再新建一条「现在 + 3 分钟」的真实提醒。</div>';
    } else if (!p.canScheduleSystemAlarm) {
      extra = '<div class="note" style="margin-top:12px;">' +
        '当前环境无法把提醒交给系统，<b>只有应用处于打开状态时才会响铃</b>。' +
        '安装为手机应用后可获得系统级准时提醒。</div>';
    } else if (syncResult && syncResult.error) {
      extra = '<div class="note" style="background:var(--danger-soft);color:#8f1d1d;margin-top:12px;">' +
        '系统闹钟注册失败（' + h(syncResult.error) + '）。提醒可能不会准时送达，' +
        '请检查是否禁用了「精确闹钟」权限。</div>';
    } else if (syncResult && syncResult.overflow) {
      extra = '<div class="note" style="margin-top:12px;">' +
        '提醒条数超出系统可托管上限，已优先保证最近 ' + syncResult.registered + ' 条。' +
        '其余 ' + syncResult.deferred + ' 条会在下次打开应用时自动补齐，' +
        '<b>请保持每周至少打开一次本应用</b>。</div>';
    }

    var buttons = '<button class="btn sm ghost" style="flex:1" onclick="App.resync()">重新同步</button>' +
      '<button class="btn sm ghost" style="flex:1" onclick="App.showDiag()">查看详情</button>';
    if (exactAlarmState === 'denied' || exactAlarmState === 'prompt') {
      buttons = '<button class="btn sm" style="flex:1" onclick="App.openExactAlarm()">开启精确闹钟</button>' + buttons;
    }

    return rows + extra +
      '<div class="row" style="gap:10px;margin-top:12px;">' + buttons + '</div>';
  }

  /** 跳转系统设置开启精确闹钟；系统在此过程中会删除并重建已排闹钟 */
  function openExactAlarm() {
    PF.get().openExactAlarmSetting().then(function (okd) {
      if (okd) toast('请在系统设置中允许「闹钟和提醒」，返回后会自动重新同步');
      else toast('无法自动跳转，请到「设置 → 应用 → 药准时 → 闹钟和提醒」中开启');
    });
  }

  function patchSyncCard() {
    var head = $('syncHeadline'), body = $('syncBody');
    if (head) head.textContent = syncHeadline();
    if (body) body.innerHTML = reliabilityHtml();
  }

  function showDiag() {
    var d = PF.diagnose({ permission: permState, exactAlarm: exactAlarmState });
    var lines = d.checks.map(function (c) {
      return (c.level === 'ok' ? '✅' : c.level === 'bad' ? '❌' : '⚠️') + ' ' + c.label + '：' + c.detail;
    }).join('<br>');
    var plan = syncResult && syncResult.horizonEnd
      ? '<p class="tiny" style="margin-top:10px;">已托管提醒覆盖到 ' + dateCn(syncResult.horizonEnd) + ' ' + hhmm(syncResult.horizonEnd) + '</p>'
      : '';
    openSheet(
      '<h3>提醒可靠性详情</h3>' +
      '<p class="tiny" style="line-height:1.9;margin-bottom:8px;">运行环境：' + h(d.label) + '（可托管上限 ' + d.quota + ' 条）</p>' +
      '<p class="tiny" style="line-height:1.9;">' + lines + '</p>' + plan +
      '<p class="tiny" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);line-height:1.75;">' + h(d.note || '') + '</p>' +
      '<button class="btn block" style="margin-top:14px" onclick="App.closeSheet()">知道了</button>'
    );
  }

  function resync() {
    toast('正在同步系统闹钟…');
    doSync().then(function (r) {
      if (r.error) toast('同步失败：' + r.error);
      else if (r.supported) toast('已托管 ' + r.registered + ' 条提醒到系统');
      else toast('当前环境不支持系统级闹钟');
    });
  }

  /* ============================================================
   * 时区变化：必须由用户二选一（BR-05）
   * ============================================================ */
  function showTzPrompt(change) {
    pendingTz = change;
    var dir = change.deltaMinutes > 0 ? '提前' : '推后';
    var hrs = Math.abs(change.deltaMinutes) / 60;
    var sample = Store.state.plans.filter(function (p) { return p.isActive && p.times && p.times.length; })[0];
    var t0 = sample ? sample.times[0] : '07:00';

    var follow = S.resolveTimezoneChange(S.TZ_POLICY.FOLLOW_LOCAL, change, [t0]);
    var keep = S.resolveTimezoneChange(S.TZ_POLICY.KEEP_RHYTHM, change, [t0]);

    openSheet(
      '<h3>检测到时区变化</h3>' +
      '<p>设备时区从 <b>' + h(change.from) + '</b> 变为 <b>' + h(change.to) + '</b>（当地时间' + dir + ' ' + hrs + ' 小时）。' +
      '请选择接下来如何服药——这一步必须由你决定，本应用不会替你改处方。</p>' +

      '<div class="card" style="margin-top:6px;cursor:pointer;" onclick="App.tzChoose(\'follow_local\')">' +
      '<div class="card-title"><span>按当地钟点服药（推荐）</span><span class="badge ok">推荐</span></div>' +
      '<p class="tiny" style="line-height:1.75;">' + h(follow.description) + '<br>' +
      '你原来的 <b>' + t0 + '</b> 在新时区仍是当地 <b>' + follow.times[0] + '</b>，贴合当地作息。</p></div>' +

      '<div class="card" style="cursor:pointer;" onclick="App.tzChoose(\'keep_rhythm\')">' +
      '<div class="card-title">保持原有服药间隔</div>' +
      '<p class="tiny" style="line-height:1.75;">' + h(keep.description) + '<br>' +
      '你原来的 <b>' + t0 + '</b> 在新时区变为当地 <b>' + keep.times[0] + '</b>（可能落在半夜，请谨慎选择）。</p></div>' +

      '<p class="tiny" style="line-height:1.75;">无论选择哪一种，都只影响之后的提醒排程，已有的服药记录不会被改写。</p>' +
      '<button class="btn block ghost" style="margin-top:4px" onclick="App.tzLater()">稍后再说</button>' +
      '<p class="tiny" style="text-align:center;margin-top:10px;">不确定时请先咨询医生或药师。</p>'
    );
  }

  function tzChoose(policy) {
    var change = pendingTz;
    if (!change) { closeSheet(); return; }
    var res = Store.applyTimezonePolicy(policy, change);
    RE.reschedule();   // 处方时间点被平移，唤醒时刻要跟着走
    pendingTz = null;
    closeSheet();
    scheduleSync();
    render();
    toast(policy === S.TZ_POLICY.KEEP_RHYTHM
      ? '已按原服药间隔调整（' + change.from + ' → ' + change.to + '）'
      : '已切换为按当地钟点服药（' + change.from + ' → ' + change.to + '）');
  }

  function tzLater() {
    // 不写入 timezone，因此下次打开会再次询问——不能替用户做这个决定
    closeSheet();
    toast('已保留原有设置，下次打开时会再次提醒你确认');
  }

  // 开关：补上 role / aria-checked 与键盘可达性（快捷键处理见 initA11y）。
  // 视觉尺寸不变，点击热区由 CSS 的 ::before 撑到 64×44。
  function sw(on, action, label) {
    return '<div class="switch' + (on ? ' on' : '') + '" role="switch" tabindex="0"' +
      ' aria-checked="' + (on ? 'true' : 'false') + '"' +
      ' aria-label="' + h(label || '开关') + '"' +
      ' onclick="' + action + '"></div>';
  }

  function renderMe() {
    var u = Store.state.user;
    var perm = (permState === 'unknown') ? RE.notificationState() : permState;
    var permText = { granted: '已开启', denied: '已拒绝', prompt: '未授权', default: '未授权', unsupported: '当前环境不支持' }[perm] || '未授权';
    var platform = PF.get();

    /* 这里原本把 `Store.state.caregivers` 逐条渲染成「已绑定」的绿色徽标。
     * 那是**本地**列表，而绑定发生在另一台设备上——本机不知道有谁绑了。
     * 种子里那条写死的演示家属于是变成了一枚冒充绑定的徽标，与同一张卡片上
     * 的"未配置、完全不联网"自相矛盾。真绑定数由 relayCardBody() 如实给出
     * （来源是中继回报的计数），因此这里不再渲染任何本地"家属"行。 */

    return '<div class="pad">' +
      '<div class="card"><div class="card-title">显示与无障碍</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">长者模式</div>' +
          '<div class="tiny">超大字号、高对比度、更大点击区</div></div>' + sw(u.elderMode, 'App.toggleElder()', '长者模式') + '</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">隐藏药品名称</div>' +
          '<div class="tiny">通知中不显示药名与剂量，保护隐私</div></div>' + sw(u.hideDrugName, 'App.togglePrivacy()', '隐藏药品名称') + '</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">语音播报</div>' +
          '<div class="tiny">朗读提醒内容</div></div>' + sw(u.voiceEnabled, 'App.toggleUser(\'voiceEnabled\')', '语音播报') + '</div>' +
      '</div>' +

      '<div class="card"><div class="card-title"><span>提醒方式</span>' +
        '<span class="more" style="color:' + (perm === 'granted' ? 'var(--ok)' : 'var(--danger)') + ';cursor:default;">系统通知：' + permText + '</span></div>' +
        (perm !== 'granted'
          ? '<div class="note" style="background:var(--danger-soft);color:#8f1d1d;margin-bottom:12px;">通知权限未开启，<b>用药提醒将无法正常工作</b>。请点击下方按钮授权。</div>'
          : '') +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">系统通知</div></div>' + sw(u.channels.notification, 'App.toggleChannel(\'notification\')', '系统通知') + '</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">提示音与震动</div></div>' + sw(u.channels.sound, 'App.toggleChannel(\'sound\')', '提示音与震动') + '</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">全屏强提醒（+15 分钟）</div><div class="tiny">未确认时全屏弹出并持续响铃</div></div>' + sw(u.channels.fullscreen, 'App.toggleChannel(\'fullscreen\')', '全屏强提醒') + '</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">通知家属（+30 分钟）</div></div>' + sw(u.channels.caregiver, 'App.toggleChannel(\'caregiver\')', '通知家属') + '</div>' +
        (perm !== 'granted' ? '<button class="btn block" style="margin-top:12px" onclick="App.askPermission()">授权通知权限</button>' : '') +
      '</div>' +

      '<div class="card"><div class="card-title"><span>提醒可靠性</span>' +
        '<span class="more" id="syncHeadline" style="cursor:default;">' + h(syncHeadline()) + '</span></div>' +
        '<div id="syncBody">' + reliabilityHtml() + '</div>' +
      '</div>' +

      '<div class="card"><div class="card-title">提醒规则</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">漏服判定窗口</div>' +
          '<div class="tiny">超过该时长未确认即标记漏服</div></div>' +
          '<select aria-label="漏服判定窗口" onchange="App.setWindow(this.value)" style="width:auto;padding:7px 9px;font-size:.82em;border:1px solid var(--line);border-radius:8px;">' +
          [30, 60, 90, 120, 180].map(function (v) {
            return '<option value="' + v + '"' + (u.windowMinutes === v ? ' selected' : '') + '>' + (v < 60 ? v + ' 分钟' : (v / 60) + ' 小时') + '</option>';
          }).join('') + '</select></div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">补服安全间隔</div>' +
          '<div class="tiny">距下次服药小于该间隔时建议跳过</div></div>' +
          '<select aria-label="补服安全间隔" onchange="App.setSafetyGap(this.value)" style="width:auto;padding:7px 9px;font-size:.82em;border:1px solid var(--line);border-radius:8px;">' +
          [60, 90, 120, 180, 240].map(function (v) {
            return '<option value="' + v + '"' + (u.safetyGapMinutes === v ? ' selected' : '') + '>' + (v / 60) + ' 小时</option>';
          }).join('') + '</select></div>' +
      '</div>' +

      '<div class="card"><div class="card-title"><span>家属协同</span>' +
        '<span class="more" style="cursor:default;color:' + (relayReady() ? 'var(--ok)' : 'var(--sub)') + ';">' +
        (relayReady() ? '已连接' : '未配置') + '</span></div>' +
        relayCardBody() +
        '<button class="btn block ghost" style="margin-top:12px" onclick="App.relaySetup()">' +
        (relayReady() ? '修改家属服务器' : '配置家属服务器') + '</button>' +
        (relayReady()
          ? '<button class="btn block ghost" style="margin-top:8px" onclick="App.inviteCaregiver()">邀请家属绑定</button>'
          : '') +
        '<p class="tiny" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);line-height:1.75;">' +
        '照护者不可修改药物剂量与处方，仅可查看与提醒。服药记录<b>不出本机</b>——'
        + '只有在「该通知家属」那一刻，才会把一条不含药名的事件交给你自己部署的中继。</p></div>' +

      '<div class="card"><div class="card-title">演示与数据</div>' +
        '<div class="list-row" style="cursor:default"><div class="col"><div style="font-size:.88em;font-weight:600;">演示加速</div>' +
          '<div class="tiny">把 5/15/30 分钟的升级间隔压缩到几秒，用于验证 L1→L5 全链路</div></div>' +
          sw(u.demoFast, 'App.toggleDemoFast()', '演示加速') + '</div>' +
        '<button class="btn block ghost" style="margin-top:10px" onclick="App.demoTrigger()">立即触发一次提醒（演示）</button>' +
        '<button class="btn block ghost" style="margin-top:8px" onclick="App.exportData()">导出全部数据（JSON）</button>' +
        '<button class="btn block ghost" style="margin-top:8px" onclick="App.resetData()">重置为演示数据</button>' +
      '</div>' +

      '<div class="card"><div class="card-title">关于</div>' +
        // 这两行原本带 › 箭头和手型光标，却没有任何点击处理——看着能进、点了没反应。
        // 现在补成真的可打开弹层，并同时补齐隐私政策正文（合规要求）。
        '<button type="button" class="list-row" onclick="App.showDisclaimer()"><span class="col" style="font-size:.88em;">免责声明</span><span class="chev" aria-hidden="true">›</span></button>' +
        '<button type="button" class="list-row" onclick="App.showPrivacy()"><span class="col" style="font-size:.88em;">隐私政策</span><span class="chev" aria-hidden="true">›</span></button>' +
        '<p class="tiny" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);line-height:1.75;">' +
        '本应用仅用于提醒与记录用药时间，不提供任何医疗建议，不能替代医生或药师的诊断与处方。请严格遵照医嘱服药。</p>' +
      '</div>' +
    '</div>';
  }

  /* ============================================================
   * 引导页
   * ============================================================ */
  function renderOnboard() {
    var u = Store.state.user;
    var ok = u.consentAccepted;
    return '<div class="onboard">' +
      '<div class="logo"><svg viewBox="0 0 24 24"><path d="M10.5 3.5 3.5 10.5a5 5 0 0 0 7 7l7-7a5 5 0 0 0-7-7Z"/><path d="M7 7l7 7"/></svg></div>' +
      '<h1 style="font-size:1.7em;font-weight:700;letter-spacing:-.5px;">药准时</h1>' +
      '<p style="color:var(--sub);font-size:.88em;margin-top:8px;line-height:1.6;">让该吃的药，一次都不落下。</p>' +
      '<div class="disclaimer"><b style="color:var(--text);display:block;margin-bottom:6px;font-size:1.05em;">免责声明</b>' +
      '本应用仅用于提醒与记录用药时间，不提供任何医疗建议，不能替代医生或药师的诊断与处方。请严格遵照医嘱服药。</div>' +
      '<div class="agree" onclick="App.toggleConsent()">' +
        '<div class="cbx' + (ok ? ' on' : '') + '"><svg viewBox="0 0 24 24"><path d="M5 12.5l5 5L19 7"/></svg></div>' +
        '<span>我已阅读并同意上述免责声明及《隐私政策》。我理解本应用不能替代医嘱。</span></div>' +
      '<button class="btn block lg" style="' + (ok ? '' : 'opacity:.45;pointer-events:none;') + '" onclick="App.finishOnboard()">开始使用</button>' +
      '<p class="tiny" style="text-align:center;margin-top:14px;line-height:1.7;">下一步将申请通知权限，用于准时提醒你服药<br>若拒绝授权，提醒功能将无法工作</p>' +
    '</div>';
  }

  /* ============================================================
   * 总渲染
   * ============================================================ */
  var TITLES = { today: '今天', meds: '我的药箱', edit: '药品设置', plan: '未来 7 天', log: '服药记录', stats: '依从性报告', me: '我的' };

  function render() {
    var u = Store.state.user;
    var phone = $('phone');
    phone.classList.toggle('elder', u.elderMode);

    if (!u.consentAccepted) {
      $('appbar').style.display = 'none';
      $('tabbar').style.display = 'none';
      $('screen').innerHTML = renderOnboard();
      return;
    }

    $('appbar').style.display = 'flex';
    $('tabbar').style.display = 'flex';

    var sub = '';
    if (current === 'today') {
      var n = new Date();
      sub = dateCn(n.toISOString()) + ' ' + dayCn(n);
    } else if (current === 'meds') {
      sub = Store.state.medicines.filter(function (m) { return !m.isArchived; }).length + ' 种药品 · ' +
        Store.state.plans.filter(function (p) { return p.isActive; }).length + ' 条用药计划';
    } else if (current === 'log' || current === 'stats') {
      var nd = new Date();
      sub = nd.getFullYear() + ' 年 ' + (nd.getMonth() + 1) + ' 月';
    } else if (current === 'edit') {
      sub = '设置用药计划与提醒时间';
    } else if (current === 'plan') {
      sub = '共 ' + RE.pendingCount() + ' 条待触发提醒';
    }

    var actions = '';
    if (current === 'today') {
      actions = '<div class="appbar-actions">' +
        '<button type="button" class="icon-btn' + (u.elderMode ? ' on' : '') + '" onclick="App.toggleElder()" aria-pressed="' + (u.elderMode ? 'true' : 'false') + '" aria-label="长者模式" title="长者模式">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v18M5 8v8M19 8v8M8.5 5.5v13M15.5 5.5v13"/></svg></button>' +
        '<button type="button" class="icon-btn' + (u.hideDrugName ? ' on' : '') + '" onclick="App.togglePrivacy()" aria-pressed="' + (u.hideDrugName ? 'true' : 'false') + '" aria-label="隐藏药名" title="隐藏药名">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></div>';
    } else if (current === 'meds') {
      actions = '<div class="appbar-actions"><button type="button" class="icon-btn" onclick="App.newMedicine()" aria-label="添加药品" title="添加药品"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg></button></div>';
    } else if (current === 'edit') {
      actions = '<div class="appbar-actions"><button type="button" class="icon-btn" onclick="App.go(\'meds\')" aria-label="返回药箱" title="返回药箱"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>';
    } else if (current === 'log') {
      actions = '<div class="appbar-actions"><button type="button" class="icon-btn" onclick="App.go(\'stats\')" aria-label="查看依从性报告" title="查看依从性报告"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3v18h18"/><path d="M7 15l3-4 3 3 5-7"/></svg></button></div>';
    }

    $('appbar').innerHTML = '<div><h1>' + TITLES[current] + '</h1>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' + actions;

    var body;
    switch (current) {
      case 'today': body = renderToday(); break;
      case 'meds': body = renderMeds(); break;
      case 'edit': body = renderEdit(); break;
      case 'plan': body = renderPlan(); break;
      case 'log': body = renderLog(); break;
      case 'stats': body = renderStats(); break;
      case 'me': body = renderMe(); break;
      default: body = renderToday();
    }
    $('screen').innerHTML = body;

    var tab = TAB_OF[current] || 'today';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      // 让读屏器知道当前在哪一栏，而不是只能靠颜色判断
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });

    scheduleSync();   // 任何界面刷新后都把系统闹钟与本地状态对齐
  }

  /* ============================================================
   * 交互动作
   * ============================================================ */
  function confirmReminderById(id) {
    var r = Store.findReminderById(id);
    if (!r) return;
    if (r.status !== 'pending') return;
    var log = Store.confirmReminder(r, 'in_app');
    cancelWatch(id);   // 已确认：撤销中继计时
    toast('已记录 · ' + (STATUS_TEXT[log.status] || '') + (log.delayMinutes > 30 ? '（延迟 ' + log.delayMinutes + ' 分钟）' : ''));
    RE.reschedule();
    render();
  }

  function openMakeupById(id) {
    var r = Store.findReminderById(id);
    if (r) showMakeup(r);
  }

  /** 按「计划 + 时间点」打卡；已过去的时间点会先询问实际情况 */
  function confirmTimeBySlot(planId, iso) {
    var isPast = new Date(iso).getTime() <= Date.now();

    if (!isPast) {
      var r0 = Store.ensureReminder(planId, iso);
      var log0 = Store.confirmReminder(r0, 'in_app');
      cancelWatch(r0.id);   // 已确认：撤销中继计时
      toast('已记录 · ' + (STATUS_TEXT[log0.status] || '') +
        (log0.delayMinutes < 0 ? '（提前 ' + (-log0.delayMinutes) + ' 分钟）' : ''));
      RE.reschedule();
      render();
      return;
    }

    openSheet(
      '<h3>补录 ' + h(hhmm(iso)) + ' 的服药记录</h3>' +
      '<p>这个时间点已经过去，你当时服药了吗？如实补录可以让复诊报告更准确。</p>' +
      '<div style="display:flex;gap:10px;">' +
      '<button class="btn ghost" style="flex:1" id="bkNo">当时没吃</button>' +
      '<button class="btn" style="flex:1" id="bkYes">当时吃了</button></div>'
    );

    $('bkYes').onclick = function () {
      var r = Store.ensureReminder(planId, iso);
      var log = Store.confirmReminder(r, 'manual', new Date(iso));
      log.note = '手动补录';
      Store.save();
      cancelWatch(r.id);   // 已补录：撤销中继计时
      closeSheet();
      toast('已补录为已服药');
      render();
    };
    $('bkNo').onclick = function () {
      var r = Store.ensureReminder(planId, iso);
      Store.markMissed(r);
      cancelWatch(r.id);   // 已按漏服结算：撤销中继计时
      RE.reschedule();
      closeSheet();
      showMakeup(r);
      render();
    };
  }

  function missFlowInfo() {
    openSheet(
      '<h3>漏服了怎么办？</h3>' +
      '<p>应用会在超过服药窗口（当前 ' + (Store.state.user.windowMinutes / 60) + ' 小时）后自动标记漏服，并询问你是否补服。</p>' +
      '<p style="margin-bottom:10px;">判断依据是<b style="color:var(--text)">距下次服药的时间</b>：</p>' +
      '<div style="font-size:.82em;line-height:1.95;color:var(--sub);margin-bottom:16px;">' +
      '· 距下次服药<b style="color:var(--text)">大于安全间隔</b>：可选择补服或跳过<br>' +
      '· 距下次服药<b style="color:var(--text)">已接近</b>：建议跳过本次，避免叠加</div>' +
      '<div class="note">补服记录会独立保存，不会覆盖原来的漏服记录，方便复诊时给医生查看完整服药情况。本应用不提供任何医疗建议，请遵医嘱。</div>' +
      '<button class="btn block" onclick="App.closeSheet()">知道了</button>'
    );
  }

  function askPermission() {
    RE.requestPermission().then(function (res) {
      render();
      if (res === 'granted') toast('通知权限已开启');
      else if (res === 'denied') toast('权限被拒绝：提醒将无法工作');
      else toast('未获得授权');
    });
  }

  function finishOnboard() {
    if (!Store.state.user.consentAccepted) return;
    Store.updateUser({ consentAccepted: true });
    RE.requestPermission().then(function () {
      render();
      toast('已开始使用，可前往「用药」添加你的药品');
    });
  }

  function toggleConsent() {
    Store.updateUser({ consentAccepted: !Store.state.user.consentAccepted });
    render();
  }

  function toggleElder() {
    var v = !Store.state.user.elderMode;
    Store.updateUser({ elderMode: v });
    render();
    toast(v ? '长者模式已开启：字号放大、对比度增强、点击区加大' : '长者模式已关闭');
  }

  function togglePrivacy() {
    var v = !Store.state.user.hideDrugName;
    Store.updateUser({ hideDrugName: v });
    render();
    toast(v ? '隐藏药名已开启：通知中不会出现药品信息' : '隐藏药名已关闭');
  }

  function toggleUser(key) {
    var o = {}; o[key] = !Store.state.user[key];
    Store.updateUser(o);
    render();
  }

  function toggleChannel(key) {
    var next = !Store.state.user.channels[key];
    var ch = Store.state.user.channels;

    // BR-08：把所有提醒渠道都关掉，等于关掉整个应用的核心能力。
    // 这一步必须有独立二次确认，并明确告知「只剩记录功能」。
    if (!next && !['notification', 'sound', 'fullscreen', 'caregiver'].some(function (k) {
      return k === key ? next : ch[k];
    })) {
      confirmDanger(
        '关闭全部提醒？',
        '这是最后一个开启的提醒渠道。关闭后<b>不会再有任何服药提醒</b>，应用只剩记录与统计功能。<br>如果你只是想少受打扰，建议保留「系统通知」而关掉声音或全屏。',
        '仍要全部关闭',
        function () { applyChannel(key, next); }
      );
      return;
    }
    applyChannel(key, next);
  }

  function applyChannel(key, value) {
    var c = {}; c[key] = value;
    Store.updateUser({ channels: c });
    render();
    if (key === 'notification' && value && RE.notificationState() !== 'granted') {
      askPermission();
    }
  }

  function toggleDemoFast() {
    var v = !Store.state.user.demoFast;
    Store.updateUser({ demoFast: v });
    RE.reschedule();   // 加速倍率直接改变升级链的时间点，必须重排
    render();
    toast(v
      // 必须把这个说在开启那一刻：「演示触发」的 L1 在 3 秒后就响完了，
      // 系统里随即没有任何近期闹钟（其余提醒的 L1 都锚定真实每日时刻）——
      // 否则用户会拿演示模式去测后台/熄屏送达，得出"家属协同弄坏了提醒"的错误结论
      // （2026-10-12 真机排障实录：用户据此误判为"连接家属协同后熄屏不响"）。
      ? '演示加速已开启：5/15/30 分钟 → 约 6/18/36 秒。注意：验证后台/熄屏送达时请先关闭本开关，用真实时刻的新提醒测试'
      : '演示加速已关闭');
  }

  function setWindow(v) { Store.updateUser({ windowMinutes: Number(v) }); RE.reschedule(); render(); toast('漏服判定窗口已更新'); }
  function setSafetyGap(v) { Store.updateUser({ safetyGapMinutes: Number(v) }); render(); toast('补服安全间隔已更新'); }

  /* ============================================================
   * 家属协同（真实投递）
   *
   * 旧版本这里只有一句写死的邀请码 MEDI-8F3K，和一句"已通知 N 位家属"的 toast ——
   * 后者什么都没发出去。现在改成：码由本地生成、登记到用户自建的中继，
   * 投递结果如实回显（未配置就说未配置，没送到就说没送到）。
   * ============================================================ */

  function relayReady() { return typeof Relay !== 'undefined' && Relay.isConfigured(); }

  function relayCardBody() {
    if (typeof Relay === 'undefined') {
      return '<p class="tiny">当前构建未包含家属协同模块。</p>';
    }
    var rs = Relay.status();
    if (!rs.configured) {
      return '<p class="tiny" style="line-height:1.85;">尚未配置中继服务器。不配置时应用<b>完全不联网</b>，'
        + '家属协同不可用（本地通知无法送到另一台设备）。</p>';
    }
    var ld = rs.lastDelivery;
    var line;
    if (!ld) line = '暂无漏服事件';
    else if (ld.error) line = '<span style="color:var(--danger)">上次投递失败：' + h(ld.error) + '</span>';
    else if (ld.delivered > 0) line = '上次投递：已送达 ' + ld.delivered + ' 位家属';
    else line = '<span style="color:var(--danger)">上次投递：未送达任何家属</span>';

    // 中继计时待办：排程变化时把每剂的「该通知家属」时刻交给了中继，
    // 手机熄屏后也能由中继推送。wsync.watched 是中继回执的真实条数
    var wsync = rs.lastWatchSync;
    var wline;
    if (!wsync) wline = '计时待办：待首次同步';
    else if (wsync.error) wline = '<span style="color:var(--danger)">计时待办同步失败：' + h(wsync.error) + '</span>';
    else wline = '计时待办：中继托管 <b>' + wsync.watched + '</b> 条（熄屏时也由中继推送）';

    return '<div class="tiny" style="line-height:1.9;background:var(--bg);border-radius:10px;padding:10px 12px;">'
      + '服务器：' + h(rs.url) + '<br>'
      + '邀请码：<b>' + h(rs.code) + '</b><br>'
      + '中继侧已绑定家属：<b>' + rs.boundCount + '</b> 位<br>'
      + wline + '<br>'
      + line + '</div>';
  }

  function relaySetup() {
    var rs = (typeof Relay !== 'undefined') ? Relay.status() : { url: '' };
    openSheet(
      '<h3>家属服务器</h3>' +
      '<p>家属在另一台设备上，本地通知走不出这台机器，所以「家属收到漏服提醒」需要一个中转点。</p>' +
      '<p class="tiny" style="line-height:1.85;">这里可以填<b>你自己部署</b>的中继（项目 <code>server/</code> 目录，零依赖，一条命令即起）。'
      + '连接后，应用会把每剂「该通知家属」的时刻交给中继计时（只有内部编号与时刻，<b>不带药名与剂量</b>），'
      + '到点仍未确认时由中继推送家属——这样即使你的手机熄屏或没电，家属也能收到。'
      + '此外只会在「该通知家属」那一刻发送一条事件。清空即断开，断开后一个请求都不会发。</p>' +
      '<div class="field"><input id="relayUrl" value="' + h(rs.url || '') + '" placeholder="http://192.168.1.10:8789"></div>' +
      '<button class="btn block" style="margin-top:12px" onclick="App.relayConnect()">连接并登记邀请码</button>' +
      (rs.configured
        ? '<button class="btn block ghost" style="margin-top:8px" onclick="App.relayDisconnect()">断开并清除配置</button>'
        : '') +
      '<p class="tiny" style="margin-top:14px;">提示：家用局域网地址（如 192.168.x.x）只在同一 Wi-Fi 下可用；'
      + '要跨网络送达，需要把它部署到有公网地址、且启用 HTTPS 的服务器上。</p>'
    );
  }

  function relayConnect() {
    var el = $('relayUrl');
    var url = el ? String(el.value || '').trim() : '';
    if (!url) { toast('请先填写服务器地址'); return; }
    toast('正在连接…');
    Relay.pair(url).then(function (r) {
      render();
      openSheet(
        '<h3>连接成功</h3>' +
        '<p>把下面这一整段发给家人，对方打开 <b>caregiver.html</b> 填进去即可绑定。</p>' +
        '<div style="background:var(--bg);border:1px dashed var(--line);border-radius:10px;padding:14px;font-size:.86em;line-height:1.9;word-break:break-all;margin-bottom:14px;">'
        + h(inviteText(r.code)) + '</div>' +
        '<button class="btn block" onclick="App.copyInvite()">复制邀请信息</button>' +
        '<button class="btn block ghost" style="margin-top:8px" onclick="App.closeSheet()">稍后再说</button>'
      );
    }).catch(function (e) {
      openSheet(
        '<h3>连接失败</h3>' +
        '<p style="color:var(--danger)">' + h(e.message || '未知错误') + '</p>' +
        '<p class="tiny">常见原因：地址写错、服务器没启动、手机和电脑不在同一网络、被防火墙拦下。'
        + '请确认服务器那台机器上能看到 <code>http://地址:端口/api/health</code> 返回 JSON。</p>' +
        '<button class="btn block" onclick="App.closeSheet()">返回修改</button>'
      );
    });
  }

  function relayDisconnect() {
    Relay.unpair();
    render();
    toast('已断开家属服务器：此后不会再有任何数据离开本机');
  }

  function caregiverPageUrl() {
    var href = (global.location && global.location.href) || '';
    return href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'caregiver.html';
  }

  function inviteText(code) {
    var rs = Relay.status();
    return '【药准时 · 家属协同】\n' +
      '1. 用浏览器打开：' + caregiverPageUrl() + '\n' +
      '2. 服务器地址填：' + (rs.url || Relay.baseUrl()) + '\n' +
      '3. 邀请码填：' + (code || rs.code) + '\n' +
      '绑定后，我漏服时你会收到提醒。你只能查看与提醒，不能修改我的处方。';
  }

  function copyInvite() {
    var text = inviteText();
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('邀请信息已复制，发给家人即可');
      }).catch(function () {
        toast('复制失败：请手动选中上面那段文字');
      });
      return;
    }
    toast('当前环境不支持自动复制：请手动选中上面那段文字');
  }

  function inviteCaregiver() {
    if (!relayReady()) { relaySetup(); return; }
    var rs = Relay.status();
    openSheet(
      '<h3>邀请家属绑定</h3>' +
      '<p>把下面的信息发给家人，对方打开 <b>caregiver.html</b> 填进去即可绑定。'
      + '绑定后，你漏服时对方会收到提醒；对方<b>不能</b>修改你的剂量与处方。</p>' +
      '<div style="background:var(--bg);border:1px dashed var(--line);border-radius:10px;padding:16px;text-align:center;margin-bottom:14px;">' +
      '<div class="tiny" style="margin-bottom:6px;">邀请码</div>' +
      '<div style="font-size:1.4em;font-weight:700;letter-spacing:3px;">' + h(rs.code) + '</div></div>' +
      '<div class="tiny" style="line-height:1.9;">服务器：' + h(rs.url) + '<br>绑定页面：' + h(caregiverPageUrl()) + '</div>' +
      '<button class="btn block" style="margin-top:14px" onclick="App.copyInvite()">复制邀请信息</button>' +
      '<button class="btn block ghost" style="margin-top:8px" onclick="App.relayRotate()">换一个邀请码</button>'
    );
  }

  /** 轮换邀请码：旧码作废，但已绑定的家属会被迁移，不会静默失联 */
  function relayRotate() {
    var code = Relay.newCode();
    Relay.pair(Relay.baseUrl(), code).then(function () {
      render();
      toast('已生成新邀请码：' + code + '（已绑定的家属不受影响）');
      inviteCaregiver();
    }).catch(function (e) {
      toast('更换失败：' + (e.message || '未知错误'));
    });
  }

  function exportData() {
    var data = Store.exportJson();
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '药准时-数据备份-' + S.dateKey(new Date()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出数据备份');
  }

  function exportReport() {
    var from = new Date(); from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0);
    var sum = S.summarize(Store.state.logs, from, new Date());
    var total = sum.onTime + sum.delayed + sum.missed;
    var lines = [];
    lines.push('用药依从性报告');
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('统计区间：近 30 天');
    lines.push('');
    lines.push('应服药记录：' + total + ' 次');
    lines.push('按时：' + sum.onTime + ' 次（' + sum.onTimeRate + '%）');
    lines.push('延迟：' + sum.delayed + ' 次');
    lines.push('漏服：' + sum.missed + ' 次');
    lines.push('补服：' + sum.makeup + ' 次');
    lines.push('');
    lines.push('各时段按时率：');
    Object.keys(sum.byHour).sort().forEach(function (k) {
      lines.push('  ' + k + '  ' + sum.byHour[k].rate + '%（共 ' + sum.byHour[k].total + ' 次）');
    });
    lines.push('');
    lines.push('单药依从率：');
    Object.keys(sum.byMedicine).forEach(function (k) {
      var med = Store.getMedicine(k);
      lines.push('  ' + (med ? med.name : '未知') + '  ' + sum.byMedicine[k].rate + '%');
    });
    lines.push('');
    lines.push('—— 本报告由「药准时」生成，仅记录服药时间，不代表任何医学结论，请遵医嘱。');

    var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '服药依从性报告-' + S.dateKey(new Date()) + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('复诊报告已导出');
  }

  function resetData() {
    confirmDialog('重置为演示数据？', '当前所有药品、计划与服药记录都会被清除，并恢复为初始演示数据。此操作不可撤销。', '确认重置', function () {
      Store.resetToSeed();
      Store.regenerateReminders();
      RE.start();
      editState = null;
      current = 'today';
      render();
      toast('已重置为演示数据');
    });
  }

  /** 演示：把最近一条待触发提醒改到 3 秒后触发 */
  function demoTrigger() {
    Store.regenerateReminders();
    var list = Store.state.reminders
      .filter(function (r) { return r.status === 'pending'; })
      .sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });
    if (!list.length) { toast('没有待触发的提醒，请先添加药品'); return; }
    var r = list[0];
    r.scheduledAt = new Date(Date.now() + 3000).toISOString();
    r.level = 0;
    Store.save();
    RE.reschedule();   // 刚把某条改到 3 秒后，必须立刻重排，不能等兜底上限
    if (current === 'me') go('today');
    render();
    toast('已安排：3 秒后触发该药品的提醒（可先开启演示加速看完整升级链路）');
  }

  /* ============================================================
   * 交给中继的家属事件
   * ============================================================ */

  /**
   * 构造"要送出这台设备"的那一条事件 —— **白名单构造器**。
   *
   * 药名与剂量在这里**结构上不可能出现**：不是"记得把它剥掉"，
   * 而是这个函数从来不去读 `describe()` / `getMedicine()` 的结果，
   * 字段一个一个写出来。以后就算 reminder 对象或 describe() 里多出几个字段，
   * 也不会顺带被送出去。
   *
   * **为什么不能挂在「隐藏药名」开关上**（P9-36 的根因）：
   *   那个开关管的是**本机屏幕**——防止旁人从手机通知栏/界面上看到药名，默认**关闭**；
   *   而这里管的是**数据离开这台设备**。两件事的威胁模型完全不同，不能共用一个开关。
   *   共用的结果是：默认状态下药名被发到中继并送达家属，
   *   而隐私政策（`showPrivacy`）、家属协同弹层（`relaySetup`）、
   *   家属端页面（`caregiver.html`）三处都写着"事件不含药名"。
   *   界面说了四遍、代码没做，这是最贵的一类缺陷：它不报错、不崩溃、只是悄悄不成立。
   *
   * 家属该知道的（"某剂提醒到现在还没确认" + 计划时刻）都在这里；
   * 不该知道的（吃的是什么、吃多少）一个字节都不发。
   */
  function caregiverEvent(reminder) {
    return {
      type: 'missed',
      level: 4,
      // 内部随机 id，不是药名。带上它，中继收到这条实时上报时
      // 能撤销自己计时名单里的同一条，避免家属收到重复通知。
      reminderId: reminder.id,
      scheduledAt: reminder.scheduledAt,
      text: '有一条用药提醒未确认'
    };
  }

  /* ============================================================
   * 「通知家属」的中继计时（L4 可靠性的关键一环）
   *
   * 升级链 L4 原先只由页面里的 JS 定时器驱动：手机熄屏/进程被冻结后
   * 定时器不再运行，而「患者已经没反应了」恰恰是最可能熄屏的时刻。
   * 所以在排程变化时，把每剂的 L4 时刻**预先**交给中继——中继一直活着，
   * 到点仍未收到撤销就推送家属。失败方向是安全的：患者手机死机时
   * 家属照样收到，这正是期望行为。
   * ============================================================ */

  /**
   * 构造要交给中继计时的待办清单。全量对账：每次排程变化都重新生成整张表，
   * 中继以本次上报为准——删药、改时间、关通道都会自动跟上。
   * 时刻直接取 RE.computeEscalation() 算出的 L4（不在这里重算升级链，
   * 避免两份逻辑漂移；演示加速下的压缩间隔也天然一致）。
   * 患者关闭「通知家属」通道时返回空表：中继侧旧待办随之清空。
   */
  function caregiverWatchItems() {
    if (!Store.state.user.channels.caregiver) return [];
    var items = [];
    Store.state.reminders.forEach(function (r) {
      if (r.status !== 'pending') return;
      var esc = RE.computeEscalation(r);
      for (var i = 0; i < esc.length; i++) {
        if (esc[i].level === 4) {
          items.push({
            reminderId: r.id,             // 内部随机 id，不是药名
            scheduledAt: r.scheduledAt,
            notifyAt: esc[i].at
          });
          break;
        }
      }
    });
    return items;
  }

  /** 排程变化后把待办同步给中继。未配置中继时一个请求都不发（默认不联网）。 */
  function syncCaregiverWatches() {
    if (!relayReady()) return Promise.resolve(null);
    return Relay.scheduleWatches(caregiverWatchItems());
  }

  /** 某剂已确认/跳过/补录/漏服结算：撤销中继侧计时，家属不再被打扰 */
  function cancelWatch(reminderId) {
    if (!relayReady() || !reminderId) return Promise.resolve(null);
    return Relay.cancelWatches([reminderId]);
  }

  /* ============================================================
   * 提醒引擎回调
   * ============================================================ */
  function bindEngine() {
    RE.setCallbacks({
      onFullscreen: function (reminder, desc) { showFullscreen(reminder, desc); },
      onMissed: function (reminder) {
        cancelWatch(reminder && reminder.id);   // 已按漏服结算：撤销中继计时
        showMakeup(reminder);
        render();
      },
      onCaregiverAlert: function (reminder) {
        // 先构造"要送出去的东西"。它只能来自 caregiverEvent() 这个白名单，
        // 不能在这里现拼字段——否则下一个加字段的人眼里就看不见"药名不许出门"这条红线。
        var ev = caregiverEvent(reminder);

        if (!relayReady()) {
          // 旧版本在这里说"已通知 N 位家属"，其实一个请求都没发。
          // 现在照实说：没配置就是没通知。
          toast('该通知家属了，但**尚未配置家属服务器**——本次未通知任何人（『我的 → 家属协同』可配置）');
          return;
        }

        Relay.report(ev).then(function (r) {
          if (r.ok && r.delivered > 0) {
            toast('已送达 ' + r.delivered + ' 位家属：' + ev.text);
          } else if (r.ok) {
            toast('家属服务器已收到，但**没有在线家属签收**（已绑定 ' + r.caregivers + ' 位）');
          } else if (r.reason === 'unconfigured') {
            toast('尚未配置家属服务器，本次未通知任何人');
          } else {
            toast('通知家属失败：' + (r.message || '网络错误') + '（可在『我的 → 家属协同』查看）');
          }
          if (current === 'me') render();
        });
      },
      onLevel: function (reminder, step) {
        if (current === 'today' || current === 'me') render();
      },
      onOpen: function (reminder) { go('today'); }
    });
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    Store.load();
    initA11y();   // 键盘可达性：Esc 关弹层、开关的 Enter/空格

    // 调试 / 演示便利：?auto=1 跳过引导页，?page=xxx 直接进入指定页面
    var qs = (global.location && global.location.search) || '';
    if (/[?&]auto=1/.test(qs) && !Store.state.user.consentAccepted) {
      Store.updateUser({ consentAccepted: true });
    }
    var pm = qs.match(/[?&]page=([a-z]+)/);
    if (pm) current = pm[1];

    // 探测运行环境（浏览器 / 原生容器），决定提醒怎么投递
    PF.resolve();
    permState = RE.notificationState();

    Store.regenerateReminders();
    Store.reconcileMissed();   // 结算应用未运行期间错过的服药时间点
    bindEngine();
    render();
    RE.start();

    // 点击系统通知后回到对应提醒
    PF.get().onNotificationTap(function (extra) {
      var r = extra && extra.reminderId ? Store.findReminderById(extra.reminderId) : null;
      go('today');
      toast(r ? '来自提醒通知' : '来自提醒通知，请查看今日用药');
    });

    refreshPermission();
    doSync();   // 立即把提醒交给系统，而不是等第一次界面操作

    var sbTz = $('sbTz');
    if (sbTz) sbTz.textContent = S.currentTimezone();

    // 回到前台时立即结算一次并重排唤醒时刻（自适应轮询下这一步很重要：
    // 后台期间浏览器会节流定时器，回来时用 reschedule 立刻对齐真实时间）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        // 两件事，缺一不可：
        //  - reschedule()：让**页面内**引擎立即结算后台期间错过的时间；
        //  - scheduleSync()：让**系统闹钟**重新对齐。
        //    系统会在后台按省电策略清掉闹钟（重启、权限变更、长时间闲置、
        //    国产 ROM 的深度管控），而页面内引擎看不到这件事——
        //    回到前台是唯一能自愈的时机。只 reschedule 不重挂系统闹钟，
        //    会出现"界面上一切正常、到点什么都不响"的沉默失败。
        RE.reschedule();
        scheduleSync();
        render();
      }
    });
    window.addEventListener('focus', function () { RE.reschedule(); });

    // 时区变化检测（BR-05）：必须用户明确二选一，不得静默改写处方
    // ?simTz=UTC-11 可模拟"从该时区切换过来"，用于演示与走查这条流程
    var sim = qs.match(/[?&]simTz=(UTC[+-]?\d{1,2}(?::?\d{2})?)/);
    var tz = S.detectTimezoneChange(sim ? sim[1] : Store.state.user.timezone);
    if (tz.changed && Store.state.user.consentAccepted) {
      setTimeout(function () { showTzPrompt(tz); }, 600);
    }
  }

  /* ============================================================
   * 免责声明与隐私政策
   * ============================================================ */
  function showDisclaimer() {
    openSheet(
      '<h3>免责声明</h3>' +
      '<p>本应用仅用于<b>提醒与记录用药时间</b>，不提供任何医疗建议，不能替代医生或药师的诊断与处方。请严格遵照医嘱服药。</p>' +
      '<p>本应用不会判断你是否应该调整剂量、停药或换药。任何用药调整请先咨询医生或药师。</p>' +
      '<p>提醒依赖系统通知与闹钟，可能因权限被关闭、系统省电策略、设备关机等原因延迟或失败。因此<b>不要把本应用当作唯一的用药保障</b>。</p>' +
      '<button class="btn block" onclick="App.closeSheet()">我知道了</button>'
    );
  }

  function showPrivacy() {
    var rs = relayReady() ? Relay.status() : null;
    openSheet(
      '<h3>隐私政策</h3>' +
      '<p><b>默认状态：我们没有服务器。</b>药品名称、剂量、服药记录与家属信息全部只保存在你这台设备上，'
      + '不会上传，也不用于任何分析或广告。</p>' +
      '<p><b>唯一的例外，是你自己开启的「家属协同」。</b>家属在另一台设备上，本地通知走不出这台机器，'
      + '所以跨设备送达必然经过一个中转点。我们把它做成了<b>由你自己部署</b>的中继，而不是某个云服务：</p>' +
      '<div class="tiny" style="background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;line-height:1.9;margin-bottom:14px;">'
      + '· 不配置 = <b>一个请求都不发</b>，与"没有家属协同"完全一致<br>'
      + '· 配置后，会把每剂「该通知家属」的<b>计划时刻</b>（内部编号 + 时刻）同步给你填的中继，由它计时；到点未确认时由中继推送家属——你的手机熄屏、没电时家属也能收到<br>'
      + '· 该事件与该时刻<b>不含药名、不含剂量、不含任何服药记录</b><br>'
      + '· 只发往你填的那个地址；随时可断开，断开后立即停止</div>' +
      (rs
        ? '<p class="tiny" style="color:var(--ok);">当前状态：<b>已连接</b> ' + h(rs.url) + '（邀请码 ' + h(rs.code) + '）。断开见「我的 → 家属协同」。</p>'
        : '<p class="tiny" style="color:var(--ok);">当前状态：<b>未连接任何服务器</b>。</p>') +
      '<p>应用申请的权限与用途：</p>' +
      '<div class="tiny" style="background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;line-height:1.9;margin-bottom:14px;">' +
      '· 通知 —— 到点提醒服药（拒绝后提醒不可用）<br>' +
      '· 精确闹钟 —— 保证提醒准点，不被系统延后<br>' +
      '· 震动 —— 未确认时加强提醒<br>' +
      '· 开机自启 —— 手机重启后重新登记提醒</div>' +
      '<p><b>你可以随时收回数据：</b>在「我的 → 演示与数据」中导出全部数据（JSON），或重置以清除全部本地数据。卸载应用即彻底删除。</p>' +
      '<p class="tiny" style="line-height:1.85;">自建中继的部署者<b>能看到</b>「某邀请码在哪些时刻有提醒、其中哪些未确认」，'
      + '因此请不要把邀请码与地址公开；生产部署必须启用 HTTPS。'
      + '（中继源代码只有一份 400 余行的实现，在项目 <code>server/</code> 目录，可自行审阅。）</p>' +
      '<p><b>儿童：</b>本应用面向成人及照护者，不面向儿童收集任何信息。</p>' +
      '<p class="tiny">本政策随版本更新。最后更新：2026-10-12。医疗合规文案建议正式发布前由专业人员复核。</p>' +
      '<button class="btn block" onclick="App.closeSheet()">我知道了</button>'
    );
  }

  global.App = {
    go: go, render: render, closeSheet: closeSheet, toast: toast,
    confirm: confirmReminderById, openMakeup: openMakeupById, confirmTime: confirmTimeBySlot,
    missFlowInfo: missFlowInfo, askPermission: askPermission,
    finishOnboard: finishOnboard, toggleConsent: toggleConsent,
    toggleElder: toggleElder, togglePrivacy: togglePrivacy, toggleUser: toggleUser,
    toggleChannel: toggleChannel, toggleDemoFast: toggleDemoFast,
    setWindow: setWindow, setSafetyGap: setSafetyGap,
    inviteCaregiver: inviteCaregiver, exportData: exportData,
    // 家属协同（真实投递）
    relaySetup: relaySetup, relayConnect: relayConnect, relayDisconnect: relayDisconnect,
    relayRotate: relayRotate, copyInvite: copyInvite,
    exportReport: exportReport, resetData: resetData, demoTrigger: demoTrigger,
    newMedicine: newMedicine, editMedicine: editMedicine,
    setField: setField, setTime: setTime, addTime: addTime, removeTime: removeTime,
    setLongTerm: setLongTerm, saveMedicine: saveMedicine, archiveCurrent: archiveCurrent,
    fsConfirm: fsConfirm, fsSnooze: fsSnooze,
    // P2：系统级闹钟与可靠性
    resync: resync, showDiag: showDiag, openExactAlarm: openExactAlarm,
    // P2：时区策略
    tzChoose: tzChoose, tzLater: tzLater,
    // P3：合规内容（原来那两行只有箭头没有处理函数）
    showDisclaimer: showDisclaimer, showPrivacy: showPrivacy
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
