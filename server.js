require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
// First day the Cafe Paris attendance system may record attendance.
const ATTENDANCE_START_DATE = '2026-12-10';
const ATTENDANCE_START_MONTH = ATTENDANCE_START_DATE.slice(0, 7);
const isProduction = process.env.NODE_ENV === 'production';
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
if (isProduction && process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

const db = new Database(path.join(dataDir, 'cafe-paris.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_code TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    joining_date TEXT NOT NULL,
    last_working_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','former')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    attendance_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','absent')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(staff_id, attendance_date)
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);
  CREATE INDEX IF NOT EXISTS idx_attendance_staff_date ON attendance(staff_id, attendance_date);
`);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

function todayIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isMonday(dateString) {
  return new Date(`${dateString}T12:00:00`).getDay() === 1;
}
function monthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) return null;
  const endDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(endDay).padStart(2, '0')}` };
}
function staffCanAttend(staff, date) {
  return date >= ATTENDANCE_START_DATE && date >= staff.joining_date && (!staff.last_working_date || date <= staff.last_working_date);
}
app.get('/api/dashboard', (req, res) => {
  const today = todayIndia();
  const active = db.prepare("SELECT COUNT(*) AS count FROM staff WHERE status='active'").get().count;
  const closed = isMonday(today);
  const marks = closed ? [] : db.prepare('SELECT status, COUNT(*) AS count FROM attendance WHERE attendance_date=? GROUP BY status').all(today);
  const counts = Object.fromEntries(marks.map(row => [row.status, row.count]));
  const month = today < ATTENDANCE_START_DATE ? ATTENDANCE_START_MONTH : today.slice(0, 7);
  const range = monthRange(month);
  const monthRows = db.prepare('SELECT status, COUNT(*) AS count FROM attendance WHERE attendance_date BETWEEN ? AND ? GROUP BY status').all(range.start, range.end);
  const monthly = Object.fromEntries(monthRows.map(row => [row.status, row.count]));
  res.json({
    today, attendanceStartDate: ATTENDANCE_START_DATE, attendanceStarted: today >= ATTENDANCE_START_DATE,
    totalStaff: active, present: today < ATTENDANCE_START_DATE || closed ? 0 : (counts.present || 0),
    absent: closed ? 0 : (counts.absent || 0), shopClosed: closed, month,
    monthly: { present: monthly.present || 0, absent: monthly.absent || 0 }
  });
});

app.get('/api/staff', (req, res) => {
  const status = req.query.status === 'former' ? 'former' : 'active';
  res.json(db.prepare('SELECT * FROM staff WHERE status=? ORDER BY full_name COLLATE NOCASE').all(status));
});
app.post('/api/staff', (req, res) => {
  const { fullName, joiningDate } = req.body || {};
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 100 || !validDate(joiningDate)) {
    return res.status(400).json({ error: 'Enter a valid full name and joining date.' });
  }
  // Future joining dates are allowed so staff profiles can be prepared before launch.
  const staffCode = `CP-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 900 + 100)}`;
  try {
    const result = db.prepare('INSERT INTO staff(staff_code, full_name, joining_date) VALUES(?, ?, ?)')
      .run(staffCode, fullName.trim(), joiningDate);
    res.status(201).json(db.prepare('SELECT * FROM staff WHERE id=?').get(result.lastInsertRowid));
  } catch (error) {
    console.error('Add staff failed:', error.message);
    res.status(500).json({ error: 'Could not add staff member.' });
  }
});
app.post('/api/staff/:id/leave', (req, res) => {
  const id = Number(req.params.id);
  const { lastWorkingDate } = req.body || {};
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid staff member.' });
  const staff = db.prepare("SELECT * FROM staff WHERE id=? AND status='active'").get(id);
  if (!staff) return res.status(404).json({ error: 'Active staff member not found.' });
  if (!validDate(lastWorkingDate) || lastWorkingDate < staff.joining_date || lastWorkingDate > todayIndia()) {
    return res.status(400).json({ error: 'Last working date must be between the joining date and today.' });
  }
  db.prepare("UPDATE staff SET status='former', last_working_date=? WHERE id=?").run(lastWorkingDate, id);
  res.json({ ok: true });
});

app.get('/api/attendance', (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) return res.status(400).json({ error: 'Attendance starts on 10 December 2026. Choose December 2026 or later.' });
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const staff = db.prepare("SELECT * FROM staff WHERE joining_date<=? AND (last_working_date IS NULL OR last_working_date>=?) ORDER BY full_name COLLATE NOCASE").all(range.end, effectiveStart);
  const marks = db.prepare('SELECT staff_id, attendance_date, status FROM attendance WHERE attendance_date BETWEEN ? AND ?').all(effectiveStart, range.end);
  res.json({ month, staff, marks, today: todayIndia(), attendanceStartDate: ATTENDANCE_START_DATE });
});
app.put('/api/attendance', (req, res) => {
  const { staffId, date, status } = req.body || {};
  const id = Number(staffId);
  if (!Number.isSafeInteger(id) || id < 1 || !validDate(date) || !['present', 'absent'].includes(status)) {
    return res.status(400).json({ error: 'Invalid attendance details.' });
  }
  if (date < ATTENDANCE_START_DATE) return res.status(400).json({ error: 'Attendance starts on 10 December 2026.' });
  if (date > todayIndia()) return res.status(400).json({ error: 'Future dates cannot be marked.' });
  if (isMonday(date)) return res.status(400).json({ error: 'Monday is a shop-closed day. Attendance cannot be marked.' });
  const staff = db.prepare('SELECT * FROM staff WHERE id=?').get(id);
  if (!staff || !staffCanAttend(staff, date)) return res.status(400).json({ error: "This date is outside the employee's working period." });
  db.prepare(`INSERT INTO attendance(staff_id, attendance_date, status, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(staff_id, attendance_date) DO UPDATE SET status=excluded.status, updated_at=CURRENT_TIMESTAMP`)
    .run(id, date, status);
  res.json({ ok: true });
});
app.delete('/api/attendance', (req, res) => {
  const { staffId, date } = req.body || {};
  const id = Number(staffId);
  if (!Number.isSafeInteger(id) || id < 1 || !validDate(date) || date < ATTENDANCE_START_DATE || date > todayIndia() || isMonday(date)) {
    return res.status(400).json({ error: 'Invalid attendance date or staff member.' });
  }
  db.prepare('DELETE FROM attendance WHERE staff_id=? AND attendance_date=?').run(id, date);
  res.json({ ok: true });
});

app.get('/api/report', (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) return res.status(400).json({ error: 'Attendance starts on 10 December 2026. Choose December 2026 or later.' });
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const staff = db.prepare("SELECT * FROM staff WHERE joining_date<=? AND (last_working_date IS NULL OR last_working_date>=?) ORDER BY full_name COLLATE NOCASE").all(range.end, effectiveStart);
  const marks = db.prepare('SELECT staff_id, attendance_date, status FROM attendance WHERE attendance_date BETWEEN ? AND ?').all(effectiveStart, range.end);
  const markMap = new Map(marks.map(mark => [`${mark.staff_id}:${mark.attendance_date}`, mark.status]));
  const days = Number(range.end.slice(-2));
  const report = staff.map(person => {
    let present = 0, absent = 0, closed = 0;
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      if (date < ATTENDANCE_START_DATE || date < person.joining_date || (person.last_working_date && date > person.last_working_date)) continue;
      if (isMonday(date)) { closed++; continue; }
      const mark = markMap.get(`${person.id}:${date}`);
      if (mark === 'present') present++;
      else if (mark === 'absent') absent++;
    }
    return { staffId: person.id, staffCode: person.staff_code, name: person.full_name,
      joiningDate: person.joining_date, lastWorkingDate: person.last_working_date, present, absent, closed };
  });
  res.json({ month, attendanceStartDate: ATTENDANCE_START_DATE, generatedOn: new Date().toISOString(), report });
});
app.get('/api/export', (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) return res.status(400).send('Attendance starts on 10 December 2026. Choose December 2026 or later.');
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const rows = db.prepare(`SELECT s.staff_code, s.full_name, s.joining_date, s.last_working_date, a.attendance_date, a.status
    FROM attendance a JOIN staff s ON s.id=a.staff_id
    WHERE a.attendance_date BETWEEN ? AND ? ORDER BY s.full_name COLLATE NOCASE, a.attendance_date`).all(effectiveStart, range.end);
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = ['Staff ID,Employee,Joining Date,Last Working Date,Date,Status',
    ...rows.map(row => [row.staff_code, row.full_name, row.joining_date, row.last_working_date, row.attendance_date, row.status].map(quote).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cafe-paris-attendance-${month}.csv"`);
  res.send(`\uFEFF${csv}`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const server = app.listen(PORT, () => console.log(`Cafe Paris Attendance running at http://localhost:${PORT}`));
function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
