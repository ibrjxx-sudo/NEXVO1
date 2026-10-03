import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scrypt = promisify(scryptCallback);
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = resolve(process.env.NEXVO_DATA_DIR || join(projectRoot, ".data"));
const uploadDirectory = join(dataDirectory, "uploads");
const databasePath = resolve(process.env.NEXVO_DATABASE_PATH || join(dataDirectory, "nexvo.sqlite"));
const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const isProduction = process.env.NODE_ENV === "production";
const cookieName = "nexvo_session";
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const maxJsonBodyBytes = 12 * 1024 * 1024;
const imageTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/x-icon", ".ico"],
  ["image/vnd.microsoft.icon", ".ico"]
]);
const rateBuckets = new Map();

if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
  throw new Error("Set a valid ADMIN_EMAIL before starting NEXVO.");
}
if (adminPassword.length < 14) {
  throw new Error("Set a unique ADMIN_PASSWORD of at least 14 characters before starting NEXVO.");
}
if (sessionSecret.length < 32) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters before starting NEXVO.");
}
if (isProduction && process.env.SESSION_COOKIE_SECURE !== "true") {
  throw new Error("Production requires SESSION_COOKIE_SECURE=true and HTTPS.");
}

mkdirSync(uploadDirectory, { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    email TEXT UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    username TEXT UNIQUE,
    avatar_path TEXT,
    verification_level TEXT,
    account_status TEXT NOT NULL DEFAULT 'active',
    internal_notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brand_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brand_assets (
    slot TEXT PRIMARY KEY,
    asset_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

const defaults = {
  app_name: "NEXVO",
  app_verified: "false",
  show_verified_badge: "true"
};
for (const [key, value] of Object.entries(defaults)) {
  database.prepare("INSERT OR IGNORE INTO brand_settings (key, value) VALUES (?, ?)").run(key, value);
}

const adminSalt = randomBytes(16).toString("hex");
const adminHash = (await scrypt(adminPassword, `${sessionSecret}:${adminSalt}`, 64)).toString("hex");
database.prepare(`
  INSERT INTO users (id, name, email, password_salt, password_hash, role, created_at, last_active)
  VALUES (?, 'NEXVO Administrator', ?, ?, ?, 'super_admin', ?, ?)
  ON CONFLICT(email) DO UPDATE SET password_salt = excluded.password_salt,
    password_hash = excluded.password_hash, role = 'super_admin'
`).run(randomUUID(), adminEmail, adminSalt, adminHash, Date.now(), Date.now());

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body);
}

function securityHeaders(response, contentType = "text/html; charset=utf-8") {
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(cookieHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(token, maxAgeSeconds) {
  const flags = [`${cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (isProduction) flags.push("Secure");
  return flags.join("; ");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function readJson(request, limit = maxJsonBodyBytes) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > limit) {
    const error = new Error("Request body is too large.");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Send a valid JSON request body.");
    error.status = 400;
    throw error;
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
}

function normalizeUsername(username) {
  const value = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (value && !/^[a-z0-9_]{3,24}$/.test(value)) {
    const error = new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
    error.status = 400;
    throw error;
  }
  return value || null;
}

function passwordFromDataUrl(dataUrl, purpose) {
  if (dataUrl == null && purpose === "avatar") return null;
  if (typeof dataUrl !== "string") {
    const error = new Error("An image file is required.");
    error.status = 400;
    throw error;
  }
  const allowedTypes = purpose === "avatar"
    ? "png|jpeg|webp"
    : "png|jpeg|webp|svg\\+xml|x-icon|vnd\\.microsoft\\.icon";
  const match = new RegExp(`^data:(image/(?:${allowedTypes}));base64,([a-zA-Z0-9+/]+={0,2})$`).exec(dataUrl);
  if (!match) {
    const error = new Error(purpose === "avatar"
      ? "Upload a PNG, JPEG, or WEBP image."
      : "Upload a PNG, JPEG, WEBP, SVG, or ICO image.");
    error.status = 415;
    throw error;
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 5 * 1024 * 1024) {
    const error = new Error("The optimized image must be 5 MB or smaller.");
    error.status = 413;
    throw error;
  }
  const signatureChecks = {
    "image/png": bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/webp": bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
    "image/svg+xml": /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096))),
    "image/x-icon": bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1,
    "image/vnd.microsoft.icon": bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1
  };
  if (!signatureChecks[match[1]]) {
    const error = new Error("The image contents do not match its declared image type.");
    error.status = 415;
    throw error;
  }
  return { bytes, mimeType: match[1], extension: match[1] === "image/jpeg" ? ".jpg" : match[1] === "image/webp" ? ".webp" : ".png" };
}

function persistImage(dataUrl, purpose) {
  const image = passwordFromDataUrl(dataUrl, purpose);
  if (!image) return null;
  const filename = `${randomUUID()}${imageTypes.get(image.mimeType) || image.extension}`;
  writeFileSync(join(uploadDirectory, filename), image.bytes, { flag: "wx" });
  return { path: `/uploads/${filename}`, mimeType: image.mimeType };
}

function cleanUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_path,
    role: row.role,
    verificationLevel: row.verification_level,
    accountStatus: row.account_status,
    createdAt: row.created_at,
    lastActive: row.last_active
  };
}

function logAudit(actorId, action, targetId = null, details = {}) {
  database.prepare("INSERT INTO audit_logs (actor_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(actorId, action, targetId, JSON.stringify(details), Date.now());
}

function applyBrand(response) {
  const settings = Object.fromEntries(database.prepare("SELECT key, value FROM brand_settings").all().map((row) => [row.key, row.value]));
  const assets = Object.fromEntries(database.prepare("SELECT slot, asset_path AS path, mime_type AS mimeType FROM brand_assets").all().map((row) => [row.slot, { path: row.path, mimeType: row.mimeType }]));
  sendJson(response, 200, {
    appName: settings.app_name,
    appVerified: settings.app_verified === "true",
    showVerifiedBadge: settings.show_verified_badge !== "false",
    assets
  });
}

function rateLimit(request, response, key, max, windowMs = 60_000) {
  const now = Date.now();
  const bucketKey = `${request.socket.remoteAddress || "unknown"}:${key}`;
  const current = rateBuckets.get(bucketKey);
  if (!current || now - current.start >= windowMs) {
    rateBuckets.set(bucketKey, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  if (current.count <= max) return false;
  sendJson(response, 429, { error: "Too many requests. Try again later." }, { "Retry-After": String(Math.ceil((windowMs - (now - current.start)) / 1000)) });
  return true;
}

function originIsValid(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    const expectedProtocol = isProduction ? "https:" : "http:";
    return parsed.host === host && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function serveFile(response, filename, mimeType, contentSecurityPolicy) {
  securityHeaders(response, mimeType);
  if (contentSecurityPolicy) response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cache-Control", "no-store");
  createReadStream(filename).pipe(response);
}

async function handleRequest(request, response) {
  securityHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204, { Allow: "GET, POST, PATCH, DELETE, OPTIONS" });
    response.end();
    return;
  }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;
  if (pathname.startsWith("/api/") && request.method !== "GET" && !originIsValid(request)) {
    sendJson(response, 403, { error: "Cross-origin request rejected." });
    return;
  }

  if (pathname === "/healthz" && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (pathname === "/api/brand" && request.method === "GET") {
    applyBrand(response);
    return;
  }
  if (pathname === "/api/auth/register" && request.method === "POST") {
    if (rateLimit(request, response, "register", 5)) return;
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const phone = normalizePhone(body.phone);
    const password = String(body.password || "");
    const username = normalizeUsername(body.username);
    if (name.length < 2 || name.length > 48 || phone.replace(/\D/g, "").length < 7 || password.length < 12 || password.length > 256) {
      sendJson(response, 400, { error: "Enter a name, a valid phone number, and a password of at least 12 characters." });
      return;
    }
    const image = persistImage(body.avatarData, "avatar");
    const id = randomUUID();
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, `${sessionSecret}:${salt}`, 64)).toString("hex");
    const now = Date.now();
    try {
      database.prepare(`
        INSERT INTO users (id, name, phone, username, password_salt, password_hash, avatar_path, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, phone, username, salt, hash, image?.path || null, now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendJson(response, 409, { error: "That phone number or username is already registered." });
        return;
      }
      throw error;
    }
    logAudit(id, "user.register", id);
    createSession(response, id);
    sendJson(response, 201, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
    return;
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    if (rateLimit(request, response, "login", 8)) return;
    const body = await readJson(request, 16 * 1024);
    const identifier = String(body.identifier || "").trim().toLowerCase();
    const user = database.prepare("SELECT * FROM users WHERE lower(email) = ? OR phone = ? OR username = ?")
      .get(identifier, normalizePhone(identifier), identifier.replace(/^@/, ""));
    const candidate = String(body.password || "");
    const actualHash = user
      ? Buffer.from(await scrypt(candidate, `${sessionSecret}:${user.password_salt}`, 64))
      : Buffer.from(await scrypt(candidate, `${sessionSecret}:nexvo-invalid-account`, 64));
    const expectedHash = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
    const passwordMatches = actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
    if (!user || !passwordMatches || user.account_status !== "active") {
      sendJson(response, 401, { error: "Invalid credentials or inactive account." });
      return;
    }
    database.prepare("UPDATE users SET last_active = ? WHERE id = ?").run(Date.now(), user.id);
    createSession(response, user.id);
    sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
    return;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookies(request)[cookieName];
    if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    return;
  }

  const user = getSessionUser(request);
  if (pathname === "/api/me" && request.method === "GET") {
    if (!user) {
      sendJson(response, 401, { error: "Authentication required." });
      return;
    }
    sendJson(response, 200, { user: cleanUser(user) });
    return;
  }

  if (pathname === "/api/me" && request.method === "PATCH") {
    if (!user || user.role !== "user") {
      sendJson(response, user ? 403 : 401, { error: user ? "User account required." : "Authentication required." });
      return;
    }
    const body = await readJson(request);
    const name = body.name === undefined ? user.name : String(body.name).trim();
    const username = body.username === undefined ? user.username : normalizeUsername(body.username);
    if (name.length < 2 || name.length > 48) {
      sendJson(response, 400, { error: "Name must be between 2 and 48 characters." });
      return;
    }
    let avatarPath = user.avatar_path;
    if (body.avatarData) avatarPath = persistImage(body.avatarData, "avatar").path;
    try {
      database.prepare("UPDATE users SET name = ?, username = ?, avatar_path = ?, last_active = ? WHERE id = ?")
        .run(name, username, avatarPath, Date.now(), user.id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        sendJson(response, 409, { error: "That username is already in use." });
        return;
      }
      throw error;
    }
    logAudit(user.id, "user.profile.update", user.id);
    sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
    return;
  }

  if (pathname.startsWith("/api/admin/")) {
    if (!user || !["super_admin", "admin"].includes(user.role)) {
      sendJson(response, user ? 403 : 401, { error: "Administrator access required." });
      return;
    }
    if (pathname === "/api/admin/overview" && request.method === "GET") {
      sendJson(response, 200, {
        totalUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user'").get().count,
        activeUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND last_active >= ?").get(Date.now() - 24 * 60 * 60 * 1000).count,
        verifiedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND verification_level IS NOT NULL").get().count,
        suspendedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND account_status = 'suspended'").get().count,
        bannedUsers: database.prepare("SELECT count(*) AS count FROM users WHERE role = 'user' AND account_status = 'banned'").get().count,
        recentActivity: database.prepare(`
          SELECT action, target_id AS targetId, details, created_at AS createdAt
          FROM audit_logs ORDER BY id DESC LIMIT 12
        `).all().map((entry) => ({ ...entry, details: JSON.parse(entry.details) }))
      });
      return;
    }
    if (pathname === "/api/admin/users" && request.method === "GET") {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const perPage = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("perPage") || "20", 10) || 20));
      const search = String(url.searchParams.get("search") || "").trim().slice(0, 100);
      const filter = url.searchParams.get("filter") || "all";
      const filters = {
        all: "",
        verified: "AND verification_level IS NOT NULL",
        unverified: "AND verification_level IS NULL",
        banned: "AND account_status = 'banned'",
        suspended: "AND account_status = 'suspended'",
        active: "AND account_status = 'active'"
      };
      if (!(filter in filters)) {
        sendJson(response, 400, { error: "Unsupported user filter." });
        return;
      }
      const where = `role = 'user' AND (? = '' OR name LIKE ? OR phone LIKE ? OR username LIKE ?) ${filters[filter]}`;
        const searchPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const total = database.prepare(`SELECT count(*) AS count FROM users WHERE ${where}`).get(search, searchPattern, searchPattern, searchPattern).count;
      const orderBy = url.searchParams.get("sort") === "name" ? "name COLLATE NOCASE" : "created_at";
      const direction = url.searchParams.get("direction") === "asc" ? "ASC" : "DESC";
      const users = database.prepare(`
        SELECT * FROM users WHERE ${where} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?
      `).all(search, searchPattern, searchPattern, searchPattern, perPage, (page - 1) * perPage).map(cleanUser);
      sendJson(response, 200, { users, total, page, perPage });
      return;
    }
    if (pathname === "/api/admin/audit" && request.method === "GET") {
      const rows = database.prepare(`
        SELECT audit_logs.id, users.email AS actor, audit_logs.action, audit_logs.target_id AS targetId,
          audit_logs.details, audit_logs.created_at AS createdAt
        FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
        ORDER BY audit_logs.id DESC LIMIT 100
      `).all().map((entry) => ({ ...entry, details: JSON.parse(entry.details) }));
      sendJson(response, 200, { entries: rows });
      return;
    }
    if (pathname === "/api/admin/brand" && request.method === "PATCH") {
      const body = await readJson(request, 32 * 1024);
      const fields = { appName: "app_name", appVerified: "app_verified", showVerifiedBadge: "show_verified_badge" };
      if (!Object.keys(body).length || Object.keys(body).some((key) => !(key in fields))) {
        sendJson(response, 400, { error: "Only appName, appVerified, and showVerifiedBadge can be updated here." });
        return;
      }
      for (const [key, column] of Object.entries(fields)) {
        if (!(key in body)) continue;
        let value;
        if (key === "appName") {
          value = String(body[key]).trim();
          if (value.length < 2 || value.length > 40) {
            sendJson(response, 400, { error: "App name must be between 2 and 40 characters." });
            return;
          }
        } else {
          if (typeof body[key] !== "boolean") {
            sendJson(response, 400, { error: `${key} must be true or false.` });
            return;
          }
          value = String(body[key]);
        }
        database.prepare("INSERT INTO brand_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(column, value);
      }
      logAudit(user.id, "brand.settings.update", null, body);
      applyBrand(response);
      return;
    }
    const assetMatch = pathname.match(/^\/api\/admin\/brand\/assets\/([a-z-]+)$/);
    if (assetMatch && request.method === "POST") {
      const slot = assetMatch[1];
      const supportedSlots = ["logo", "app-icon", "favicon", "default-avatar", "open-graph"];
      if (!supportedSlots.includes(slot)) {
        sendJson(response, 404, { error: "Unknown brand asset slot." });
        return;
      }
      const body = await readJson(request, 10 * 1024 * 1024);
      const image = passwordFromDataUrl(body.dataUrl, "brand");
      if (!image) {
        sendJson(response, 400, { error: "A brand image is required." });
        return;
      }
      const filename = `${randomUUID()}${imageTypes.get(image.mimeType) || image.extension}`;
      writeFileSync(join(uploadDirectory, filename), image.bytes, { flag: "wx" });
      const assetPath = `/uploads/${filename}`;
      database.prepare(`
        INSERT INTO brand_assets (slot, asset_path, mime_type, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET asset_path = excluded.asset_path, mime_type = excluded.mime_type, updated_at = excluded.updated_at
      `).run(slot, assetPath, image.mimeType, Date.now());
      logAudit(user.id, "brand.asset.update", slot, { mimeType: image.mimeType });
      applyBrand(response);
      return;
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
    if (userMatch && request.method === "PATCH") {
      const targetId = userMatch[1];
      const target = database.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(targetId);
      if (!target) {
        sendJson(response, 404, { error: "User not found." });
        return;
      }
      const body = await readJson(request, 32 * 1024);
      const changes = {};
      if ("verificationLevel" in body) {
        const levels = [null, "verified", "business", "official"];
        if (!levels.includes(body.verificationLevel)) {
          sendJson(response, 400, { error: "Unsupported verification level." });
          return;
        }
        changes.verification_level = body.verificationLevel;
      }
      if ("accountStatus" in body) {
        if (!["active", "suspended", "banned"].includes(body.accountStatus)) {
          sendJson(response, 400, { error: "Unsupported account status." });
          return;
        }
        changes.account_status = body.accountStatus;
      }
      if ("internalNotes" in body) {
        const notes = String(body.internalNotes);
        if (notes.length > 2000) {
          sendJson(response, 400, { error: "Administrative notes must be 2,000 characters or less." });
          return;
        }
        changes.internal_notes = notes;
      }
      if (!Object.keys(changes).length) {
        sendJson(response, 400, { error: "No supported account changes were provided." });
        return;
      }
      const columns = Object.keys(changes);
      database.prepare(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
        .run(...Object.values(changes), targetId);
      logAudit(user.id, "admin.user.update", targetId, changes);
      sendJson(response, 200, { user: cleanUser(database.prepare("SELECT * FROM users WHERE id = ?").get(targetId)) });
      return;
    }
    sendJson(response, 404, { error: "Admin endpoint not found." });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API endpoint not found." });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
  };
  if (assets[pathname]) {
    const [filename, mimeType] = assets[pathname];
    serveFile(response, join(projectRoot, filename), mimeType);
    return;
  }
  const uploadMatch = pathname.match(/^\/uploads\/([a-f0-9-]+\.(?:png|jpg|webp|svg|ico))$/i);
  if (uploadMatch) {
    const filename = join(uploadDirectory, uploadMatch[1]);
    const extension = extname(filename).toLowerCase();
    const mimeType = extension === ".jpg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".svg" ? "image/svg+xml" : extension === ".ico" ? "image/x-icon" : "image/png";
    const svgPolicy = extension === ".svg" ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" : undefined;
    serveFile(response, filename, mimeType, svgPolicy);
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function createSession(response, userId) {
  const token = randomBytes(32).toString("base64url");
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(tokenHash(token), userId, Date.now() + sessionDurationMs);
  response.setHeader("Set-Cookie", sessionCookie(token, sessionDurationMs / 1000));
}

function getSessionUser(request) {
  const token = parseCookies(request)[cookieName];
  if (!token || token.length > 128) return null;
  const session = database.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash(token), Date.now());
  return session || null;
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("NEXVO request failed:", error);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendJson(response, status, { error: status === 500 ? "An internal server error occurred." : error.message });
  });
});

function closeServer() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);

if (process.argv[1] && resolve(process.argv[1]) === resolve(projectRoot, "server.mjs")) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(`NEXVO listening on http://${process.env.HOST || "127.0.0.1"}:${port}`);
  });
}

export { server, database };
