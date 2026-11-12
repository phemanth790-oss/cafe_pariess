const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ATTENDANCE_START_DATE = '2026-12-10';
const ATTENDANCE_START_MONTH = ATTENDANCE_START_DATE.slice(0, 7);
const state = { user: null, page: 'dashboard', staffStatus: 'active', leaveStaffId: null, attendance: null, report: null, toastTimer: null };
const today = () => {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
};
const monthNow = () => today() < ATTENDANCE_START_DATE ? ATTENDANCE_START_MONTH : today().slice(0, 7);
const fmtDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const monthLabel = value => new Date(`${value}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function showLogin(message = '') {
  state.user = null;
  $('#app-shell').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-error').textContent = message;
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && data?.error === 'Sign in to continue.' && state.user) {
      showLogin('Your session expired. Sign in again.');
    }
    const message = response.status === 404 && !type.includes('application/json')
      ? 'The API route was not found. Check Vercel routing and redeploy from the repository root.'
      : data?.error || data || 'Something went wrong.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}
function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(); }
function showApp() {
  state.user = 'Cafe Paris Team';
  $('#owner-name').textContent = state.user;
  $('#app-shell').classList.remove('hidden');
  $('#login-screen').classList.add('hidden');
  $('#top-date').textContent = new Date(`${today()}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('#attendance-month').min = ATTENDANCE_START_MONTH; $('#report-month').min = ATTENDANCE_START_MONTH;
  $('#attendance-month').value = monthNow(); $('#report-month').value = monthNow();
  navigate('dashboard');
}
function navigate(page) {
  state.page = page;
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('.nav-link').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  if (page === 'dashboard') loadDashboard();
  if (page === 'attendance') loadAttendance();
  if (page === 'staff') loadStaff();
  if (page === 'reports') loadReport();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    $('#stat-staff').textContent = data.totalStaff;
    $('#stat-present').textContent = data.present;
    $('#stat-absent').textContent = data.absent;
    $('#stat-month').textContent = data.monthly.present;
    $('#review-month').textContent = monthLabel(data.month);
    $('#review-present').textContent = data.monthly.present;
    $('#review-absent').textContent = data.monthly.absent;
    $('#review-total').textContent = data.monthly.present + data.monthly.absent;
    $('#launch-banner').classList.toggle('hidden', data.attendanceStarted);
    $('#closed-banner').classList.toggle('hidden', !data.attendanceStarted || !data.shopClosed);
    const staff = await api('/api/staff?status=active');
    const marks = data.shopClosed ? [] : await api(`/api/attendance?month=${data.month}`);
    const markMap = new Map((marks.marks || []).filter(mark => mark.attendance_date === data.today).map(mark => [mark.staff_id, mark.status]));
    const list = $('#today-list');
    if (!staff.length) { list.innerHTML = '<div class="empty-state">No active staff yet. Add your first team member.</div>'; return; }
    list.innerHTML = staff.slice(0, 7).map(person => {
      const status = !data.attendanceStarted ? 'pending' : data.shopClosed ? 'closed' : (markMap.get(person.id) || 'pending');
      const label = !data.attendanceStarted ? 'Starts 10 Dec' : status === 'closed' ? 'Shop closed' : status === 'pending' ? 'Not marked' : status[0].toUpperCase() + status.slice(1);
      return `<div class="today-row"><div class="person-cell"><span class="person-avatar">${esc(initials(person.full_name))}</span><div><div class="person-name">${esc(person.full_name)}</div><div class="person-sub">${esc(person.staff_code)}</div></div></div><span class="pill ${status === 'closed' ? 'pending' : status}">${label}</span></div>`;
    }).join('') + (staff.length > 7 ? `<div class="table-footnote">And ${staff.length - 7} more team members…</div>` : '');
  } catch (error) { toast(error.message, true); }
}

async function loadAttendance() {
  const month = $('#attendance-month').value || monthNow();
  $('#attendance-month').value = month;
  try {
    const data = await api(`/api/attendance?month=${encodeURIComponent(month)}`); state.attendance = data;
    $('#attendance-title').textContent = `${monthLabel(month)} attendance`;
    $('#attendance-count').textContent = `${data.staff.length} staff`;
    const [year, monthNum] = month.split('-').map(Number);
    const days = new Date(year, monthNum, 0).getDate();
    const current = today();
    const isCurrentMonth = month === current.slice(0, 7);
    const header = Array.from({ length: days }, (_, index) => {
      const day = index + 1, date = `${month}-${String(day).padStart(2, '0')}`;
      const weekday = new Date(`${date}T12:00:00`).toLocaleDateString('en', { weekday: 'short' });
      const closed = new Date(`${date}T12:00:00`).getDay() === 1;
      return `<th class="day-cell ${closed ? 'closed' : ''} ${date > current ? 'future' : ''}"><span class="day-head">${day}</span><span class="day-sub">${weekday}</span></th>`;
    }).join('');
    const markMap = new Map(data.marks.map(mark => [`${mark.staff_id}:${mark.attendance_date}`, mark.status]));
    const rows = data.staff.map(person => {
      const cells = Array.from({ length: days }, (_, index) => {
        const day = index + 1, date = `${month}-${String(day).padStart(2, '0')}`;
        const closed = new Date(`${date}T12:00:00`).getDay() === 1;
        const eligible = date >= ATTENDANCE_START_DATE && date >= person.joining_date && (!person.last_working_date || date <= person.last_working_date);
        const future = date > current;
        const status = markMap.get(`${person.id}:${date}`) || '';
        if (closed) return '<td class="day-cell closed" title="Shop closed">—</td>';
        if (!eligible || future) return `<td class="day-cell future" title="${date < ATTENDANCE_START_DATE ? 'Attendance starts 10 Dec 2026' : (!eligible ? 'Outside working period' : 'Future date')}">·</td>`;
        return `<td class="day-cell"><select class="mark-select ${status}" data-staff="${person.id}" data-date="${date}" aria-label="${esc(person.full_name)} ${date}" ${date > current ? 'disabled' : ''}><option value="" ${!status ? 'selected' : ''}>—</option><option value="present" ${status === 'present' ? 'selected' : ''}>Present</option><option value="absent" ${status === 'absent' ? 'selected' : ''}>Absent</option></select></td>`;
      }).join('');
      return `<tr><td><strong>${esc(person.full_name)}</strong><div class="person-sub">${esc(person.staff_code)}</div></td>${cells}</tr>`;
    }).join('');
    $('#attendance-table').innerHTML = data.staff.length ? `<table><thead><tr><th>Employee</th>${header}</tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state">No employees were employed during this month.</div>';
    const mondayToday = new Date(`${current}T12:00:00`).getDay() === 1;
    $('#attendance-closed').classList.toggle('hidden', !(isCurrentMonth && mondayToday));
  } catch (error) { toast(error.message, true); }
}

async function loadStaff() {
  try {
    const staff = await api(`/api/staff?status=${state.staffStatus}`);
    $('#staff-table').innerHTML = staff.length ? `<table><thead><tr><th>Employee</th><th>Staff ID</th><th>Joining date</th><th>${state.staffStatus === 'former' ? 'Last working date' : 'Status'}</th><th>Action</th></tr></thead><tbody>${staff.map(person => `<tr><td><div class="person-cell"><span class="person-avatar">${esc(initials(person.full_name))}</span><strong>${esc(person.full_name)}</strong></div></td><td>${esc(person.staff_code)}</td><td>${fmtDate(person.joining_date)}</td><td>${state.staffStatus === 'former' ? fmtDate(person.last_working_date) : '<span class="pill present">Active</span>'}</td><td>${state.staffStatus === 'active' ? `<button class="table-action" data-leave-id="${person.id}" data-leave-name="${esc(person.full_name)}" data-joining="${person.joining_date}">Mark as former</button>` : '<span class="person-sub">Record retained</span>'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state">No ${state.staffStatus} staff members found.</div>`;
  } catch (error) { toast(error.message, true); }
}

async function loadReport() {
  const month = $('#report-month').value || monthNow(); $('#report-month').value = month;
  try {
    const data = await api(`/api/report?month=${encodeURIComponent(month)}`); state.report = data;
    const totals = data.report.reduce((sum, person) => ({ present: sum.present + person.present, absent: sum.absent + person.absent, closed: sum.closed + person.closed }), { present: 0, absent: 0, closed: 0 });
    $('#report-summary').innerHTML = `<div class="summary-box"><span>Total present marks</span><strong>${totals.present}</strong></div><div class="summary-box"><span>Total absent marks</span><strong>${totals.absent}</strong></div><div class="summary-box"><span>Eligible Monday closures</span><strong>${totals.closed}</strong></div>`;
    $('#report-subtitle').textContent = `Attendance recorded in ${monthLabel(month)}`;
    $('#report-count').textContent = `${data.report.length} employees`;
    $('#report-table').innerHTML = data.report.length ? `<table><thead><tr><th>Employee</th><th>Joining date</th><th>Last working date</th><th>Present</th><th>Absent</th><th>Shop closed</th></tr></thead><tbody>${data.report.map(person => `<tr><td><strong>${esc(person.name)}</strong><div class="person-sub">${esc(person.staffCode)}</div></td><td>${fmtDate(person.joiningDate)}</td><td>${fmtDate(person.lastWorkingDate)}</td><td><span class="pill present">${person.present}</span></td><td><span class="pill absent">${person.absent}</span></td><td>${person.closed}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No staff records found for this month.</div>';
  } catch (error) { toast(error.message, true); }
}

$$('.nav-link').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
$$('[data-goto]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.goto)));
$('#attendance-month').addEventListener('change', loadAttendance);
$('#report-month').addEventListener('change', loadReport);
$('#export-btn').addEventListener('click', () => { const month = $('#report-month').value || monthNow(); window.location.href = `/api/export?month=${encodeURIComponent(month)}`; });

$('#add-staff-open').addEventListener('click', () => { $('#staff-form').reset(); $('#staff-form-error').textContent = ''; $('#staff-form [name="joiningDate"]').removeAttribute('min'); $('#staff-form [name="joiningDate"]').value = ATTENDANCE_START_DATE; $('#staff-modal').classList.remove('hidden'); $('#staff-form [name="fullName"]').focus(); });
$$('[data-close-modal]').forEach(button => button.addEventListener('click', () => $('#staff-modal').classList.add('hidden')));
$('#staff-modal').addEventListener('click', event => { if (event.target === $('#staff-modal')) $('#staff-modal').classList.add('hidden'); });
$('#staff-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget); $('#staff-form-error').textContent = '';
  try { await api('/api/staff', { method: 'POST', body: JSON.stringify({ fullName: form.get('fullName'), joiningDate: form.get('joiningDate'), password: form.get('password') }) }); $('#staff-form').reset(); $('#staff-modal').classList.add('hidden'); toast('Staff member added successfully.'); loadStaff(); }
  catch (error) { $('#staff-form-error').textContent = error.message; }
});
$$('[data-staff-status]').forEach(button => button.addEventListener('click', () => { state.staffStatus = button.dataset.staffStatus; $$('[data-staff-status]').forEach(tab => tab.classList.toggle('active', tab === button)); loadStaff(); }));
$('#staff-table').addEventListener('click', event => {
  const button = event.target.closest('[data-leave-id]'); if (!button) return;
  state.leaveStaffId = button.dataset.leaveId;
  $('#leave-staff-name').textContent = `Set the final working date for ${button.dataset.leaveName}.`;
  $('#leave-form').reset();
  const input = $('#leave-form [name="lastWorkingDate"]'); input.min = button.dataset.joining; input.max = today(); input.value = today(); $('#leave-form-error').textContent = '';
  $('#leave-modal').classList.remove('hidden');
});
$$('[data-close-leave]').forEach(button => button.addEventListener('click', () => $('#leave-modal').classList.add('hidden')));
$('#leave-modal').addEventListener('click', event => { if (event.target === $('#leave-modal')) $('#leave-modal').classList.add('hidden'); });
$('#leave-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = new FormData(event.currentTarget); $('#leave-form-error').textContent = '';
  try { await api(`/api/staff/${state.leaveStaffId}/leave`, { method: 'POST', body: JSON.stringify({ lastWorkingDate: form.get('lastWorkingDate'), password: form.get('password') }) }); $('#leave-form').reset(); $('#leave-modal').classList.add('hidden'); toast('Staff status updated. Existing records were retained.'); loadStaff(); }
  catch (error) { $('#leave-form-error').textContent = error.message; }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: form.get('password') }) });
    $('#login-form').reset();
    showApp();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});
$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    $('#login-form').reset();
    showLogin();
    $('#login-form [name="password"]').focus();
  } catch (error) {
    toast(error.message, true);
  }
});
async function initialize() {
  try {
    await api('/api/session');
    showApp();
  } catch (error) {
    showLogin(error.status === 401 ? '' : error.message);
  }
}
$('#attendance-table').addEventListener('change', async event => {
  const select = event.target.closest('.mark-select'); if (!select) return;
  const previous = select.dataset.previous || '';
  try {
    if (!select.value) {
      await api('/api/attendance', { method: 'DELETE', body: JSON.stringify({ staffId: select.dataset.staff, date: select.dataset.date }) });
      toast('Attendance mark cleared.');
    } else {
      await api('/api/attendance', { method: 'PUT', body: JSON.stringify({ staffId: select.dataset.staff, date: select.dataset.date, status: select.value }) });
      toast(`Marked ${select.value}.`);
    }
    select.className = `mark-select ${select.value}`; select.dataset.previous = select.value;
  } catch (error) { select.value = previous; toast(error.message, true); }
});

initialize();
