const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.STAFF_MANAGEMENT_PASSWORD = 'test-only-password-for-cafe-paris';
process.env.SESSION_SECRET = 'test-only-session-signing-secret-for-cafe-paris';
process.env.NODE_ENV = 'production';
process.env.MONGODB_URI = '';
process.env.MONGODB_DB = '';

const app = require('../server');

test('sign-in protects app APIs and staff changes require the password again', async t => {
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });

  let response = await fetch(`${base}/api/session`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/dashboard`);
  assert.equal(response.status, 401);

  response = await post('/api/login', { password: 'not-the-password' });
  assert.equal(response.status, 401);
  response = await post('/api/login', { password: process.env.STAFF_MANAGEMENT_PASSWORD });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];

  response = await fetch(`${base}/api/session`, { headers: { cookie } });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/staff?status=invalid`, { headers: { cookie } });
  assert.equal(response.status, 400);

  response = await post('/api/staff', { fullName: 'Test', joiningDate: '2026-12-10' }, cookie);
  assert.equal(response.status, 401);
  response = await post('/api/staff', {
    fullName: '',
    joiningDate: '2026-12-10',
    password: process.env.STAFF_MANAGEMENT_PASSWORD
  }, cookie);
  assert.equal(response.status, 400);

  response = await post('/api/staff/not-an-id/leave', {
    lastWorkingDate: '2026-11-12',
    password: process.env.STAFF_MANAGEMENT_PASSWORD
  }, cookie);
  assert.equal(response.status, 400);

  response = await post('/api/logout', {}, cookie);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  response = await fetch(`${base}/api/session`);
  assert.equal(response.status, 401);
});
