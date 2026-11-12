require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ATTENDANCE_START_DATE = '2026-12-10';
const ATTENDANCE_START_MONTH = ATTENDANCE_START_DATE.slice(0, 7);
const SESSION_COOKIE = 'cafe_paris_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
let client;
let connectionPromise;
let indexesPromise;

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeErrorMessage(error) {
  const message = error && error.message ? error.message : 'Unknown error';
  return String(message).replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, '$1[credentials-redacted]@');
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function getCollections() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB;
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri) || !databaseName) {
    throw httpError('Set a valid MONGODB_URI and MONGODB_DB environment variable.', 503);
  }

  if (!connectionPromise) {
    try {
      client = new MongoClient(uri, {
        appName: 'cafe-paris-attendance',
        maxPoolSize: 10,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 8000
      });
    } catch (error) {
      throw httpError('MONGODB_URI is invalid. Check the Atlas connection string.', 503);
    }
    connectionPromise = client.connect()
      .then(() => client.db(databaseName))
      .catch(async error => {
        const failedClient = client;
        client = undefined;
        connectionPromise = undefined;
        console.error('MongoDB connection failed:', safeErrorMessage(error));
        if (failedClient) {
          try {
            await failedClient.close();
          } catch (closeError) {
            console.error('MongoDB connection cleanup failed:', safeErrorMessage(closeError));
          }
        }
        throw httpError('Could not connect to MongoDB Atlas. Check the database URI, user, and network access settings.', 503);
      });
  }

  const database = await connectionPromise;
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      database.collection('staff').createIndex({ staff_code: 1 }, { unique: true }),
      database.collection('staff').createIndex({ status: 1, full_name: 1 }),
      database.collection('attendance').createIndex({ attendance_date: 1 }),
      database.collection('attendance').createIndex({ staff_id: 1, attendance_date: 1 }, { unique: true })
    ]).catch(error => {
      indexesPromise = undefined;
      throw error;
    });
  }
  await indexesPromise;

  return {
    staff: database.collection('staff'),
    attendance: database.collection('attendance'),
    database
  };
}

function staffDto(person) {
  return {
    id: person._id.toString(),
    staff_code: person.staff_code,
    full_name: person.full_name,
    joining_date: person.joining_date,
    last_working_date: person.last_working_date,
    status: person.status,
    created_at: person.created_at
  };
}

function todayIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
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
  return date >= ATTENDANCE_START_DATE &&
    date >= staff.joining_date &&
    (!staff.last_working_date || date <= staff.last_working_date);
}

function validObjectId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function getManagementPassword() {
  const configured = process.env.STAFF_MANAGEMENT_PASSWORD;
  if (typeof configured !== 'string' || configured.length < 16 || configured.startsWith('replace-with-')) {
    throw httpError('Set STAFF_MANAGEMENT_PASSWORD to a unique secret of at least 16 characters.', 503);
  }
  return configured;
}

function managementPasswordMatches(candidate) {
  const configured = getManagementPassword();
  if (typeof candidate !== 'string') return false;
  const expectedBuffer = Buffer.from(configured);
  const candidateBuffer = Buffer.from(candidate);
  return candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer);
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.startsWith('replace-with-') ||
    secret === getManagementPassword()) {
    throw httpError('Set SESSION_SECRET to a unique secret of at least 32 characters.', 503);
  }
  return secret;
}

function sessionSignature(expiresAt) {
  return createHmac('sha256', getSessionSecret())
    .update(`${SESSION_COOKIE}:${getManagementPassword()}:${expiresAt}`)
    .digest('hex');
}

function hasValidSession(req) {
  const cookie = (req.headers.cookie || '').split(';')
    .map(value => value.trim())
    .find(value => value.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return false;
  const [expiresAtValue, signature, ...extra] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
  const expiresAt = Number(expiresAtValue);
  if (extra.length || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
    typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expectedBuffer = Buffer.from(sessionSignature(expiresAt), 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function writeSessionCookie(res, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

function requireAuthentication(req, res, next) {
  try {
    if (!hasValidSession(req)) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' })
});

const staffMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many staff changes. Try again in 15 minutes.' })
});

function requireManagementPassword(req, res, next) {
  try {
    if (!managementPasswordMatches(req.body && req.body.password)) {
      return res.status(401).json({ error: 'The staff management password is incorrect.' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com']
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', asyncRoute(async (req, res) => {
  const { database } = await getCollections();
  await database.command({ ping: 1 });
  res.json({ status: 'ok', database: 'connected' });
}));

app.get('/api/session', (req, res, next) => {
  try {
    if (!hasValidSession(req)) return res.status(401).json({ error: 'Sign in to continue.' });
    res.json({ authenticated: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', loginLimiter, (req, res, next) => {
  try {
    if (!managementPasswordMatches(req.body && req.body.password)) {
      return res.status(401).json({ error: 'The password is incorrect.' });
    }
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    writeSessionCookie(res, `${expiresAt}.${sessionSignature(expiresAt)}`, SESSION_DURATION_MS / 1000);
    res.json({ authenticated: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireAuthentication, (req, res) => {
  writeSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.use('/api', requireAuthentication);

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const { staff, attendance } = await getCollections();
  const today = todayIndia();
  const closed = isMonday(today);
  const month = today < ATTENDANCE_START_DATE ? ATTENDANCE_START_MONTH : today.slice(0, 7);
  const range = monthRange(month);
  const [active, marks, monthRows] = await Promise.all([
    staff.countDocuments({ status: 'active' }),
    closed ? Promise.resolve([]) : attendance.aggregate([
      { $match: { attendance_date: today } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray(),
    attendance.aggregate([
      { $match: { attendance_date: { $gte: range.start, $lte: range.end } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray()
  ]);
  const counts = Object.fromEntries(marks.map(row => [row._id, row.count]));
  const monthly = Object.fromEntries(monthRows.map(row => [row._id, row.count]));
  res.json({
    today,
    attendanceStartDate: ATTENDANCE_START_DATE,
    attendanceStarted: today >= ATTENDANCE_START_DATE,
    totalStaff: active,
    present: today < ATTENDANCE_START_DATE || closed ? 0 : (counts.present || 0),
    absent: closed ? 0 : (counts.absent || 0),
    shopClosed: closed,
    month,
    monthly: { present: monthly.present || 0, absent: monthly.absent || 0 }
  });
}));

app.get('/api/staff', asyncRoute(async (req, res) => {
  const status = req.query.status || 'active';
  if (!['active', 'former'].includes(status)) {
    return res.status(400).json({ error: 'Choose active or former staff.' });
  }
  const { staff } = await getCollections();
  const people = await staff.find({ status })
    .collation({ locale: 'en', strength: 2 })
    .sort({ full_name: 1 })
    .toArray();
  res.json(people.map(staffDto));
}));

app.post('/api/staff', staffMutationLimiter, requireManagementPassword, asyncRoute(async (req, res) => {
  const { fullName, joiningDate } = req.body || {};
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 100 || !validDate(joiningDate)) {
    return res.status(400).json({ error: 'Enter a valid full name and joining date.' });
  }
  const { staff } = await getCollections();
  const person = {
    staff_code: `CP-${Date.now().toString().slice(-8)}-${randomBytes(4).toString('hex').toUpperCase()}`,
    full_name: fullName.trim(),
    joining_date: joiningDate,
    last_working_date: null,
    status: 'active',
    created_at: new Date().toISOString()
  };
  const result = await staff.insertOne(person);
  res.status(201).json(staffDto({ ...person, _id: result.insertedId }));
}));

app.post('/api/staff/:id/leave', staffMutationLimiter, requireManagementPassword, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { lastWorkingDate } = req.body || {};
  if (!validObjectId(id)) return res.status(400).json({ error: 'Invalid staff member.' });
  const { staff } = await getCollections();
  const person = await staff.findOne({ _id: new ObjectId(id), status: 'active' });
  if (!person) return res.status(404).json({ error: 'Active staff member not found.' });
  if (!validDate(lastWorkingDate) || lastWorkingDate < person.joining_date || lastWorkingDate > todayIndia()) {
    return res.status(400).json({ error: 'Last working date must be between the joining date and today.' });
  }
  await staff.updateOne(
    { _id: person._id, status: 'active' },
    { $set: { status: 'former', last_working_date: lastWorkingDate } }
  );
  res.json({ ok: true });
}));

app.get('/api/attendance', asyncRoute(async (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) {
    return res.status(400).json({ error: 'Attendance starts on 10 December 2026. Choose December 2026 or later.' });
  }
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const { staff, attendance } = await getCollections();
  const [people, marks] = await Promise.all([
    staff.find({
      joining_date: { $lte: range.end },
      $or: [{ last_working_date: null }, { last_working_date: { $gte: effectiveStart } }]
    }).collation({ locale: 'en', strength: 2 }).sort({ full_name: 1 }).toArray(),
    attendance.find({
      attendance_date: { $gte: effectiveStart, $lte: range.end }
    }, { projection: { _id: 0, staff_id: 1, attendance_date: 1, status: 1 } }).toArray()
  ]);
  res.json({
    month,
    staff: people.map(staffDto),
    marks,
    today: todayIndia(),
    attendanceStartDate: ATTENDANCE_START_DATE
  });
}));

app.put('/api/attendance', asyncRoute(async (req, res) => {
  const { staffId, date, status } = req.body || {};
  if (!validObjectId(staffId) || !validDate(date) || !['present', 'absent'].includes(status)) {
    return res.status(400).json({ error: 'Invalid attendance details.' });
  }
  if (date < ATTENDANCE_START_DATE) return res.status(400).json({ error: 'Attendance starts on 10 December 2026.' });
  if (date > todayIndia()) return res.status(400).json({ error: 'Future dates cannot be marked.' });
  if (isMonday(date)) return res.status(400).json({ error: 'Monday is a shop-closed day. Attendance cannot be marked.' });
  const { staff, attendance } = await getCollections();
  const person = await staff.findOne({ _id: new ObjectId(staffId) });
  if (!person || !staffCanAttend(person, date)) {
    return res.status(400).json({ error: "This date is outside the employee's working period." });
  }
  await attendance.updateOne(
    { staff_id: staffId, attendance_date: date },
    { $set: { status, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
  res.json({ ok: true });
}));

app.delete('/api/attendance', asyncRoute(async (req, res) => {
  const { staffId, date } = req.body || {};
  if (!validObjectId(staffId) || !validDate(date) || date < ATTENDANCE_START_DATE || date > todayIndia() || isMonday(date)) {
    return res.status(400).json({ error: 'Invalid attendance date or staff member.' });
  }
  const { attendance } = await getCollections();
  await attendance.deleteOne({ staff_id: staffId, attendance_date: date });
  res.json({ ok: true });
}));

app.get('/api/report', asyncRoute(async (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) {
    return res.status(400).json({ error: 'Attendance starts on 10 December 2026. Choose December 2026 or later.' });
  }
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const { staff, attendance } = await getCollections();
  const [people, marks] = await Promise.all([
    staff.find({
      joining_date: { $lte: range.end },
      $or: [{ last_working_date: null }, { last_working_date: { $gte: effectiveStart } }]
    }).collation({ locale: 'en', strength: 2 }).sort({ full_name: 1 }).toArray(),
    attendance.find({
      attendance_date: { $gte: effectiveStart, $lte: range.end }
    }, { projection: { _id: 0, staff_id: 1, attendance_date: 1, status: 1 } }).toArray()
  ]);
  const markMap = new Map(marks.map(mark => [`${mark.staff_id}:${mark.attendance_date}`, mark.status]));
  const days = Number(range.end.slice(-2));
  const report = people.map(person => {
    let present = 0, absent = 0, closed = 0;
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      if (date < ATTENDANCE_START_DATE || date < person.joining_date ||
        (person.last_working_date && date > person.last_working_date)) continue;
      if (isMonday(date)) { closed++; continue; }
      const mark = markMap.get(`${person._id}:${date}`);
      if (mark === 'present') present++;
      else if (mark === 'absent') absent++;
    }
    return {
      staffId: person._id.toString(),
      staffCode: person.staff_code,
      name: person.full_name,
      joiningDate: person.joining_date,
      lastWorkingDate: person.last_working_date,
      present,
      absent,
      closed
    };
  });
  res.json({ month, attendanceStartDate: ATTENDANCE_START_DATE, generatedOn: new Date().toISOString(), report });
}));

app.get('/api/export', asyncRoute(async (req, res) => {
  const month = req.query.month;
  const range = monthRange(month);
  if (!range || range.end < ATTENDANCE_START_DATE) {
    return res.status(400).send('Attendance starts on 10 December 2026. Choose December 2026 or later.');
  }
  const effectiveStart = range.start < ATTENDANCE_START_DATE ? ATTENDANCE_START_DATE : range.start;
  const { staff, attendance } = await getCollections();
  const marks = await attendance.find({
    attendance_date: { $gte: effectiveStart, $lte: range.end }
  }).toArray();
  const staffIds = [...new Set(marks.map(mark => mark.staff_id))]
    .filter(validObjectId)
    .map(id => new ObjectId(id));
  const people = await staff.find({ _id: { $in: staffIds } }).toArray();
  const staffById = new Map(people.map(person => [person._id.toString(), person]));
  const quote = value => {
    const text = String(value ?? '');
      const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };
  const rows = marks
    .filter(mark => staffById.has(mark.staff_id))
    .sort((left, right) => {
      const leftName = staffById.get(left.staff_id).full_name;
      const rightName = staffById.get(right.staff_id).full_name;
      return leftName.localeCompare(rightName, 'en', { sensitivity: 'base' }) ||
        left.attendance_date.localeCompare(right.attendance_date);
    });
  const csv = [
    'Staff ID,Employee,Joining Date,Last Working Date,Date,Status',
    ...rows.map(mark => {
      const person = staffById.get(mark.staff_id);
      return [
        person.staff_code,
        person.full_name,
        person.joining_date,
        person.last_working_date,
        mark.attendance_date,
        mark.status
      ].map(quote).join(',');
    })
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cafe-paris-attendance-${month}.csv"`);
  res.send(`\uFEFF${csv}`);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, req, res, next) => {
  console.error('Request failed:', safeErrorMessage(error));
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.statusCode) ? error.statusCode :
    (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500);
  res.status(status).json({
    error: status >= 500 ? 'An unexpected server error occurred.' : error.message
  });
});

async function start() {
  try {
    await getCollections();
    const server = app.listen(PORT, () => {
      console.log(`Cafe Paris Attendance running at http://localhost:${PORT}`);
    });
    const shutdown = () => {
      server.close(async () => {
        try {
          if (client) await client.close();
          process.exit(0);
        } catch (error) {
          console.error('Shutdown failed:', error);
          process.exit(1);
        }
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Unable to start Cafe Paris Attendance:', safeErrorMessage(error));
    process.exitCode = 1;
  }
}

if (require.main === module) start();

module.exports = app;
