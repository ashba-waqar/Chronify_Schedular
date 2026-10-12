/* ============================================================
   StudyFlow — app.js
   Full application logic: data layer, views, calendar,
   Pomodoro timer, smart scheduling, recurring tasks
   ============================================================ */

'use strict';

// ── Utilities ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const genId = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
}
function deadlineRelative(iso) {
  if (!iso) return null;
  const diff = Math.ceil((new Date(iso + 'T00:00:00') - new Date()) / 86400000);
  if (diff < 0) return { label: `Overdue ${Math.abs(diff)}d`, cls: 'overdue' };
  if (diff === 0) return { label: 'Due today', cls: 'soon' };
  if (diff <= 3) return { label: `Due in ${diff}d`, cls: 'soon' };
  return { label: `Due ${formatDate(iso)}`, cls: '' };
}
const CAT_ICON = {
  study: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  work: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 1-2-2h-4a2 2 0 0 1-2 2v16"/></svg>`,
  personal: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  health: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`
};
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function renderEmptyState(icon, title, desc) {
  return `
    <div class="empty-state">
      <img src="assets/empty_state_3d.png" class="empty-3d-img" alt="3D illustration" onerror="this.style.display='none';this.nextElementSibling.style.display='block';" />
      <div class="empty-icon" style="display:none;">${icon || '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'}</div>
      <div class="empty-title">${escHtml(title)}</div>
      <div class="empty-desc">${escHtml(desc)}</div>
    </div>
  `;
}

function getSmoothPathD(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const mx = (p0.x + p1.x) / 2;
    d += ` C ${mx},${p0.y} ${mx},${p1.y} ${p1.x},${p1.y}`;
  }
  return d;
}

// ── Data Layer ────────────────────────────────────────────────
const DB = {
  load(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; }
    catch { return def; }
  },
  save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }
};

let tasks = DB.load('sf_tasks', []);
let pomodoroSettings = DB.load('sf_pomodoro', {
  workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLong: 4
});
let appStats = DB.load('sf_stats', { totalPomodoros: 0, streak: 0, lastActiveDate: '' });
let pendingScheduleSuggestions = [];
let editingTaskId = null;

function saveTasks(updatedTask = null) {
  DB.save('sf_tasks', tasks);
  if (typeof CloudSync !== 'undefined' && CloudSync.isConfigured && CloudSync.currentUser) {
    if (updatedTask) {
      CloudSync.syncTask(updatedTask);
    } else {
      tasks.forEach(t => CloudSync.syncTask(t));
    }
  }
}

function saveSettings() {
  DB.save('sf_pomodoro', pomodoroSettings);
  if (typeof CloudSync !== 'undefined' && CloudSync.isConfigured && CloudSync.currentUser) {
    CloudSync.syncSettings(pomodoroSettings);
  }
}

function saveStats() {
  DB.save('sf_stats', appStats);
  if (typeof CloudSync !== 'undefined' && CloudSync.isConfigured && CloudSync.currentUser) {
    CloudSync.syncStats(appStats);
  }
}

// Auto-generate recurring task instances for today
function generateRecurringInstances() {
  const todayStr = today();
  const todayDow = new Date().getDay();
  const base = tasks.filter(t => t.recurring?.enabled && t.recurring.days.includes(todayDow));

  base.forEach(tmpl => {
    const exists = tasks.some(t =>
      t.recurringParentId === tmpl.id &&
      t.deadline === todayStr
    );
    if (!exists) {
      const inst = {
        ...tmpl,
        id: genId(),
        recurringParentId: tmpl.id,
        deadline: todayStr,
        completed: false,
        completedAt: null,
        recurring: { enabled: false, days: [] },
        createdAt: new Date().toISOString()
      };
      tasks.push(inst);
    }
  });
  saveTasks();
}

// ── Navigation ────────────────────────────────────────────────
let currentView = 'dashboard';

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $(`view-${view}`)?.classList.add('active');
  $(`nav-${view}`)?.classList.add('active');
  currentView = view;

  if (view === 'dashboard') renderDashboard();
  if (view === 'tasks') renderTaskGrid();
  if (view === 'calendar') renderCalendar();
  if (view === 'focus') renderFocusView();
  if (view === 'analytics') renderAnalytics();
  if (view === 'overview') renderCategoryOverview();
  if (view === 'settings') renderSettings();
}

document.querySelectorAll('.nav-item[data-view]').forEach(el => {
  el.addEventListener('click', () => switchView(el.dataset.view));
});

// ── Live Clock ────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('live-clock').textContent = clock;

  const h = now.getHours();
  let greet = h < 5 ? 'Good Night' : h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
  $('greeting-text').textContent = greet;
  $('greeting-date').textContent = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
setInterval(updateClock, 1000);
updateClock();

// ── Dashboard ─────────────────────────────────────────────────
function renderDashboard() {
  const todayStr = today();
  const todayTasks = tasks.filter(t => !t.recurring?.enabled && t.deadline === todayStr);
  const allPending = tasks.filter(t => !t.completed && !t.recurring?.enabled);
  const overdue = allPending.filter(t => t.deadline && t.deadline < todayStr);
  const completed = tasks.filter(t => t.completed).length;
  const todayCompleted = todayTasks.filter(t => t.completed).length;

  $('stat-today').textContent = todayTasks.length;
  $('stat-today-sub').textContent = `${todayCompleted} completed`;
  $('stat-pending').textContent = allPending.length;
  $('stat-overdue-sub').textContent = `${overdue.length} overdue`;
  $('stat-completed').textContent = completed;
  $('stat-pomodoros').textContent = appStats.totalPomodoros;

  $('sidebar-today').textContent = todayTasks.length;
  $('sidebar-streak').textContent = appStats.streak;
  $('sidebar-focus').textContent = appStats.totalPomodoros;

  const pendingBadge = $('pending-badge');
  if (pendingBadge) {
    pendingBadge.textContent = allPending.length;
    pendingBadge.style.display = allPending.length ? '' : 'none';
  }

  const headerBadge = $('header-notify-badge');
  if (headerBadge) {
    headerBadge.style.display = (allPending.length || overdue.length) ? 'block' : 'none';
  }

  // Today progress
  const pct = todayTasks.length ? Math.round((todayCompleted / todayTasks.length) * 100) : 0;
  $('today-progress').style.width = pct + '%';
  $('today-progress-label').textContent = todayTasks.length
    ? `${todayCompleted} of ${todayTasks.length} tasks done (${pct}%)`
    : 'No tasks scheduled for today';

  // Today task list
  const listEl = $('today-task-list');
  if (!todayTasks.length) {
    listEl.innerHTML = renderEmptyState('<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>', 'No tasks today', 'Add a task or check your calendar!');
  } else {
    listEl.innerHTML = todayTasks.map(t => taskItemHTML(t)).join('');
  }

  // Upcoming deadlines (next 7 days, not today)
  const upcomingEl = $('upcoming-list');
  const next7 = tasks.filter(t => {
    if (!t.deadline || t.completed || t.recurring?.enabled) return false;
    return t.deadline > todayStr && t.deadline <= addDays(todayStr, 7);
  }).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 5);

  if (!next7.length) {
    upcomingEl.innerHTML = '<div class="text-muted" style="font-size:13px;padding:12px 0;">No upcoming deadlines in 7 days</div>';
  } else {
    upcomingEl.innerHTML = next7.map(t => {
      const rel = deadlineRelative(t.deadline);
      return `<div class="task-item priority-${t.priority}" onclick="switchView('tasks')" style="cursor:pointer;">
        <div class="task-info">
          <div class="task-title">${escHtml(t.title)}</div>
          <div class="task-meta">
            <span class="task-priority-badge badge-${t.priority}">${t.priority}</span>
            <span>${rel?.label || ''}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // Weekly chart (dynamic mini line-chart in indigo and cyan gradients)
  renderWeeklyChart();

  // Category overview donut (mirrored into the dedicated Overview page)
  renderCategoryOverview();
}

// ── Category Overview (donut + progress bars, shared by Dashboard mini-card
//    and the dedicated Overview page — same markup/format, just two sizes) ──
function renderCategoryOverview() {
  const cats = ['study', 'work', 'personal', 'health'];
  const catColor = { study: 'var(--purple)', work: 'var(--blue)', personal: 'var(--pink)', health: 'var(--emerald)' };
  const activeTasks = tasks.filter(t => !t.recurring?.enabled);

  const counts = Object.fromEntries(cats.map(c => [c, 0]));
  const doneCounts = Object.fromEntries(cats.map(c => [c, 0]));
  activeTasks.forEach(t => {
    if (counts[t.category] === undefined) return;
    counts[t.category]++;
    if (t.completed) doneCounts[t.category]++;
  });
  const total = cats.reduce((s, c) => s + counts[c], 0);

  // Segmented donut (stroke-dasharray trick: each ring gets an arc length +
  // a running offset so the four categories sit back-to-back around the circle)
  const R = 60, C = 2 * Math.PI * R;
  let cum = 0;
  cats.forEach(c => {
    const frac = total ? counts[c] / total : 0;
    const arcLen = frac * C;
    document.querySelectorAll(`[data-cat-seg="${c}"]`).forEach(el => {
      el.style.strokeDasharray = `${arcLen} ${C - arcLen}`;
      el.style.strokeDashoffset = `${-cum}`;
    });
    cum += arcLen;
  });

  document.querySelectorAll('.overview-donut-center').forEach(el => el.textContent = total);

  const legendHtml = cats.map(c => {
    const pct = total ? Math.round((counts[c] / total) * 100) : 0;
    const label = c.charAt(0).toUpperCase() + c.slice(1);
    return `<div class="donut-legend-item"><div class="legend-dot" style="background:${catColor[c]};"></div><span style="color:var(--text-secondary);display:inline-flex;align-items:center;gap:4px;">${CAT_ICON[c]} ${label}</span><span style="margin-left:auto;font-weight:700;color:${catColor[c]};">${counts[c]} · ${pct}%</span></div>`;
  }).join('');
  document.querySelectorAll('.overview-donut-legend').forEach(el => el.innerHTML = legendHtml);

  // Category progress bars (Overview page only)
  const barsEl = $('overview-cat-bars');
  if (barsEl) {
    const maxCat = Math.max(...cats.map(c => counts[c]), 1);
    barsEl.innerHTML = cats.map(c => {
      const pct = Math.round((counts[c] / maxCat) * 100);
      const donePct = counts[c] ? Math.round((doneCounts[c] / counts[c]) * 100) : 0;
      const label = c.charAt(0).toUpperCase() + c.slice(1);
      return `<div class="cat-bar-row"><div class="cat-bar-label"><span class="name" style="display:inline-flex;align-items:center;gap:4px;">${CAT_ICON[c]} ${label}</span><span class="val">${donePct}% done · ${counts[c]} total</span></div><div class="cat-bar-track"><div class="cat-bar-fill fill-${c}" style="width:${pct}%"></div></div></div>`;
    }).join('');
  }
}

function addDays(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function renderWeeklyChart() {
  const chartEl = $('weekly-chart');
  if (!chartEl) return;

  const data = [];
  let maxVal = 3;

  for (let i = 6; i >= 0; i--) {
    const d = addDays(today(), -i);
    const dayTasks = tasks.filter(t => t.deadline === d && !t.recurring?.enabled);
    const done = dayTasks.filter(t => t.completed).length;
    const total = dayTasks.length;
    const dow = new Date(d + 'T00:00:00').getDay();
    if (done > maxVal) maxVal = done;
    data.push({ done, total, dow, d, dateLabel: DAY_NAMES_SHORT[dow] });
  }

  const svgW = 320;
  const svgH = 75;
  const paddingX = 22;
  const paddingY = 16;
  const usableW = svgW - paddingX * 2;
  const usableH = svgH - paddingY * 2;

  const points = data.map((item, idx) => {
    const x = paddingX + (idx / (data.length - 1)) * usableW;
    const ratio = item.done / maxVal;
    const y = (svgH - paddingY) - ratio * usableH;
    return { x, y, item };
  });

  const linePathD = getSmoothPathD(points);
  const areaPathD = `${linePathD} L ${points[points.length - 1].x},${svgH} L ${points[0].x},${svgH} Z`;

  let svgHtml = `
    <svg viewBox="0 0 ${svgW} ${svgH + 20}" style="width:100%;height:100%;overflow:visible;">
      <defs>
        <linearGradient id="indigoCyanLine" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="50%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#06b6d4" />
        </linearGradient>
        <linearGradient id="indigoCyanArea" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.32" />
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.0" />
        </linearGradient>
        <filter id="glowEffect" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#06b6d4" flood-opacity="0.45" />
        </filter>
      </defs>
      <!-- Reference Grid Lines -->
      <line x1="${paddingX}" y1="${paddingY}" x2="${svgW - paddingX}" y2="${paddingY}" stroke="rgba(186,230,253,0.4)" stroke-dasharray="3 3"/>
      <line x1="${paddingX}" y1="${svgH / 2}" x2="${svgW - paddingX}" y2="${svgH / 2}" stroke="rgba(186,230,253,0.4)" stroke-dasharray="3 3"/>
      <line x1="${paddingX}" y1="${svgH}" x2="${svgW - paddingX}" y2="${svgH}" stroke="rgba(186,230,253,0.6)"/>
      
      <!-- Gradient Translucent Area Below Curve -->
      <path d="${areaPathD}" fill="url(#indigoCyanArea)"/>
      
      <!-- Dynamic Indigo-Cyan Line Curve -->
      <path d="${linePathD}" fill="none" stroke="url(#indigoCyanLine)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glowEffect)"/>
      
      <!-- Interactive Data Point Nodes -->
      ${points.map(p => {
    const isToday = p.item.d === today();
    return `
          <g class="chart-point-group" style="cursor:pointer;">
            <circle cx="${p.x}" cy="${p.y}" r="${isToday ? '6' : '4'}" fill="${isToday ? '#06b6d4' : '#6366f1'}" stroke="#ffffff" stroke-width="2.5">
              <title>${p.item.dateLabel}: ${p.item.done} completed of ${p.item.total}</title>
            </circle>
            <text x="${p.x}" y="${svgH + 16}" text-anchor="middle" font-size="10" font-weight="${isToday ? '800' : '600'}" fill="${isToday ? '#0284c7' : '#64748b'}">${p.item.dateLabel}</text>
          </g>
        `;
  }).join('')}
    </svg>
  `;

  chartEl.innerHTML = svgHtml;
  if ($('week-labels')) $('week-labels').style.display = 'none';
}

// ── Task Item HTML (for lists) ────────────────────────────────
function taskItemHTML(t) {
  const rel = deadlineRelative(t.deadline);
  return `<div class="task-item priority-${t.priority} ${t.completed ? 'completed' : ''}" id="ti-${t.id}">
    <div class="task-check" onclick="toggleComplete('${t.id}',event)">
      ${t.completed ? '✓' : ''}
    </div>
    <div class="task-info">
      <div class="task-title">${escHtml(t.title)}</div>
      <div class="task-meta">
        <span class="task-priority-badge badge-${t.priority}">${t.priority}</span>
        ${t.scheduledTime ? `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${formatTime(t.scheduledTime)}</span>` : ''}
        ${rel ? `<span class="deadline-chip ${rel.cls}">${rel.label}</span>` : ''}
        ${t.estimatedMinutes ? `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${t.estimatedMinutes}m</span>` : ''}
      </div>
    </div>
    <div class="task-actions">
      <button class="action-btn" onclick="openTaskModal('${t.id}',event)" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="action-btn delete" onclick="deleteTask('${t.id}',event)" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>
  </div>`;
}

// ── Top Header Search Handlers ────────────────────────────────
function handleHeaderSearch(query) {
  const q = query.trim().toLowerCase();

  const taskSearch = $('task-search');
  if (taskSearch) {
    taskSearch.value = query;
  }

  const todayStr = today();
  const todayTasks = tasks.filter(t => (t.deadline === todayStr || !t.deadline) && !t.recurring?.enabled);
  let filtered = todayTasks;
  if (q) {
    filtered = todayTasks.filter(t =>
      t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
  }

  const listEl = $('today-task-list');
  if (listEl) {
    if (!filtered.length) {
      listEl.innerHTML = renderEmptyState(
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        'No matching tasks',
        'Try searching for another keyword'
      );
    } else {
      listEl.innerHTML = filtered.map(t => taskItemHTML(t)).join('');
    }
  }

  if ($('view-tasks')?.classList.contains('active')) {
    renderTaskGrid();
  }
}

function executeHeaderSearch() {
  const query = $('header-search-input')?.value.trim() || '';
  switchView('tasks');
  const taskSearch = $('task-search');
  if (taskSearch) {
    taskSearch.value = query;
    renderTaskGrid();
  }
}

// ── Task Grid (full manager) ──────────────────────────────────
function renderTaskGrid() {
  const search = $('task-search')?.value.toLowerCase() || '';
  const filterP = $('filter-priority')?.value || '';
  const filterC = $('filter-category')?.value || '';
  const filterS = $('filter-status')?.value || '';

  let filtered = tasks.filter(t => !t.recurring?.enabled);

  if (search) filtered = filtered.filter(t =>
    t.title.toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search)
  );
  if (filterP) filtered = filtered.filter(t => t.priority === filterP);
  if (filterC) filtered = filtered.filter(t => t.category === filterC);
  if (filterS === 'pending') filtered = filtered.filter(t => !t.completed);
  if (filterS === 'completed') filtered = filtered.filter(t => t.completed);

  // Sort: incomplete first, then by priority, then by deadline
  const pOrd = { high: 0, medium: 1, low: 2 };
  filtered.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (pOrd[a.priority] !== pOrd[b.priority]) return pOrd[a.priority] - pOrd[b.priority];
    return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1;
  });

  const grid = $('task-grid');
  if (!filtered.length) {
    grid.innerHTML = renderEmptyState(
      '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9"/><path d="M22 7l-10 7L2 7"/></svg>',
      'No tasks found',
      'Create a new task or adjust your filters.'
    );
    const emptyEl = grid.querySelector('.empty-state');
    if (emptyEl) emptyEl.style.gridColumn = '1/-1';
    return;
  }

  grid.innerHTML = filtered.map(t => taskCardHTML(t)).join('');
}

function taskCardHTML(t) {
  const rel = deadlineRelative(t.deadline);
  const catIcon = CAT_ICON[t.category] || '';
  const recurStr = t.recurring?.enabled
    ? `<span class="recurring-indicator"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Recurring</span>` : '';

  return `<div class="task-card priority-${t.priority} ${t.completed ? 'completed' : ''}" id="tc-${t.id}">
    <div class="task-card-header">
      <div class="task-card-title">${escHtml(t.title)}</div>
      <span class="task-priority-badge badge-${t.priority}">${t.priority}</span>
    </div>
    ${t.description ? `<div class="task-card-desc">${escHtml(t.description).slice(0, 120)}${t.description.length > 120 ? '…' : ''}</div>` : ''}
    <div class="task-card-footer">
      <span class="tag tag-category ${t.category}">${catIcon} ${t.category}</span>
      ${rel ? `<span class="deadline-chip ${rel.cls}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${rel.label}</span>` : ''}
      ${t.estimatedMinutes ? `<span class="task-duration"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${t.estimatedMinutes}m</span>` : ''}
      ${recurStr}
      ${t.scheduledTime ? `<span style="font-size:11px;color:var(--cyan);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${formatTime(t.scheduledTime)}</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
      <button class="btn btn-sm ${t.completed ? 'btn-secondary' : 'btn-primary'}" onclick="toggleComplete('${t.id}',event)" style="flex:1;">
        ${t.completed ? '↩ Reopen' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Complete'}
      </button>
      <button class="btn btn-secondary btn-sm btn-icon" onclick="openTaskModal('${t.id}',event)" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteTask('${t.id}',event)" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
    </div>
  </div>`;
}

// ── Task CRUD ─────────────────────────────────────────────────
let selectedPriority = 'medium';
let recurringEnabled = false;
let selectedDays = [];

function openTaskModal(id = null, e) {
  if (e) e.stopPropagation();
  editingTaskId = id;
  const isEdit = !!id;
  $('modal-title').textContent = isEdit ? 'Edit Task' : 'Create New Task';
  $('modal-save-btn').innerHTML = isEdit ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Update Task' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Task';

  // Reset form
  $('task-form').reset();
  selectedPriority = 'medium';
  recurringEnabled = false;
  selectedDays = [];
  $('recurring-toggle').classList.remove('on');
  $('recurring-label').textContent = 'Not recurring';
  $('recurring-options').style.display = 'none';
  document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.priority-opt').forEach(el => {
    el.className = 'priority-opt';
    if (el.dataset.p === 'medium') el.classList.add('selected-medium');
  });

  if (isEdit) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    $('task-title').value = t.title;
    $('task-desc').value = t.description || '';
    $('task-category').value = t.category;
    $('task-duration').value = t.estimatedMinutes || 30;
    $('task-deadline').value = t.deadline || '';
    $('task-time').value = t.scheduledTime || '';
    selectedPriority = t.priority;

    document.querySelectorAll('.priority-opt').forEach(el => {
      el.className = 'priority-opt';
      if (el.dataset.p === t.priority) el.classList.add(`selected-${t.priority}`);
    });

    if (t.recurring?.enabled) {
      recurringEnabled = true;
      selectedDays = [...(t.recurring.days || [])];
      $('recurring-toggle').classList.add('on');
      $('recurring-label').textContent = 'Repeating';
      $('recurring-options').style.display = 'block';
      selectedDays.forEach(d => {
        document.querySelector(`.day-btn[data-day="${d}"]`)?.classList.add('selected');
      });
    }
  } else {
    $('task-deadline').value = today();
  }

  $('task-modal-overlay').classList.add('show');
  setTimeout(() => $('task-title').focus(), 100);
}

function closeTaskModal(e) {
  if (e && e.target !== $('task-modal-overlay')) return;
  $('task-modal-overlay').classList.remove('show');
  editingTaskId = null;
}

function selectPriority(p) {
  selectedPriority = p;
  document.querySelectorAll('.priority-opt').forEach(el => {
    el.className = 'priority-opt';
    if (el.dataset.p === p) el.classList.add(`selected-${p}`);
  });
}

function toggleRecurring() {
  recurringEnabled = !recurringEnabled;
  $('recurring-toggle').classList.toggle('on', recurringEnabled);
  $('recurring-label').textContent = recurringEnabled ? 'Repeating' : 'Not recurring';
  $('recurring-options').style.display = recurringEnabled ? 'block' : 'none';
}

function toggleDay(d) {
  const idx = selectedDays.indexOf(d);
  if (idx >= 0) selectedDays.splice(idx, 1);
  else selectedDays.push(d);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('selected', selectedDays.includes(Number(btn.dataset.day)));
  });
}

function saveTask(e) {
  e.preventDefault();
  const title = $('task-title').value.trim();
  if (!title) return;

  const taskData = {
    id: editingTaskId || genId(),
    title,
    description: $('task-desc').value.trim(),
    priority: selectedPriority,
    category: $('task-category').value,
    estimatedMinutes: parseInt($('task-duration').value) || 30,
    deadline: $('task-deadline').value || null,
    scheduledTime: $('task-time').value || null,
    recurring: { enabled: recurringEnabled, days: recurringEnabled ? [...selectedDays] : [] },
    completed: false,
    completedAt: null,
    timeBlocked: null,
    createdAt: editingTaskId
      ? tasks.find(t => t.id === editingTaskId)?.createdAt
      : new Date().toISOString()
  };

  if (editingTaskId) {
    const idx = tasks.findIndex(t => t.id === editingTaskId);
    if (idx >= 0) {
      taskData.completed = tasks[idx].completed;
      taskData.completedAt = tasks[idx].completedAt;
      tasks[idx] = taskData;
    }
    showToast('Task updated!', 'success');
  } else {
    tasks.push(taskData);
    showToast('Task created!', 'success');
    updateStreak();
  }

  saveTasks();
  closeTaskModal();
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'tasks') renderTaskGrid();
  if (currentView === 'calendar') renderCalendar();
  renderDashboard(); // always refresh stats
}

function toggleComplete(id, e) {
  if (e) e.stopPropagation();
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  t.completed = !t.completed;
  t.completedAt = t.completed ? new Date().toISOString() : null;
  saveTasks();
  if (t.completed) {
    showToast('Task completed!', 'success');
    updateStreak();
  }
  renderDashboard();
  if (currentView === 'tasks') renderTaskGrid();
}

let pendingConfirmCallback = null;

function showConfirmModal({ title, message, confirmText, confirmClass, onConfirm }) {
  $('confirm-modal-title').textContent = title || 'Confirm Action';
  $('confirm-modal-desc').textContent = message || 'Are you sure?';

  const okBtn = $('confirm-ok-btn');
  if (okBtn) {
    okBtn.textContent = confirmText || 'Confirm';
    okBtn.className = `btn ${confirmClass || 'btn-danger'}`;
  }

  pendingConfirmCallback = onConfirm;
  $('confirm-modal-overlay')?.classList.add('show');
}

function closeConfirmModal(e) {
  if (e && e.target !== $('confirm-modal-overlay')) return;
  $('confirm-modal-overlay')?.classList.remove('show');
  pendingConfirmCallback = null;
}

function deleteTask(id, e) {
  if (e) e.stopPropagation();
  const task = tasks.find(t => t.id === id);
  const taskTitle = task ? `"${task.title}"` : 'this task';

  showConfirmModal({
    title: 'Delete Task',
    message: `Are you sure you want to delete ${taskTitle}? This action cannot be undone.`,
    confirmText: 'Delete Task',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      tasks = tasks.filter(t => t.id !== id);
      saveTasks();
      if (typeof CloudSync !== 'undefined' && CloudSync.isConfigured && CloudSync.currentUser) {
        CloudSync.deleteTaskFromCloud(id);
      }
      showToast('Task deleted', 'info');
      renderDashboard();
      if (currentView === 'tasks') renderTaskGrid();
      if (currentView === 'calendar') renderCalendar();
    }
  });
}

function updateStreak() {
  const t = today();
  if (appStats.lastActiveDate === t) return;
  const yesterday = addDays(t, -1);
  appStats.streak = appStats.lastActiveDate === yesterday ? appStats.streak + 1 : 1;
  appStats.lastActiveDate = t;
  saveStats();
}

// ── Smart Time Blocking ───────────────────────────────────────
function runAutoSchedule() {
  const pending = tasks.filter(t => !t.completed && !t.recurring?.enabled
    && (!t.deadline || t.deadline >= today()));

  if (!pending.length) {
    showToast('No pending tasks to schedule!', 'info');
    return;
  }

  // Priority order
  const pOrd = { high: 0, medium: 1, low: 2 };
  const sorted = [...pending].sort((a, b) => {
    if (pOrd[a.priority] !== pOrd[b.priority]) return pOrd[a.priority] - pOrd[b.priority];
    return (a.deadline || '9999') < (b.deadline || '9999') ? -1 : 1;
  });

  // Build free slot map from 8:00 to 22:00, with 30-min slots
  const WORK_START = 8 * 60;  // minutes from midnight
  const WORK_END = 22 * 60;
  const occupied = new Set();

  // Mark existing scheduled tasks
  tasks.filter(t => t.scheduledTime && t.deadline === today() && !t.completed).forEach(t => {
    const [h, m] = t.scheduledTime.split(':').map(Number);
    const start = h * 60 + m;
    const dur = t.estimatedMinutes || 30;
    for (let s = start; s < start + dur; s += 15) occupied.add(s);
  });

  const suggestions = [];
  let cursor = Math.max(WORK_START, getCurrentMinute() + 15);

  for (const task of sorted) {
    const dur = task.estimatedMinutes || 30;
    // Find next free slot
    let slotStart = null;
    for (let t = cursor; t + dur <= WORK_END; t += 15) {
      let free = true;
      for (let s = t; s < t + dur; s += 15) {
        if (occupied.has(s)) { free = false; break; }
      }
      if (free) { slotStart = t; break; }
    }
    if (slotStart === null) break; // No more room

    // Mark as occupied
    for (let s = slotStart; s < slotStart + dur; s += 15) occupied.add(s);
    cursor = slotStart + dur + 10; // 10 min break

    suggestions.push({
      task,
      startMin: slotStart,
      endMin: slotStart + dur,
      timeStr: minToHHMM(slotStart)
    });
  }

  if (!suggestions.length) {
    showToast('Not enough free time slots today!', 'info');
    return;
  }

  pendingScheduleSuggestions = suggestions;
  showScheduleModal(suggestions);
}

function getCurrentMinute() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

function minToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function showScheduleModal(suggestions) {
  const content = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--text-secondary);">
      Scheduled <strong>${suggestions.length}</strong> tasks into available time slots for today:
    </div>
    <div class="suggestion-list">
      ${suggestions.map(s => `
        <div class="suggestion-item">
          <span class="suggestion-time"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${formatTime(s.timeStr)}</span>
          <span class="suggestion-task priority-${s.task.priority}">
            <span class="task-priority-badge badge-${s.task.priority}">${s.task.priority}</span>
            ${escHtml(s.task.title)}
          </span>
          <span class="suggestion-dur"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ${s.task.estimatedMinutes}m</span>
        </div>`).join('')}
    </div>`;
  $('schedule-suggestions-content').innerHTML = content;
  $('schedule-modal-overlay').classList.add('show');
}

function closeScheduleModal(e) {
  if (e && e.target !== $('schedule-modal-overlay')) return;
  $('schedule-modal-overlay').classList.remove('show');
}

function applySchedule() {
  pendingScheduleSuggestions.forEach(s => {
    const t = tasks.find(x => x.id === s.task.id);
    if (t) {
      t.scheduledTime = s.timeStr;
      t.deadline = t.deadline || today();
    }
  });
  saveTasks();
  closeScheduleModal();
  showToast(`Scheduled ${pendingScheduleSuggestions.length} tasks!`, 'success');
  renderDashboard();
  if (currentView === 'calendar') renderCalendar();
}

// ── Calendar ──────────────────────────────────────────────────
let calView = 'day';
let calDate = new Date();

function switchCalView(v) {
  calView = v;
  ['day', 'week', 'month'].forEach(x => {
    $(`cal-btn-${x}`).classList.toggle('active', x === v);
    $(`cal-${x === 'day' ? 'daily' : x === 'week' ? 'weekly' : 'monthly'}`).classList.toggle('show', x === v);
  });
  renderCalendar();
}

function calNav(dir) {
  if (calView === 'day') calDate.setDate(calDate.getDate() + dir);
  if (calView === 'week') calDate.setDate(calDate.getDate() + dir * 7);
  if (calView === 'month') calDate.setMonth(calDate.getMonth() + dir);
  renderCalendar();
}

function calGoToday() { calDate = new Date(); renderCalendar(); }

function renderCalendar() {
  if (calView === 'day') renderDailyView();
  if (calView === 'week') renderWeeklyView();
  if (calView === 'month') renderMonthlyView();
}

function renderDailyView() {
  const d = calDate.toISOString().slice(0, 10);
  $('cal-period-label').textContent = calDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const dayTasks = tasks.filter(t => !t.recurring?.enabled && t.deadline === d);

  const hours = Array.from({ length: 17 }, (_, i) => i + 6); // 6am – 10pm
  $('daily-grid').innerHTML = hours.map(h => {
    const hhmm = `${String(h).padStart(2, '0')}:00`;
    const slotTasks = dayTasks.filter(t => {
      if (!t.scheduledTime) return false;
      const [th] = t.scheduledTime.split(':').map(Number);
      return th === h;
    });
    return `<div class="time-row">
      <div class="time-label">${formatTime(hhmm)}</div>
      <div class="time-slot">
        ${slotTasks.map(t => `
          <div class="cal-event ${t.priority}" onclick="openTaskModal('${t.id}')">
            <span>${CAT_EMOJI[t.category]}</span>
            <span>${escHtml(t.title)}</span>
            ${t.estimatedMinutes ? `<span style="margin-left:auto;font-size:10px;opacity:.6">${t.estimatedMinutes}m</span>` : ''}
          </div>`).join('')}
        ${!slotTasks.length && dayTasks.filter(t => !t.scheduledTime).length && h === 9
        ? `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">Unscheduled tasks — use Auto-Schedule to place them</div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Unscheduled tasks panel
  const unscheduled = dayTasks.filter(t => !t.scheduledTime);
  if (unscheduled.length) {
    $('daily-grid').innerHTML += `<div style="padding:12px;border-top:1px solid var(--border);">
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;">UNSCHEDULED (${unscheduled.length})</div>
      ${unscheduled.map(t => `<div class="cal-event ${t.priority}" onclick="openTaskModal('${t.id}')">
        <span>${CAT_EMOJI[t.category]}</span><span>${escHtml(t.title)}</span>
      </div>`).join('')}
    </div>`;
  }
}

function renderWeeklyView() {
  // Find Monday of week
  const weekStart = new Date(calDate);
  const dow = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() - dow); // week starts Sunday

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  $('cal-period-label').textContent = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const todayStr = today();

  // Header
  $('weekly-header').innerHTML = `<div class="week-day-header" style="background:var(--bg-card);border:none;"></div>` +
    days.map(d => {
      const dStr = d.toISOString().slice(0, 10);
      return `<div class="week-day-header ${dStr === todayStr ? 'today' : ''}">
        <div class="dow">${DAY_NAMES_SHORT[d.getDay()]}</div>
        <div class="date-num">${d.getDate()}</div>
      </div>`;
    }).join('');

  const hours = Array.from({ length: 16 }, (_, i) => i + 6);
  $('weekly-body').innerHTML = hours.map(h => {
    const hhmm = `${String(h).padStart(2, '0')}:00`;
    return `<div class="weekly-row">
      <div class="time-label" style="display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted);border-right:1px solid var(--border);">${formatTime(hhmm)}</div>
      ${days.map(d => {
      const dStr = d.toISOString().slice(0, 10);
      const slotTasks = tasks.filter(t => !t.recurring?.enabled && t.deadline === dStr && t.scheduledTime && parseInt(t.scheduledTime.split(':')[0]) === h);
      return `<div class="weekly-cell ${dStr === todayStr ? 'today' : ''}">
          ${slotTasks.map(t => `<div class="cal-event ${t.priority}" onclick="openTaskModal('${t.id}')" style="font-size:10px;">${escHtml(t.title.slice(0, 18))}…</div>`).join('')}
        </div>`;
    }).join('')}
    </div>`;
  }).join('');
}

function renderMonthlyView() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  $('cal-period-label').textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = today();

  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map(d => `<div class="month-day-name">${d}</div>`).join('');

  // Leading blanks from previous month
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="month-cell other-month"><div class="month-date">${prevDays - i}</div></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayTasks = tasks.filter(t => !t.recurring?.enabled && t.deadline === dStr);
    const isToday = dStr === todayStr;

    const chips = dayTasks.slice(0, 3).map(t =>
      `<div class="month-event-chip ${t.priority === 'high' ? 'badge-high' : t.priority === 'medium' ? 'badge-medium' : 'badge-low'}"
        onclick="event.stopPropagation();openTaskModal('${t.id}')"
        style="background:rgba(${t.priority === 'high' ? '244,63,94' : t.priority === 'medium' ? '245,158,11' : '16,185,129'},0.15);"
        title="${escHtml(t.title)}">
        ${escHtml(t.title.slice(0, 14))}${t.title.length > 14 ? '…' : ''}
      </div>`).join('');

    const more = dayTasks.length > 3 ? `<div style="font-size:9px;color:var(--text-muted);">+${dayTasks.length - 3} more</div>` : '';

    html += `<div class="month-cell ${isToday ? 'today' : ''}" onclick="calDate=new Date('${dStr}');switchCalView('day')">
      <div class="month-date">${day}</div>
      ${chips}${more}
    </div>`;
  }

  // Trailing blanks
  const total = firstDay + daysInMonth;
  const trailing = (7 - (total % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    html += `<div class="month-cell other-month"><div class="month-date">${i}</div></div>`;
  }

  $('month-grid').innerHTML = html;
}

// ── Focus Timer ───────────────────────────────────────────────
let timerInterval = null;
let timerRunning = false;
let timerMode = 'work';
let timerSecondsLeft = 25 * 60;
let currentSession = 1;
let focusTaskId = null;
let todayFocusSessions = parseInt(localStorage.getItem('sf_focus_today') || '0');
let todayFocusMinutes = parseInt(localStorage.getItem('sf_focus_min') || '0');
const CIRCUMFERENCE = 2 * Math.PI * 100; // r=100

function renderFocusView() {
  updateFocusTaskDropdown();
  updateSessionDots();
  renderFocusStats();
  syncTimerSettings();
}

function updateFocusTaskDropdown() {
  const sel = $('focus-task-select');
  const pending = tasks.filter(t => !t.completed && !t.recurring?.enabled);
  sel.innerHTML = `<option value="">— Select a task —</option>` +
    pending.map(t => `<option value="${t.id}" ${t.id === focusTaskId ? 'selected' : ''}>${escHtml(t.title)}</option>`).join('');
  updateFocusTask();
}

function updateFocusTask() {
  focusTaskId = $('focus-task-select').value || null;
  const task = focusTaskId ? tasks.find(t => t.id === focusTaskId) : null;
  $('timer-focused-task').textContent = task ? task.title : 'No task selected';
}

function setTimerMode(mode) {
  if (timerRunning) return;
  timerMode = mode;
  ['work', 'short', 'long'].forEach(m => $(`mode-${m}`).classList.toggle('active', m === mode));
  resetTimer();
  $('timer-mode-label').textContent = mode === 'work' ? 'Focus Session' : mode === 'short' ? 'Short Break' : 'Long Break';
}

function getModeSeconds() {
  if (timerMode === 'work') return pomodoroSettings.workMinutes * 60;
  if (timerMode === 'short') return pomodoroSettings.shortBreakMinutes * 60;
  return pomodoroSettings.longBreakMinutes * 60;
}

function toggleTimer() {
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    $('timer-play-btn').textContent = '▶';
  } else {
    timerRunning = true;
    $('timer-play-btn').textContent = '⏸';
    timerInterval = setInterval(tickTimer, 1000);
  }
}

function tickTimer() {
  timerSecondsLeft--;
  updateTimerDisplay();
  if (timerSecondsLeft <= 0) {
    clearInterval(timerInterval);
    timerRunning = false;
    $('timer-play-btn').textContent = '▶';
    onTimerComplete();
  }
}

function onTimerComplete() {
  playBeep();
  if (timerMode === 'work') {
    appStats.totalPomodoros++;
    saveStats();
    todayFocusSessions++;
    todayFocusMinutes += pomodoroSettings.workMinutes;
    localStorage.setItem('sf_focus_today', todayFocusSessions);
    localStorage.setItem('sf_focus_min', todayFocusMinutes);
    renderFocusStats();

    showToast('🍅 Pomodoro complete! Time for a break.', 'success');

    if (currentSession >= pomodoroSettings.sessionsBeforeLong) {
      currentSession = 1;
      setTimerMode('long');
    } else {
      currentSession++;
      setTimerMode('short');
    }
    updateSessionDots();
    $('stat-pomodoros').textContent = appStats.totalPomodoros;
    $('sidebar-focus').textContent = appStats.totalPomodoros;
  } else {
    showToast('☀️ Break over! Time to focus.', 'info');
    setTimerMode('work');
  }
}

function resetTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  $('timer-play-btn').textContent = '▶';
  timerSecondsLeft = getModeSeconds();
  updateTimerDisplay();
}

function skipTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  $('timer-play-btn').textContent = '▶';
  onTimerComplete();
}

function updateTimerDisplay() {
  const m = Math.floor(timerSecondsLeft / 60);
  const s = timerSecondsLeft % 60;
  $('timer-display').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const total = getModeSeconds();
  const frac = timerSecondsLeft / total;
  const offset = CIRCUMFERENCE * (1 - frac);
  $('timer-ring').style.strokeDashoffset = offset;
}

function updateSessionDots() {
  const n = pomodoroSettings.sessionsBeforeLong;
  $('session-dots').innerHTML = Array.from({ length: n }, (_, i) => {
    const cls = i + 1 < currentSession ? 'filled' : i + 1 === currentSession ? 'current' : '';
    return `<div class="session-dot ${cls}"></div>`;
  }).join('');
}

function renderFocusStats() {
  $('focus-sessions-today').textContent = todayFocusSessions;
  $('focus-minutes-today').textContent = todayFocusMinutes;
}

function syncTimerSettings() {
  $('work-dur-slider').value = pomodoroSettings.workMinutes;
  $('short-dur-slider').value = pomodoroSettings.shortBreakMinutes;
  $('long-dur-slider').value = pomodoroSettings.longBreakMinutes;
  $('sessions-before-slider').value = pomodoroSettings.sessionsBeforeLong;
  $('work-dur-val').textContent = pomodoroSettings.workMinutes;
  $('short-dur-val').textContent = pomodoroSettings.shortBreakMinutes;
  $('long-dur-val').textContent = pomodoroSettings.longBreakMinutes;
  $('sessions-before-val').textContent = pomodoroSettings.sessionsBeforeLong;
}

function updateTimerSettings() {
  pomodoroSettings.workMinutes = parseInt($('work-dur-slider').value);
  pomodoroSettings.shortBreakMinutes = parseInt($('short-dur-slider').value);
  pomodoroSettings.longBreakMinutes = parseInt($('long-dur-slider').value);
  pomodoroSettings.sessionsBeforeLong = parseInt($('sessions-before-slider').value);
  $('work-dur-val').textContent = pomodoroSettings.workMinutes;
  $('short-dur-val').textContent = pomodoroSettings.shortBreakMinutes;
  $('long-dur-val').textContent = pomodoroSettings.longBreakMinutes;
  $('sessions-before-val').textContent = pomodoroSettings.sessionsBeforeLong;
  saveSettings();
  if (!timerRunning) { timerSecondsLeft = getModeSeconds(); updateTimerDisplay(); }
  updateSessionDots();
}

// Web Audio beep
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start(); osc.stop(ctx.currentTime + 0.8);
  } catch (e) { /* audio not supported */ }
}

// ── Settings ──────────────────────────────────────────────────
function renderSettings() {
  const allTasks = tasks.filter(t => !t.recurring?.enabled);
  const completed = allTasks.filter(t => t.completed).length;
  $('global-stats').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="focus-stat"><div class="val">${allTasks.length}</div><div class="lbl">Total Tasks</div></div>
      <div class="focus-stat"><div class="val">${completed}</div><div class="lbl">Completed</div></div>
      <div class="focus-stat"><div class="val">${appStats.totalPomodoros}</div><div class="lbl">Pomodoros</div></div>
      <div class="focus-stat"><div class="val">${appStats.streak}</div><div class="lbl">Streak</div></div>
    </div>`;
}

function toggleTheme() {
  document.body.classList.toggle('dark-theme');
  const isDark = document.body.classList.contains('dark-theme');
  $('theme-icon').innerHTML = isDark
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  $('theme-label').textContent = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  localStorage.setItem('sf_theme', isDark ? 'dark' : 'light');
}

function exportData() {
  const data = { tasks, pomodoroSettings, appStats, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `chronify-backup-${today()}.json`;
  a.click(); URL.revokeObjectURL(url);
  showToast('Data exported!', 'success');
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.tasks) { tasks = data.tasks; saveTasks(); }
      if (data.pomodoroSettings) { pomodoroSettings = data.pomodoroSettings; saveSettings(); }
      if (data.appStats) { appStats = data.appStats; saveStats(); }
      showToast('Data imported successfully!', 'success');
      renderDashboard();
      renderSettings();
    } catch { showToast('Invalid file format', 'error'); }
  };
  reader.readAsText(file);
}

function clearAllData() {
  showConfirmModal({
    title: 'Clear All Data',
    message: 'This will delete ALL tasks and reset all app statistics. This action cannot be undone.',
    confirmText: 'Clear All Data',
    confirmClass: 'btn-danger',
    onConfirm: () => {
      tasks = []; saveTasks();
      appStats = { totalPomodoros: 0, streak: 0, lastActiveDate: '' }; saveStats();
      localStorage.removeItem('sf_focus_today');
      localStorage.removeItem('sf_focus_min');
      showToast('All data cleared', 'info');
      renderDashboard();
      renderSettings();
    }
  });
}

// ── Toast Notifications ────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icon = type === 'success'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : type === 'error'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${msg}</span>`;
  $('toast-container').appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; toast.style.transition = 'all 0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// ── Escape HTML ───────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Seed Demo Data ────────────────────────────────────────────
function seedDemoData() {
  if (tasks.length > 0) return;
  const t = today();
  const tmr = addDays(t, 1);
  const demo = [
    { title: 'Read Chapter 5 – Physics', priority: 'high', category: 'study', estimatedMinutes: 60, deadline: t, scheduledTime: '09:00', description: 'Focus on thermodynamics and heat transfer sections.' },
    { title: 'Complete Math Assignment', priority: 'high', category: 'study', estimatedMinutes: 90, deadline: t, scheduledTime: '11:00', description: 'Problems 12-25 from exercise set B.' },
    { title: 'Team Project Meeting', priority: 'medium', category: 'work', estimatedMinutes: 45, deadline: t, scheduledTime: '14:00', description: 'Weekly sync with the project team.' },
    { title: 'Morning Workout', priority: 'medium', category: 'health', estimatedMinutes: 30, deadline: t, scheduledTime: '07:00', description: 'Cardio + stretching routine.' },
    { title: 'Review Lecture Notes', priority: 'low', category: 'study', estimatedMinutes: 45, deadline: tmr, description: 'Consolidate this week\'s notes.' },
    { title: 'Grocery Shopping', priority: 'low', category: 'personal', estimatedMinutes: 45, deadline: tmr, description: '' },
    {
      title: 'Daily Journaling', priority: 'low', category: 'personal', estimatedMinutes: 15, deadline: t,
      recurring: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6] }, description: 'Reflect on the day.'
    },
    {
      title: 'Practice Coding Problems', priority: 'medium', category: 'study', estimatedMinutes: 60,
      deadline: addDays(t, 2), description: 'LeetCode medium difficulty problems.'
    }
  ];

  tasks = demo.map(d => ({
    id: genId(),
    title: d.title,
    description: d.description || '',
    priority: d.priority,
    category: d.category,
    estimatedMinutes: d.estimatedMinutes,
    deadline: d.deadline || null,
    scheduledTime: d.scheduledTime || null,
    recurring: d.recurring || { enabled: false, days: [] },
    completed: false,
    completedAt: null,
    timeBlocked: null,
    createdAt: new Date().toISOString()
  }));

  // Mark one as done
  tasks[3].completed = true;
  tasks[3].completedAt = new Date().toISOString();

  saveTasks();
}

// ── Cloud Sync UI Integration ─────────────────────────────────
function initCloudSync() {
  if (typeof CloudSync === 'undefined') return;

  CloudSync.init(null, {
    onSyncStatusChange: (status, user) => {
      updateCloudSyncBadge(status, user);
      renderCloudAccountCard();
    },
    onTasksUpdated: (cloudTasks) => {
      if (cloudTasks && cloudTasks.length > 0) {
        tasks = cloudTasks;
        DB.save('sf_tasks', tasks);
        if (currentView === 'dashboard') renderDashboard();
        if (currentView === 'tasks') renderTaskGrid();
        if (currentView === 'calendar') renderCalendar();
        if (currentView === 'analytics') renderAnalytics();
      }
    },
    onSettingsUpdated: (cloudSettings) => {
      if (cloudSettings) {
        pomodoroSettings = { ...pomodoroSettings, ...cloudSettings };
        DB.save('sf_pomodoro', pomodoroSettings);
        syncTimerSettings();
      }
    },
    onStatsUpdated: (cloudStats) => {
      if (cloudStats) {
        appStats = { ...appStats, ...cloudStats };
        DB.save('sf_stats', appStats);
        renderDashboard();
      }
    }
  });
}

function openCloudModal() {
  $('cloud-modal-overlay')?.classList.add('show');
  const cfg = DB.load('sf_firebase_config', null);
  if (cfg) {
    if ($('cfg-api-key') && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY') $('cfg-api-key').value = cfg.apiKey;
    if ($('cfg-project-id') && cfg.projectId && cfg.projectId !== 'YOUR_PROJECT_ID') $('cfg-project-id').value = cfg.projectId;
    if ($('cfg-app-id') && cfg.appId && cfg.appId !== 'YOUR_APP_ID') $('cfg-app-id').value = cfg.appId;
  }
  renderCloudAccountCard();
}

function closeCloudModal(e) {
  if (e && e.target !== $('cloud-modal-overlay')) return;
  $('cloud-modal-overlay')?.classList.remove('show');
}

function renderCloudAccountCard() {
  const card = $('cloud-account-card');
  if (!card) return;

  const authSection = $('firebase-auth-section');
  const loggedinControls = $('firebase-loggedin-controls');

  if (typeof CloudSync === 'undefined' || !CloudSync.isConfigured) {
    card.innerHTML = `
      <div style="padding:12px;background:var(--bg-tertiary);border-radius:10px;border:1px solid var(--border);">
        <div style="font-weight:600;font-size:14px;color:var(--amber);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg> Local Mode (Firebase Unconfigured)
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">Your tasks are currently saved locally. Enter your Firebase project credentials below to enable real-time cloud sync & authentication.</div>
      </div>`;

    if (authSection) authSection.style.display = 'none';
    if (loggedinControls) loggedinControls.style.display = 'none';
    updateCloudSyncBadge('unconfigured', null);
    return;
  }

  const user = CloudSync.currentUser;
  if (user) {
    const isAnon = user.isAnonymous;
    const name = user.displayName || (isAnon ? 'Guest Workspace' : (user.email ? user.email.split('@')[0] : 'User'));
    const email = user.email || (isAnon ? 'Anonymous Cloud Session' : '');
    const providerId = isAnon ? 'Guest' : (user.providerData && user.providerData[0] ? user.providerData[0].providerId : 'Firebase');

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-tertiary);border-radius:10px;border:1px solid var(--border);">
        <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--purple));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;">
          ${name.charAt(0).toUpperCase()}
        </div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;color:var(--text-primary);">${escHtml(name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${escHtml(email)}</div>
        </div>
        <span class="task-priority-badge badge-low" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);">
          ${isAnon ? 'Guest Cloud' : 'Firebase Synced'}
        </span>
      </div>`;

    if (authSection) authSection.style.display = 'none';
    if (loggedinControls) loggedinControls.style.display = 'block';
    updateCloudSyncBadge('synced', user);
  } else {
    card.innerHTML = `
      <div style="padding:12px;background:var(--bg-tertiary);border-radius:10px;border:1px solid var(--border);">
        <div style="font-weight:600;font-size:14px;color:var(--cyan);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg> Firebase Connected
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">Sign in with Google, Email, or Guest mode to synchronize your tasks in real time across all devices.</div>
      </div>`;

    if (authSection) authSection.style.display = 'block';
    if (loggedinControls) loggedinControls.style.display = 'none';
    updateCloudSyncBadge('offline', null);
  }
}

function updateCloudSyncBadge(status, user) {
  const dot = $('cloud-status-dot');
  const txt = $('cloud-status-text');
  const usr = $('cloud-user-name');
  if (!dot || !txt) return;

  dot.className = `cloud-status-dot ${status}`;

  if (status === 'synced') {
    txt.textContent = 'Cloud Synced';
    if (usr) usr.textContent = user ? (user.displayName || (user.isAnonymous ? 'Guest' : (user.email ? user.email.split('@')[0] : 'User'))) : '';
  } else if (status === 'syncing') {
    txt.textContent = 'Syncing...';
  } else if (status === 'offline') {
    txt.textContent = 'Offline';
  } else if (status === 'unconfigured') {
    txt.textContent = 'Local Mode';
    if (usr) usr.textContent = '';
  } else {
    txt.textContent = 'Sync Error';
  }
}

function switchFbAuthTab(tab) {
  const loginBtn = $('tab-fb-login');
  const regBtn = $('tab-fb-register');
  const loginForm = $('form-fb-login');
  const regForm = $('form-fb-register');

  if (tab === 'login') {
    loginBtn?.classList.add('active');
    regBtn?.classList.remove('active');
    if (loginForm) loginForm.style.display = 'block';
    if (regForm) regForm.style.display = 'none';
  } else {
    regBtn?.classList.add('active');
    loginBtn?.classList.remove('active');
    if (regForm) regForm.style.display = 'block';
    if (loginForm) loginForm.style.display = 'none';
  }
}

function handleFirebaseEmailLogin(e) {
  e.preventDefault();
  const email = $('fb-login-email')?.value.trim();
  const password = $('fb-login-password')?.value;
  if (!email || !password) return;

  if (typeof CloudSync === 'undefined' || !CloudSync.isConfigured) {
    showToast('Please configure Firebase project credentials below first', 'error');
    return;
  }

  showToast('Signing in with Firebase...', 'info');
  CloudSync.signInWithEmail(email, password)
    .then(() => {
      showToast('Signed in successfully!', 'success');
      renderCloudAccountCard();
      closeCloudModal();
    })
    .catch(err => {
      showToast(`Login error: ${err.message}`, 'error');
    });
}

function handleFirebaseEmailRegister(e) {
  e.preventDefault();
  const name = $('fb-reg-name')?.value.trim();
  const email = $('fb-reg-email')?.value.trim();
  const password = $('fb-reg-password')?.value;
  if (!email || !password) return;

  if (typeof CloudSync === 'undefined' || !CloudSync.isConfigured) {
    showToast('Please configure Firebase project credentials below first', 'error');
    return;
  }

  showToast('Creating Firebase account...', 'info');
  CloudSync.signUpWithEmail(email, password, name)
    .then(() => {
      showToast('Account created and signed in!', 'success');
      renderCloudAccountCard();
      closeCloudModal();
    })
    .catch(err => {
      showToast(`Registration error: ${err.message}`, 'error');
    });
}

function handleGoogleSignIn() {
  if (typeof CloudSync === 'undefined' || !CloudSync.isConfigured) {
    showToast('Please configure Firebase credentials below first', 'error');
    return;
  }
  showToast('Connecting with Google...', 'info');
  CloudSync.signInWithGoogle()
    .then(() => {
      showToast('Signed in with Google! Cloud Sync active.', 'success');
      renderCloudAccountCard();
      closeCloudModal();
    })
    .catch(err => {
      showToast(`Sign in error: ${err.message}`, 'error');
    });
}

function handleAnonSignIn() {
  if (typeof CloudSync === 'undefined' || !CloudSync.isConfigured) {
    showToast('Please configure Firebase credentials below first', 'error');
    return;
  }
  showToast('Starting Guest session...', 'info');
  CloudSync.signInAnonymously()
    .then(() => {
      showToast('Guest cloud workspace active!', 'success');
      renderCloudAccountCard();
      closeCloudModal();
    })
    .catch(err => {
      showToast(`Guest sign in error: ${err.message}`, 'error');
    });
}

function handleSignOut() {
  if (typeof CloudSync === 'undefined') return;
  CloudSync.signOut()
    .then(() => {
      showToast('Signed out from Firebase', 'info');
      renderCloudAccountCard();
      updateCloudSyncBadge('unconfigured', null);
    })
    .catch(err => {
      showToast(`Sign out error: ${err.message}`, 'error');
    });
}

function handleSaveCloudConfig(e) {
  e.preventDefault();
  const apiKey = $('cfg-api-key').value.trim();
  const projectId = $('cfg-project-id').value.trim();
  const appId = $('cfg-app-id').value.trim();

  if (!apiKey || !projectId) {
    showToast('Please enter Firebase API Key and Project ID', 'error');
    return;
  }

  const customConfig = {
    apiKey,
    projectId,
    appId: appId || `1:12345:web:${projectId}`,
    authDomain: `${projectId}.firebaseapp.com`,
    storageBucket: `${projectId}.appspot.com`
  };

  const success = CloudSync.saveConfig(customConfig);
  if (success) {
    showToast('Firebase configuration saved & connected!', 'success');
    renderCloudAccountCard();
    closeCloudModal();
  } else {
    showToast('Could not initialize Firebase with provided keys', 'error');
  }
}

// ── Init ──────────────────────────────────────────────────────
function init() {
  // Restore theme
  if (localStorage.getItem('sf_theme') === 'dark') {
    document.body.classList.add('dark-theme');
    if ($('theme-icon')) $('theme-icon').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    if ($('theme-label')) $('theme-label').textContent = 'Switch to Light Mode';
  }

  seedDemoData();
  generateRecurringInstances();

  // Initialize Cloud Sync & Timer
  initCloudSync();
  renderCloudAccountCard();
  timerSecondsLeft = getModeSeconds();
  updateTimerDisplay();
  updateSessionDots();

  // Wire confirm modal OK button
  $('confirm-ok-btn')?.addEventListener('click', () => {
    const cb = pendingConfirmCallback;
    pendingConfirmCallback = null;
    $('confirm-modal-overlay')?.classList.remove('show');
    if (typeof cb === 'function') {
      cb();
    }
  });

  // Initial render
  renderDashboard();

  // Auto-start reminder checks if permission already granted
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    startReminderChecks();
  }

  // Keyboard shortcut: N = new task, T = go to timer, A = analytics
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'n' || e.key === 'N') openTaskModal();
    if (e.key === 't' || e.key === 'T') switchView('focus');
    if (e.key === 'a' || e.key === 'A') switchView('analytics');
    if (e.key === 'Escape') { closeTaskModal(); closeScheduleModal(); closeCloudModal(); closeConfirmModal(); }
  });
}

// ── Analytics Module ──────────────────────────────────────────
let reminderPrefs = DB.load('sf_reminder_prefs', {
  deadlineReminders: true,
  studyReminders: true,
  streakReminders: true
});
let trendMode = 'week';
let reminderCheckInterval = null;
const CIRCUMFERENCE_DONUT = 2 * Math.PI * 60; // r=60

// XP / Level definitions
const LEVELS = [
  { level: 1, name: 'Beginner', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`, xpNeeded: 0 },
  { level: 2, name: 'Learner', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`, xpNeeded: 50 },
  { level: 3, name: 'Focused', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`, xpNeeded: 150 },
  { level: 4, name: 'Consistent', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`, xpNeeded: 300 },
  { level: 5, name: 'Productive', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.71 1.26-1.5 1.5-2.5l-4.5-4.5c-1 0-1.79.79-2.5 1.5z"/><path d="M12 15l-3-3 7.5-7.5.76.76c.78.78.78 2.05 0 2.83L12 15z"/></svg>`, xpNeeded: 500 },
  { level: 6, name: 'Scholar', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`, xpNeeded: 800 },
  { level: 7, name: 'Expert', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`, xpNeeded: 1200 },
  { level: 8, name: 'Master', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12l4 6-10 12L2 9z"/></svg>`, xpNeeded: 2000 },
];

const ACHIEVEMENTS = [
  { id: 'first_task', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`, name: 'First Step', req: 'Complete 1 task', check: (s, t) => t >= 1 },
  { id: 'ten_tasks', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`, name: 'On a Roll', req: '10 tasks done', check: (s, t) => t >= 10 },
  { id: 'streak3', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3.5z"/></svg>`, name: 'Hot Streak', req: '3-day streak', check: (s) => s >= 3 },
  { id: 'streak7', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`, name: 'Week Warrior', req: '7-day streak', check: (s) => s >= 7 },
  { id: 'pomo5', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, name: 'Tomato Time', req: '5 Pomodoros', check: (_, __, p) => p >= 5 },
  { id: 'pomo25', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 16 14"/></svg>`, name: 'Focus Master', req: '25 Pomodoros', check: (_, __, p) => p >= 25 },
  { id: 'allcat', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 1 0 10 10"/></svg>`, name: 'Well-Rounded', req: 'Tasks in all 4 categories', check: (_, __, ___, c) => c >= 4 },
  { id: 'earlybird', icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>`, name: 'Early Bird', req: 'Complete task before 9am', check: (_, __, ___, ____, e) => e },
];

function computeXP() {
  const completedCount = tasks.filter(t => !t.recurring?.enabled && t.completed).length;
  return completedCount * 10 + appStats.totalPomodoros * 5 + appStats.streak * 3;
}

function getLevelData(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xpNeeded) lvl = l; else break; }
  const nextIdx = LEVELS.indexOf(lvl) + 1;
  const next = LEVELS[nextIdx] || null;
  const xpInLevel = xp - lvl.xpNeeded;
  const xpNeeded = next ? next.xpNeeded - lvl.xpNeeded : 999;
  return { lvl, next, xpInLevel, xpNeeded, pct: Math.min(100, Math.round((xpInLevel / xpNeeded) * 100)) };
}

function getAnalyticsRange() {
  return parseInt($('analytics-range')?.value || 30);
}

function renderAnalytics() {
  const days = getAnalyticsRange();
  const todayStr = today();
  const startStr = addDays(todayStr, -days + 1);

  const inRange = tasks.filter(t => !t.recurring?.enabled && t.deadline >= startStr && t.deadline <= todayStr);
  const completed = inRange.filter(t => t.completed);
  const pending = inRange.filter(t => !t.completed);
  const overdue = tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline && t.deadline < todayStr);
  const totalMin = completed.reduce((s, t) => s + (t.estimatedMinutes || 0), 0);
  const rate = inRange.length ? Math.round((completed.length / inRange.length) * 100) : 0;
  const xp = computeXP();

  // KPI cards
  $('analytics-kpis').innerHTML = [
    { icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`, val: completed.length, label: 'Completed', color: 'k-emerald', trend: `+${completed.length} in ${days}d`, tdir: 'up' },
    { icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, val: pending.length, label: 'Pending', color: 'k-blue', trend: `${overdue.length} overdue`, tdir: overdue.length ? 'down' : 'up' },
    { icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, val: `${Math.round(totalMin / 60 * 10) / 10}h`, label: 'Time Logged', color: 'k-purple', trend: `${totalMin}m total`, tdir: 'up' },
    { icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, val: appStats.totalPomodoros, label: 'Pomodoros', color: 'k-amber', trend: `${todayFocusMinutes}m today`, tdir: 'up' },
    { icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3.5z"/></svg>`, val: appStats.streak, label: 'Day Streak', color: 'k-rose', trend: appStats.streak > 0 ? 'Keep it up!' : 'Start today!', tdir: appStats.streak > 0 ? 'up' : 'down' },
  ].map(k => `<div class="kpi-card ${k.color}"><div class="kpi-icon">${k.icon}</div><div class="kpi-value ${k.color}">${k.val}</div><div class="kpi-label">${k.label}</div><div class="kpi-trend ${k.tdir}">${k.tdir === 'up' ? '↑' : '↓'} ${k.trend}</div></div>`).join('');

  // Donut
  const total = completed.length + pending.length;
  if (total > 0) {
    const compOff = CIRCUMFERENCE_DONUT * (1 - completed.length / total);
    const pendOff = CIRCUMFERENCE_DONUT * (1 - pending.length / total);
    const rotDeg = -90 + (completed.length / total) * 360;
    $('donut-completed').style.strokeDashoffset = compOff;
    $('donut-pending').style.strokeDashoffset = pendOff;
    $('donut-pending').setAttribute('transform', `rotate(${rotDeg} 80 80)`);
  } else {
    $('donut-completed').style.strokeDashoffset = CIRCUMFERENCE_DONUT;
    $('donut-pending').style.strokeDashoffset = CIRCUMFERENCE_DONUT;
  }
  $('donut-center-text').textContent = `${rate}%`;
  $('donut-legend').innerHTML = `
    <div class="donut-legend-item"><div class="legend-dot" style="background:var(--emerald);"></div><span style="color:var(--text-secondary);">Completed</span><span style="margin-left:auto;font-weight:700;color:var(--emerald);">${completed.length}</span></div>
    <div class="donut-legend-item"><div class="legend-dot" style="background:var(--amber);"></div><span style="color:var(--text-secondary);">Pending</span><span style="margin-left:auto;font-weight:700;color:var(--amber);">${pending.length}</span></div>
    <div class="donut-legend-item"><div class="legend-dot" style="background:var(--rose);"></div><span style="color:var(--text-secondary);">Overdue</span><span style="margin-left:auto;font-weight:700;color:var(--rose);">${overdue.length}</span></div>`;

  // Category bars
  const cats = ['study', 'work', 'personal', 'health'];
  const catDone = Object.fromEntries(cats.map(c => [c, 0]));
  const catAll = Object.fromEntries(cats.map(c => [c, 0]));
  completed.forEach(t => catDone[t.category] = (catDone[t.category] || 0) + (t.estimatedMinutes || 0));
  inRange.forEach(t => catAll[t.category] = (catAll[t.category] || 0) + (t.estimatedMinutes || 0));
  const maxCat = Math.max(...cats.map(c => catAll[c]), 1);
  $('cat-bars').innerHTML = cats.map(c => {
    const pct = Math.round((catAll[c] / maxCat) * 100);
    const hrs = Math.round(catDone[c] / 6) / 10;
    return `<div class="cat-bar-row"><div class="cat-bar-label"><span class="name" style="display:inline-flex;align-items:center;gap:4px;">${CAT_ICON[c]} ${c}</span><span class="val">${hrs}h</span></div><div class="cat-bar-track"><div class="cat-bar-fill fill-${c}" style="width:${pct}%"></div></div></div>`;
  }).join('');

  // Priority bars
  const priC = { high: 0, medium: 0, low: 0 };
  const priD = { high: 0, medium: 0, low: 0 };
  inRange.forEach(t => { priC[t.priority]++; if (t.completed) priD[t.priority]++; });
  const maxP = Math.max(...Object.values(priC), 1);
  $('priority-bars').innerHTML = ['high', 'medium', 'low'].map(p => {
    const pct = Math.round((priC[p] / maxP) * 100);
    const r2 = priC[p] ? Math.round((priD[p] / priC[p]) * 100) : 0;
    const lbl = p === 'high' ? 'High' : p === 'medium' ? 'Medium' : 'Low';
    return `<div class="priority-bar-row"><div class="priority-bar-label"><span>${lbl}</span><span style="color:var(--text-muted);">${priD[p]}/${priC[p]} (${r2}%)</span></div><div class="cat-bar-track"><div class="priority-arc arc-${p}" style="width:${pct}%"></div></div></div>`;
  }).join('');

  // Heatmap
  const hBuckets = new Array(24).fill(0);
  tasks.filter(t => t.completed && t.completedAt).forEach(t => hBuckets[new Date(t.completedAt).getHours()]++);
  tasks.filter(t => t.completed && t.scheduledTime).forEach(t => { const h = parseInt(t.scheduledTime); if (!isNaN(h)) hBuckets[h] += 0.5; });
  const maxHB = Math.max(...hBuckets, 1);
  const hLbls = ['12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p'];
  $('hour-heatmap').innerHTML = hBuckets.map((v, h) => {
    const intensity = v / maxHB;
    const bg = intensity < 0.05 ? 'var(--border)' : `rgba(${Math.round(124 + intensity * 131)},${Math.round(58 - intensity * 58)},${Math.round(237 - intensity * 100)},${0.2 + intensity * 0.8})`;
    return `<div class="heatmap-cell" style="background:${bg};" data-tip="${hLbls[h]}: ${Math.round(v)} tasks"></div>`;
  }).join('') + `<div style="grid-column:1/-1;display:flex;justify-content:space-between;">${[0, 4, 8, 12, 16, 20, 23].map(h => `<span class="heatmap-hour-label">${hLbls[h]}</span>`).join('')}</div>`;

  // Streak calendar (last 14 days)
  $('streak-big').textContent = appStats.streak;
  if ($('streak-fire')) $('streak-fire').innerHTML = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3.5z"/></svg>`;
  $('streak-sub').textContent = appStats.streak >= 7 ? 'Amazing! Keep going!' : appStats.streak >= 3 ? 'Great momentum!' : 'Complete tasks to build streak';
  const calDays = Array.from({ length: 14 }, (_, i) => addDays(todayStr, -(13 - i)));
  $('streak-calendar').innerHTML = calDays.map(d => {
    const active = tasks.some(t => t.completed && t.deadline === d && !t.recurring?.enabled);
    const isToday = d === todayStr;
    const dow = new Date(d + 'T00:00:00').getDay();
    return `<div class="streak-day ${active ? 'active' : ''} ${isToday ? 'today' : ''}" title="${d}">${DAY_NAMES_SHORT[dow][0]}</div>`;
  }).join('');

  // XP / Level
  const { lvl, next, xpInLevel, xpNeeded, pct: xpPct } = getLevelData(xp);
  $('xp-level-display').innerHTML = `<div class="xp-badge">${lvl.icon}</div><div class="xp-info"><div class="level-num">Level ${lvl.level}</div><div class="level-name">${lvl.name}</div></div><div style="margin-left:auto;font-size:12px;color:var(--purple-l);font-weight:700;">${xp} XP</div>`;
  $('xp-progress-bar').style.width = xpPct + '%';
  $('xp-label').textContent = next ? `${xpInLevel} / ${xpNeeded} XP to Level ${next.level} (${next.name})` : 'Max Level!';

  // Achievements
  const totalDone = tasks.filter(t => !t.recurring?.enabled && t.completed).length;
  const uniqueCats = new Set(tasks.filter(t => t.completed).map(t => t.category)).size;
  const earlyBird = tasks.some(t => t.completed && t.completedAt && new Date(t.completedAt).getHours() < 9);
  $('achievements-grid').innerHTML = ACHIEVEMENTS.map(a => {
    const unlocked = a.check(appStats.streak, totalDone, appStats.totalPomodoros, uniqueCats, earlyBird);
    return `<div class="achievement-item ${unlocked ? 'unlocked' : ''}" title="${a.req}"><span class="achievement-icon">${a.icon}</span><div class="achievement-name">${a.name}</div><div class="achievement-req">${a.req}</div></div>`;
  }).join('');

  renderTrendChart(trendMode);
  renderReminders();
  renderInsights(completed, inRange, hBuckets);
}

function renderTrendChart(mode) {
  trendMode = mode;
  ['week', 'month'].forEach(m => $(`trend-btn-${m}`)?.classList.toggle('active', m === mode));
  const todayStr = today();
  const n = mode === 'week' ? 7 : 30;
  const data = Array.from({ length: n }, (_, i) => {
    const d = addDays(todayStr, -(n - 1 - i));
    const dayTasks = tasks.filter(t => !t.recurring?.enabled && t.deadline === d);
    return { d, done: dayTasks.filter(t => t.completed).length, total: dayTasks.length };
  });

  const chartEl = $('trend-chart');
  if (!chartEl) return;

  const maxV = Math.max(...data.map(b => b.done), 3);
  const svgW = mode === 'week' ? 450 : 650;
  const svgH = 110;
  const paddingX = 20;
  const paddingY = 18;
  const usableW = svgW - paddingX * 2;
  const usableH = svgH - paddingY * 2;

  const points = data.map((item, idx) => {
    const x = paddingX + (idx / (data.length - 1)) * usableW;
    const ratio = item.done / maxV;
    const y = (svgH - paddingY) - ratio * usableH;
    return { x, y, item };
  });

  const linePathD = getSmoothPathD(points);
  const areaPathD = `${linePathD} L ${points[points.length - 1].x},${svgH} L ${points[0].x},${svgH} Z`;

  let svgHtml = `
    <svg viewBox="0 0 ${svgW} ${svgH + 24}" style="width:100%;height:100%;overflow:visible;">
      <defs>
        <linearGradient id="trendGradLine" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="50%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#06b6d4" />
        </linearGradient>
        <linearGradient id="trendGradArea" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.32" />
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      <!-- Reference Grid Lines -->
      <line x1="${paddingX}" y1="${paddingY}" x2="${svgW - paddingX}" y2="${paddingY}" stroke="rgba(186,230,253,0.35)" stroke-dasharray="4 4"/>
      <line x1="${paddingX}" y1="${svgH / 2}" x2="${svgW - paddingX}" y2="${svgH / 2}" stroke="rgba(186,230,253,0.35)" stroke-dasharray="4 4"/>
      <line x1="${paddingX}" y1="${svgH}" x2="${svgW - paddingX}" y2="${svgH}" stroke="rgba(186,230,253,0.6)"/>

      <path d="${areaPathD}" fill="url(#trendGradArea)"/>
      <path d="${linePathD}" fill="none" stroke="url(#trendGradLine)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

      ${points.map((p, idx) => {
    const isToday = p.item.d === todayStr;
    const dObj = new Date(p.item.d + 'T00:00:00');
    const showLabel = mode === 'week' || idx % 5 === 0 || isToday;
    const lblText = mode === 'week' ? DAY_NAMES_SHORT[dObj.getDay()] : dObj.getDate();
    return `
          <g style="cursor:pointer;">
            <circle cx="${p.x}" cy="${p.y}" r="${isToday ? '6' : '3.5'}" fill="${isToday ? '#06b6d4' : '#6366f1'}" stroke="#ffffff" stroke-width="2">
              <title>${p.item.d}: ${p.item.done} completed</title>
            </circle>
            ${showLabel ? `<text x="${p.x}" y="${svgH + 18}" text-anchor="middle" font-size="10" font-weight="${isToday ? '800' : '500'}" fill="${isToday ? '#0284c7' : '#64748b'}">${lblText}</text>` : ''}
          </g>
        `;
  }).join('')}
    </svg>
  `;

  chartEl.innerHTML = svgHtml;
  if ($('trend-labels')) $('trend-labels').style.display = 'none';
}

function switchTrend(mode) { renderTrendChart(mode); }

function renderReminders() {
  const todayStr = today();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const items = [];

  const urgentSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2" style="vertical-align:-2px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  const warnSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" style="vertical-align:-2px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const infoSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2" style="vertical-align:-2px;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

  // Overdue
  tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline && t.deadline < todayStr)
    .slice(0, 3).forEach(t => {
      const diff = Math.ceil((new Date(todayStr + 'T00:00:00') - new Date(t.deadline + 'T00:00:00')) / 86400000);
      items.push({ icon: urgentSvg, text: `<strong>${escHtml(t.title)}</strong> overdue by ${diff}d`, cls: 'urgent', time: 'Overdue' });
    });

  // Starting soon
  tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline === todayStr && t.scheduledTime)
    .forEach(t => {
      const [h, m] = t.scheduledTime.split(':').map(Number);
      const diff = h * 60 + m - nowMin;
      if (diff > 0 && diff <= 60) items.push({ icon: warnSvg, text: `<strong>${escHtml(t.title)}</strong> starts in ${diff}m`, cls: 'warning', time: formatTime(t.scheduledTime) });
      else if (!t.completed && diff <= 0 && diff > -60) items.push({ icon: infoSvg, text: `<strong>${escHtml(t.title)}</strong> should be in progress`, cls: 'info', time: 'Now' });
    });

  // Due today (unscheduled)
  tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline === todayStr && !t.scheduledTime)
    .slice(0, 2).forEach(t => items.push({ icon: infoSvg, text: `<strong>${escHtml(t.title)}</strong> due today`, cls: 'info', time: 'Today' }));

  // Due tomorrow
  tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline === addDays(todayStr, 1))
    .slice(0, 2).forEach(t => items.push({ icon: infoSvg, text: `<strong>${escHtml(t.title)}</strong> due tomorrow`, cls: 'info', time: 'Tomorrow' }));

  // Study reminder
  if (reminderPrefs.studyReminders) {
    const sp = tasks.filter(t => !t.completed && t.category === 'study' && !t.recurring?.enabled);
    if (sp.length >= 3) items.push({ icon: infoSvg, text: `<strong>${sp.length} study tasks</strong> pending. Time to focus!`, cls: 'info', time: 'Reminder' });
  }

  // Streak
  if (reminderPrefs.streakReminders && now.getHours() >= 18) {
    const doneTdy = tasks.some(t => t.completed && t.completedAt && t.completedAt.startsWith(todayStr));
    if (!doneTdy) items.push({ icon: warnSvg, text: `Don't break your streak! Complete a task today.`, cls: 'warning', time: 'Streak Alert' });
  }

  $('reminders-list').innerHTML = items.length
    ? items.slice(0, 6).map(r => `<div class="reminder-item ${r.cls}"><span class="reminder-icon" style="display:inline-flex;align-items:center;">${r.icon}</span><div class="reminder-text">${r.text}<div class="reminder-time">${r.time}</div></div></div>`).join('')
    : `<div class="empty-state" style="padding:20px;"><div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><div class="empty-title">All clear!</div><div class="empty-desc">No reminders right now.</div></div>`;

  $('reminder-prefs').innerHTML = [
    { key: 'deadlineReminders', label: 'Deadline Alerts' },
    { key: 'studyReminders', label: 'Study Reminders' },
    { key: 'streakReminders', label: 'Streak Alerts' },
  ].map(p => `<div class="pref-row"><span>${p.label}</span><div class="toggle-switch" onclick="toggleReminderPref('${p.key}')"><div class="toggle-track ${reminderPrefs[p.key] ? 'on' : ''}"><div class="toggle-thumb"></div></div></div></div>`).join('');
}

function toggleReminderPref(key) {
  reminderPrefs[key] = !reminderPrefs[key];
  DB.save('sf_reminder_prefs', reminderPrefs);
  renderReminders();
}

function renderInsights(completed, inRange, hBuckets) {
  const todayStr = today();
  const range = getAnalyticsRange();
  const maxHB = Math.max(...hBuckets, 1);
  const bestHour = hBuckets.indexOf(Math.max(...hBuckets));
  const hLbls = ['12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm'];
  const avgPerDay = inRange.length ? (completed.length / range).toFixed(1) : '0';
  const catCount = {};
  completed.forEach(t => catCount[t.category] = (catCount[t.category] || 0) + 1);
  const bestCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
  const compH = completed.filter(t => t.completedAt).map(t => new Date(t.completedAt).getHours());
  const avgHour = compH.length ? Math.round(compH.reduce((a, b) => a + b, 0) / compH.length) : null;
  const tw = tasks.filter(t => !t.recurring?.enabled && t.deadline >= addDays(todayStr, -6) && t.deadline <= todayStr);
  const lw = tasks.filter(t => !t.recurring?.enabled && t.deadline >= addDays(todayStr, -13) && t.deadline <= addDays(todayStr, -7));
  const twR = tw.length ? Math.round(tw.filter(t => t.completed).length / tw.length * 100) : 0;
  const lwR = lw.length ? Math.round(lw.filter(t => t.completed).length / lw.length * 100) : 0;
  const rateTrend = twR - lwR;
  const longest = completed.slice().sort((a, b) => (b.estimatedMinutes || 0) - (a.estimatedMinutes || 0))[0];
  const totalFocusH = Math.round(appStats.totalPomodoros * (pomodoroSettings.workMinutes || 25) / 60 * 10) / 10;

  const clockIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0284c7" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const chartIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
  const trophyIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`;

  const ins = [
    { icon: clockIcon, title: 'Peak Focus Hour', value: hBuckets[bestHour] > 0 ? hLbls[bestHour] : 'No data', desc: hBuckets[bestHour] > 0 ? `Most completions at ${hLbls[bestHour]}. Schedule big tasks then!` : 'Complete more tasks to find your peak hour.' },
    { icon: chartIcon, title: 'Avg Tasks/Day', value: `${avgPerDay} tasks`, desc: `You averaged ${avgPerDay} completions/day over ${range} days.` },
    { icon: trophyIcon, title: 'Top Category', value: bestCat ? `${bestCat[0]}` : 'None yet', desc: bestCat ? `${bestCat[1]} ${bestCat[0]} tasks completed.` : 'Start completing tasks!' },
    { icon: chartIcon, title: 'Week vs Last Week', value: `${rateTrend >= 0 ? '+' : ''}${rateTrend}%`, desc: `${twR}% this week vs ${lwR}% last week. ${rateTrend > 0 ? 'Improving!' : rateTrend === 0 ? 'Steady' : 'Keep pushing!'}` },
    { icon: clockIcon, title: 'Avg Completion Time', value: avgHour !== null ? `~${hLbls[avgHour]}` : 'No data', desc: avgHour !== null ? `You typically finish tasks around ${hLbls[avgHour]}.` : 'Complete tasks to see this.' },
    { icon: trophyIcon, title: 'Biggest Task Done', value: longest ? `${longest.estimatedMinutes}m` : 'None', desc: longest ? `"${longest.title.slice(0, 28)}\u2026" \u2014 your longest completion.` : 'No completed tasks yet.' },
    { icon: chartIcon, title: 'High Priority Rate', value: `${completed.filter(t => t.priority === 'high').length} done`, desc: `${inRange.filter(t => t.priority === 'high').length} high-priority tasks in range, ${completed.filter(t => t.priority === 'high').length} completed.` },
    { icon: clockIcon, title: 'Total Focus Time', value: `${totalFocusH}h`, desc: `${appStats.totalPomodoros} Pomodoros \u00D7 ${pomodoroSettings.workMinutes}min = ${totalFocusH}h deep work.` },
  ];

  $('insights-grid').innerHTML = ins.map(i => `<div class="insight-card"><div class="insight-emoji" style="display:flex;align-items:center;">${i.icon}</div><div class="insight-title">${i.title}</div><div class="insight-value">${i.value}</div><div class="insight-desc">${i.desc}</div></div>`).join('');
}

// ── Browser Notifications ─────────────────────────────────────
function requestNotifPermission() {
  if (!('Notification' in window)) { showToast('Notifications not supported', 'error'); return; }
  Notification.requestPermission().then(perm => {
    if (perm === 'granted') { showToast('Reminders enabled!', 'success'); startReminderChecks(); }
    else showToast('Permission denied', 'error');
  });
}

function sendBrowserNotif(title, body) {
  if (Notification.permission === 'granted') new Notification(title, { body });
}

function startReminderChecks() {
  if (reminderCheckInterval) return;
  reminderCheckInterval = setInterval(checkDeadlineNotifications, 60000);
  checkDeadlineNotifications();
}

function checkDeadlineNotifications() {
  if (!reminderPrefs.deadlineReminders) return;
  const todayStr = today();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline === todayStr && t.scheduledTime).forEach(t => {
    const [h, m] = t.scheduledTime.split(':').map(Number);
    const diff = h * 60 + m - nowMin;
    if (diff >= 14 && diff <= 16) sendBrowserNotif('Task Soon', `"${t.title}" starts in 15 minutes`);
  });
  if (new Date().getMinutes() === 0) {
    const ov = tasks.filter(t => !t.completed && !t.recurring?.enabled && t.deadline && t.deadline < todayStr);
    if (ov.length) sendBrowserNotif('Overdue Tasks', `You have ${ov.length} overdue task${ov.length > 1 ? 's' : ''}!`);
  }
}

init();