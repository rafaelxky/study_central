const SESSION_SECONDS = 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PDF_BYTES = 5_000_000;
const PDF_CHUNK_BYTES = 1_000_000;
const MAX_UNIVERSITY_TOKEN_BYTES = 16 * 1024;
const PASSWORD_ITERATIONS = 50_000;
const CALENDAR_COLORS = new Set([
  "#bda7f5",
  "#f2a6a0",
  "#f2c879",
  "#83c9ad",
  "#83b8e8",
  "#d99bc8",
]);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function noContentResponse(headers = {}) {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...headers } });
}

function fail(status, message) {
  throw new ApiError(status, message);
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    fail(400, "Request body must contain valid JSON.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    fail(413, "Request body is too large.");
  }

  if (!request.body) {
    fail(400, "Request body must contain valid JSON.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      fail(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(400, "Request body must contain valid JSON.");
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "Request body must contain valid JSON.");
  }
}

function database(env) {
  if (!env.DB) {
    fail(503, "Cloudflare D1 database binding is not configured.");
  }
  return env.DB;
}

function timestamp() {
  return Math.floor(Date.now() / 1000);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieToken(request) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === "studyspace_session") {
      const value = valueParts.join("=");
      return value || null;
    }
  }
  return null;
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `studyspace_session=${token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${SESSION_SECONDS}${secure}`;
}

function clearedSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `studyspace_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0${secure}`;
}

async function currentUser(request, db) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return db.prepare(
    `SELECT users.id, users.username, users.email
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, timestamp()).first();
}

async function requireUser(request, db) {
  const user = await currentUser(request, db);
  if (!user) fail(401, "Log in to manage your workspace.");
  return user;
}

async function createSession(db, userId) {
  const token = randomToken();
  const expiresAt = timestamp() + SESSION_SECONDS;
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).bind(await sha256Hex(token), userId, expiresAt).run();
  return token;
}

function characterCount(value) {
  return Array.from(value).length;
}

function validateUsername(value) {
  if (typeof value !== "string") fail(400, "Username must be 2–32 characters and contain no control characters.");
  const length = characterCount(value);
  if (length < 2 || length > 32 || /\p{Cc}/u.test(value)) {
    fail(400, "Username must be 2–32 characters and contain no control characters.");
  }
  return value;
}

function normalizeEmail(value) {
  if (typeof value !== "string") fail(400, "Enter a valid email address.");
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  const local = at < 0 ? "" : email.slice(0, at);
  const domain = at < 0 ? "" : email.slice(at + 1);
  if (
    new TextEncoder().encode(email).byteLength > 254
    || !local
    || !domain.includes(".")
    || /\s/u.test(email)
    || (email.match(/@/g) ?? []).length !== 1
    || domain.startsWith(".")
    || domain.endsWith(".")
  ) {
    fail(400, "Enter a valid email address.");
  }
  return email;
}

function validatePassword(password) {
  if (typeof password !== "string" || characterCount(password) < 8 || characterCount(password) > 128) {
    fail(400, "Password must be between 8 and 128 characters.");
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: PASSWORD_ITERATIONS,
    hash: "SHA-256",
  }, passwordKey, 256));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(digest)}`;
}

async function verifyPassword(password, hash) {
  if (typeof hash !== "string") return false;
  const parts = hash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations !== PASSWORD_ITERATIONS) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = base64UrlDecode(parts[2]);
    expected = base64UrlDecode(parts[3]);
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 32) return false;

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const actual = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations,
    hash: "SHA-256",
  }, passwordKey, 256));
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}

function uniqueConstraint(error, column) {
  return String(error).includes(`UNIQUE constraint failed: ${column}`);
}

async function register(request, db) {
  const body = await readJson(request);
  const username = validateUsername(typeof body.username === "string" ? body.username.trim() : body.username);
  const email = normalizeEmail(body.email);
  validatePassword(body.password);

  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) fail(409, "An account with that email already exists.");

  const user = { id: randomToken(), username, email };
  const token = randomToken();
  const createdAt = timestamp();
  const expiresAt = createdAt + SESSION_SECONDS;
  const passwordHash = await hashPassword(body.password);
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(user.id, username, email, passwordHash, createdAt),
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      ).bind(await sha256Hex(token), user.id, expiresAt),
    ]);
  } catch (error) {
    if (uniqueConstraint(error, "users.email")) {
      fail(409, "An account with that email already exists.");
    }
    throw error;
  }

  return jsonResponse({ user }, 201, { "Set-Cookie": sessionCookie(token, request) });
}

async function login(request, db) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (typeof body.password !== "string" || !body.password || characterCount(body.password) > 128) {
    fail(400, "Email or password is invalid.");
  }

  const row = await db.prepare(
    "SELECT id, username, email, password_hash FROM users WHERE email = ?",
  ).bind(email).first();
  const verified = row
    ? await verifyPassword(body.password, row.password_hash)
    : (await hashPassword(body.password), false);
  if (!row || !verified) fail(401, "Email or password is incorrect.");

  const token = await createSession(db, row.id);
  return jsonResponse({ user: { id: row.id, username: row.username, email: row.email } }, 200, {
    "Set-Cookie": sessionCookie(token, request),
  });
}

async function handleAuth(request, db, parts) {
  const method = request.method;
  if (parts[2] === "register" && method === "POST") return register(request, db);
  if (parts[2] === "login" && method === "POST") return login(request, db);
  if (parts[2] === "me" && method === "GET") {
    return jsonResponse({ user: await currentUser(request, db) });
  }
  if (parts[2] === "logout" && method === "POST") {
    const token = cookieToken(request);
    if (token) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(await sha256Hex(token))
        .run();
    }
    return noContentResponse({ "Set-Cookie": clearedSessionCookie(request) });
  }
  return null;
}

function normalizeShortcutUrl(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 2048) {
    fail(400, "Enter a valid website URL.");
  }
  const value = input.trim();
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    fail(400, "Enter a valid website URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || !url.hostname
    || url.port
  ) {
    fail(400, "Only public HTTP or HTTPS website URLs are supported.");
  }
  url.hash = "";
  return url.href;
}

async function listShortcuts(request, db) {
  const user = await requireUser(request, db);
  const result = await db.prepare(
    "SELECT id, name, url, icon_data FROM shortcuts WHERE user_id = ? ORDER BY created_at, id",
  ).bind(user.id).all();
  return jsonResponse({ shortcuts: result.results });
}

async function createShortcut(request, db) {
  const user = await requireUser(request, db);
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || characterCount(name) > 64 || /\p{Cc}/u.test(name)) {
    fail(400, "Name must be between 1 and 64 characters.");
  }
  const url = normalizeShortcutUrl(body.url);
  const id = randomToken();
  const createdAt = timestamp();
  try {
    await db.prepare(
      `INSERT INTO shortcuts (id, user_id, name, url, icon_data, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).bind(id, user.id, name, url, createdAt).run();
  } catch (error) {
    if (uniqueConstraint(error, "shortcuts.user_id, shortcuts.url")) {
      fail(409, "That URL is already in your shortcuts.");
    }
    throw error;
  }
  return jsonResponse({
    shortcut: { id, name, url, icon_data: null },
  }, 201);
}

async function deleteOwned(request, db, table, id, label) {
  const user = await requireUser(request, db);
  const result = await db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`)
    .bind(id, user.id)
    .run();
  if (result.meta.changes === 0) fail(404, `${label} not found.`);
  return noContentResponse();
}

function validateNote(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!title || characterCount(title) > 120 || /\p{Cc}/u.test(title)) {
    fail(400, "Note title must be between 1 and 120 characters.");
  }
  if (characterCount(content) > 50_000) {
    fail(400, "Note content must be 50,000 characters or fewer.");
  }
  if (typeof body.pinned !== "boolean") fail(400, "Note pin state is invalid.");
  return { title, content, pinned: body.pinned };
}

function pdfFilename(request) {
  const encoded = request.headers.get("x-file-name");
  if (!encoded) fail(400, "Choose a valid PDF filename.");
  let filename;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    fail(400, "Choose a valid PDF filename.");
  }
  const length = Array.from(filename).length;
  if (
    length < 1
    || length > 128
    || new TextEncoder().encode(filename).length > 255
    || !filename.toLowerCase().endsWith(".pdf")
    || /[\p{Cc}/\\]/u.test(filename)
  ) {
    fail(400, "Choose a valid PDF filename.");
  }
  return filename;
}

async function readPdfBody(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    fail(400, "Upload must be a PDF file.");
  }
  if (!request.body) fail(400, "Upload must contain a PDF file.");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      fail(413, "PDFs cannot be larger than 5 MB.");
    }
    chunks.push(value);
  }
  if (total === 0) fail(400, "Upload must contain a PDF file.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    fail(400, "The uploaded file is not a valid PDF.");
  }
  return bytes;
}

async function listPdfs(request, db) {
  const user = await requireUser(request, db);
  const result = await db.prepare(
    `SELECT id, filename, size_bytes, uploaded_at
     FROM pdfs WHERE user_id = ? ORDER BY uploaded_at DESC, id`,
  ).bind(user.id).all();
  return jsonResponse({ pdfs: result.results });
}

async function uploadPdf(request, db) {
  const user = await requireUser(request, db);
  const filename = pdfFilename(request);
  const content = await readPdfBody(request);
  const id = randomToken();
  const uploadedAt = timestamp();
  const statements = [
    db.prepare(
      `INSERT INTO pdfs (id, user_id, filename, content, size_bytes, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, user.id, filename, new Uint8Array(0), content.byteLength, uploadedAt),
  ];
  for (let offset = 0, chunkIndex = 0; offset < content.byteLength; offset += PDF_CHUNK_BYTES, chunkIndex += 1) {
    statements.push(db.prepare(
      "INSERT INTO pdf_chunks (pdf_id, chunk_index, content) VALUES (?, ?, ?)",
    ).bind(id, chunkIndex, content.subarray(offset, Math.min(offset + PDF_CHUNK_BYTES, content.byteLength))));
  }
  await db.batch(statements);
  return jsonResponse({
    pdf: { id, filename, size_bytes: content.byteLength, uploaded_at: uploadedAt },
  }, 201);
}

function encodePdfFilename(filename) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function getPdfFile(request, db, id) {
  const user = await requireUser(request, db);
  const row = await db.prepare(
    "SELECT filename, content, size_bytes FROM pdfs WHERE id = ? AND user_id = ?",
  ).bind(id, user.id).first();
  if (!row) fail(404, "PDF not found.");
  let content = row.content;
  if (content.byteLength === 0) {
    const result = await db.prepare(
      "SELECT content FROM pdf_chunks WHERE pdf_id = ? ORDER BY chunk_index",
    ).bind(id).all();
    const chunks = result.results.map((chunk) => chunk.content);
    const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (totalBytes !== row.size_bytes || chunks.length === 0) {
      throw new Error(`PDF ${id} has missing or incomplete stored content.`);
    }
    content = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const disposition = new URL(request.url).searchParams.get("download") === "1"
    ? "attachment"
    : "inline";
  const filename = encodePdfFilename(row.filename);
  return new Response(content, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `${disposition}; filename="document.pdf"; filename*=UTF-8''${filename}`,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function listNotes(request, db) {
  const user = await requireUser(request, db);
  const result = await db.prepare(
    `SELECT id, title, content, pinned, updated_at FROM notes
     WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC, id`,
  ).bind(user.id).all();
  return jsonResponse({
    notes: result.results.map((note) => ({ ...note, pinned: Boolean(note.pinned) })),
  });
}

async function saveNote(request, db, id = null) {
  const user = await requireUser(request, db);
  const body = await readJson(request);
  const note = validateNote(body);
  const noteId = id ?? randomToken();
  const updatedAt = timestamp();
  if (id) {
    const result = await db.prepare(
      `UPDATE notes SET title = ?, content = ?, pinned = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(note.title, note.content, Number(note.pinned), updatedAt, id, user.id).run();
    if (result.meta.changes === 0) fail(404, "Note not found.");
  } else {
    await db.prepare(
      `INSERT INTO notes (id, user_id, title, content, pinned, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(noteId, user.id, note.title, note.content, Number(note.pinned), updatedAt).run();
  }
  return jsonResponse({
    note: { id: noteId, ...note, updated_at: updatedAt },
  }, id ? 200 : 201);
}

function validateTaskText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || characterCount(text) > 300 || /\p{Cc}/u.test(text)) {
    fail(400, "Task must be between 1 and 300 characters.");
  }
  return text;
}

async function listTasks(request, db) {
  const user = await requireUser(request, db);
  const result = await db.prepare(
    `SELECT id, text, completed, created_at FROM tasks
     WHERE user_id = ? ORDER BY completed, created_at DESC, id`,
  ).bind(user.id).all();
  return jsonResponse({
    tasks: result.results.map((task) => ({ ...task, completed: Boolean(task.completed) })),
  });
}

async function createTask(request, db) {
  const user = await requireUser(request, db);
  const body = await readJson(request);
  const text = validateTaskText(body.text);
  const task = { id: randomToken(), text, completed: false, created_at: timestamp() };
  await db.prepare(
    "INSERT INTO tasks (id, user_id, text, completed, created_at) VALUES (?, ?, ?, 0, ?)",
  ).bind(task.id, user.id, text, task.created_at).run();
  return jsonResponse({ task }, 201);
}

async function updateTask(request, db, id) {
  const user = await requireUser(request, db);
  const body = await readJson(request);
  if (typeof body.completed !== "boolean") fail(400, "Task completion state is invalid.");
  const result = await db.prepare(
    "UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?",
  ).bind(Number(body.completed), id, user.id).run();
  if (result.meta.changes === 0) fail(404, "Task not found.");
  const task = await db.prepare(
    "SELECT id, text, completed, created_at FROM tasks WHERE id = ? AND user_id = ?",
  ).bind(id, user.id).first();
  if (!task) fail(404, "Task not found.");
  return jsonResponse({ task: { ...task, completed: Boolean(task.completed) } });
}

function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1];
}

function normalizeCalendarTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    fail(400, "Enter a valid calendar time.");
  }
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) fail(400, "Enter a valid calendar time.");
  return value;
}

function validateCalendarEvent(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description : "";
  if (!title || characterCount(title) > 120 || /\p{Cc}/u.test(title)) {
    fail(400, "Calendar title must be between 1 and 120 characters.");
  }
  if (characterCount(description) > 4000) {
    fail(400, "Calendar description must be 4,000 characters or fewer.");
  }
  if (!CALENDAR_COLORS.has(body.color)) fail(400, "Choose a supported calendar color.");
  if (!["event", "class"].includes(body.event_type)) {
    fail(400, "Calendar item type must be event or class.");
  }
  if (
    !["once", "weekly"].includes(body.schedule)
    || (body.event_type === "event" && body.schedule !== "once")
    || (body.event_type === "class" && body.schedule !== "weekly")
  ) {
    fail(400, "Events must be one-day items and classes must repeat weekly.");
  }
  if (!Number.isInteger(body.reminder_days) || body.reminder_days < 0 || body.reminder_days > 30) {
    fail(400, "Calendar reminders can be set up to 30 days before.");
  }

  let eventDate = null;
  let startDate = null;
  let endDate = null;
  let weekdays = [];
  if (body.schedule === "once") {
    if (!isCalendarDate(body.event_date)) fail(400, "Choose a valid date for this event.");
    eventDate = body.event_date;
  } else {
    if (!isCalendarDate(body.start_date)) fail(400, "Choose a valid class start date.");
    if (!isCalendarDate(body.end_date)) fail(400, "Choose a valid class end date.");
    if (body.end_date < body.start_date) {
      fail(400, "Class end date must be on or after its start date.");
    }
    if (!Array.isArray(body.weekdays)) {
      fail(400, "Choose at least one valid weekday for this class.");
    }
    weekdays = [...new Set(body.weekdays)].sort((a, b) => a - b);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      fail(400, "Choose at least one valid weekday for this class.");
    }
    startDate = body.start_date;
    endDate = body.end_date;
  }

  const startTime = normalizeCalendarTime(body.start_time);
  const endTime = normalizeCalendarTime(body.end_time);
  if (
    (startTime === null) !== (endTime === null)
    || (startTime !== null && startTime >= endTime)
  ) {
    fail(400, "Provide a valid start and end time, with the end later than the start.");
  }

  return {
    title,
    description,
    color: body.color,
    event_type: body.event_type,
    schedule: body.schedule,
    event_date: eventDate,
    start_date: startDate,
    end_date: endDate,
    weekdays,
    start_time: startTime,
    end_time: endTime,
    reminder_days: body.reminder_days,
  };
}

function calendarEventFromRow(row) {
  let weekdays;
  try {
    weekdays = JSON.parse(row.weekdays);
  } catch {
    fail(500, "Stored calendar data is invalid.");
  }
  if (!Array.isArray(weekdays)) fail(500, "Stored calendar data is invalid.");
  return { ...row, weekdays, reminder_days: Number(row.reminder_days) };
}

async function listCalendarEvents(request, db) {
  const user = await requireUser(request, db);
  const result = await db.prepare(
    `SELECT id, title, description, color, event_type, schedule, event_date,
            start_date, end_date, weekdays, start_time, end_time, reminder_days
     FROM calendar_events
     WHERE user_id = ?
     ORDER BY COALESCE(event_date, start_date), title`,
  ).bind(user.id).all();
  return jsonResponse({ events: result.results.map(calendarEventFromRow) });
}

async function saveCalendarEvent(request, db, id = null) {
  const user = await requireUser(request, db);
  const event = validateCalendarEvent(await readJson(request));
  const eventId = id ?? randomToken();
  const values = [
    event.title,
    event.description,
    event.color,
    event.event_type,
    event.schedule,
    event.event_date,
    event.start_date,
    event.end_date,
    JSON.stringify(event.weekdays),
    event.start_time,
    event.end_time,
    event.reminder_days,
  ];

  if (id) {
    const result = await db.prepare(
      `UPDATE calendar_events SET title = ?, description = ?, color = ?, event_type = ?,
       schedule = ?, event_date = ?, start_date = ?, end_date = ?, weekdays = ?,
       start_time = ?, end_time = ?, reminder_days = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(...values, id, user.id).run();
    if (result.meta.changes === 0) fail(404, "Calendar event not found.");
  } else {
    await db.prepare(
      `INSERT INTO calendar_events
       (id, user_id, title, description, color, event_type, schedule, event_date,
        start_date, end_date, weekdays, start_time, end_time, reminder_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(eventId, user.id, ...values).run();
  }
  return jsonResponse({ event: { id: eventId, ...event } }, id ? 200 : 201);
}

function hexToBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function tokenEncryptionKey(env) {
  if (!env.JWT_ENCRYPTION_KEY) return null;
  const keyBytes = hexToBytes(env.JWT_ENCRYPTION_KEY);
  if (!keyBytes) fail(500, "JWT_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
}

function validateUniversityToken(token) {
  if (typeof token !== "string" || new TextEncoder().encode(token).byteLength > MAX_UNIVERSITY_TOKEN_BYTES) {
    fail(400, "University token must be 16 KB or smaller.");
  }
  if (!token) fail(400, "University token cannot be empty.");
  if (/[\s\p{Cc}]/u.test(token)) {
    fail(400, "University token must not contain whitespace or control characters.");
  }
}

async function universityTokenStatus(request, db, env, user, method) {
  const key = await tokenEncryptionKey(env);
  if (method === "GET") {
    const row = await db.prepare(
      "SELECT updated_at FROM university_tokens WHERE user_id = ?",
    ).bind(user.id).first();
    return jsonResponse({
      enabled: key !== null,
      saved: row !== null,
      updated_at: row?.updated_at ?? null,
    });
  }
  if (method === "DELETE") {
    await db.prepare("DELETE FROM university_tokens WHERE user_id = ?").bind(user.id).run();
    return jsonResponse({ enabled: key !== null, saved: false, updated_at: null });
  }
  if (method !== "PUT") return null;
  if (!key) fail(503, "University token storage is not configured on the backend.");

  const body = await readJson(request);
  validateUniversityToken(body.token);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(body.token.trim()),
  ));
  const updatedAt = timestamp();
  await db.prepare(
    `INSERT INTO university_tokens (user_id, nonce, ciphertext, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       updated_at = excluded.updated_at`,
  ).bind(user.id, base64Url(nonce), base64Url(encrypted), updatedAt).run();
  return jsonResponse({ enabled: true, saved: true, updated_at: updatedAt });
}

async function routeApi(request, env) {
  try {
    const db = database(env);
    const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method;
    let response = null;

    if (parts[1] === "auth") {
      response = await handleAuth(request, db, parts);
    } else if (parts.length === 2 && parts[1] === "pdfs") {
      if (method === "GET") response = await listPdfs(request, db);
      if (method === "POST") response = await uploadPdf(request, db);
    } else if (parts.length === 3 && parts[1] === "pdfs" && method === "DELETE") {
      response = await deleteOwned(request, db, "pdfs", parts[2], "PDF");
    } else if (parts.length === 4 && parts[1] === "pdfs" && parts[3] === "file" && method === "GET") {
      response = await getPdfFile(request, db, parts[2]);
    } else if (parts.length === 2 && parts[1] === "shortcuts") {
      if (method === "GET") response = await listShortcuts(request, db);
      if (method === "POST") response = await createShortcut(request, db);
    } else if (parts.length === 3 && parts[1] === "shortcuts" && method === "DELETE") {
      response = await deleteOwned(request, db, "shortcuts", parts[2], "Shortcut");
    } else if (parts.length === 2 && parts[1] === "notes") {
      if (method === "GET") response = await listNotes(request, db);
      if (method === "POST") response = await saveNote(request, db);
    } else if (parts.length === 3 && parts[1] === "notes") {
      if (method === "PUT") response = await saveNote(request, db, parts[2]);
      if (method === "DELETE") response = await deleteOwned(request, db, "notes", parts[2], "Note");
    } else if (parts.length === 2 && parts[1] === "tasks") {
      if (method === "GET") response = await listTasks(request, db);
      if (method === "POST") response = await createTask(request, db);
    } else if (parts.length === 3 && parts[1] === "tasks") {
      if (method === "PATCH") response = await updateTask(request, db, parts[2]);
      if (method === "DELETE") response = await deleteOwned(request, db, "tasks", parts[2], "Task");
    } else if (parts.length === 3 && parts[1] === "calendar" && parts[2] === "events") {
      if (method === "GET") response = await listCalendarEvents(request, db);
      if (method === "POST") response = await saveCalendarEvent(request, db);
    } else if (parts.length === 4 && parts[1] === "calendar" && parts[2] === "events") {
      if (method === "PUT") response = await saveCalendarEvent(request, db, parts[3]);
      if (method === "DELETE") {
        response = await deleteOwned(request, db, "calendar_events", parts[3], "Calendar event");
      }
    } else if (
      parts.length === 4
      && parts[1] === "integrations"
      && parts[2] === "university"
      && parts[3] === "token"
    ) {
      const user = await requireUser(request, db);
      response = await universityTokenStatus(request, db, env, user, method);
    }

    if (response) return response;
    return jsonResponse({ error: "API endpoint not found." }, 404);
  } catch (error) {
    if (error instanceof ApiError) return jsonResponse({ error: error.message }, error.status);
    console.error("Cloudflare Worker API request failed.", error);
    return jsonResponse({ error: "An internal server error occurred." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return routeApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
