import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminPassword = "test-only-unique-password-29";
const sessionSecret = "test-session-secret-random-value-123456789";
let child;
let baseUrl;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "nexvo-server-test-"));
  const socket = createTcpServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ADMIN_EMAIL: "admin@example.test",
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: sessionSecret,
      NEXVO_DATA_DIR: dataDirectory,
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`NEXVO server exited during startup: ${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`NEXVO server did not start in time: ${serverOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Cookie: token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, json: await response.json().catch(() => ({})) };
}

test("accounts, protected admin operations, verification, and Brand Studio persist safely", async () => {
  const initialBrand = await request("/api/brand");
  assert.equal(initialBrand.response.status, 200);
  assert.equal(initialBrand.json.appName, "NEXVO");

  const registration = await request("/api/auth/register", {
    method: "POST",
    body: {
      name: "Mina Test",
      username: "mina_test",
      phone: "+966 500 111 222",
      password: "a-unique-password-with-more-than-12-characters"
    }
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.json.user.username, "mina_test");
  assert.equal(registration.json.user.verificationLevel, null);
  const userCookie = registration.response.headers.get("set-cookie").split(";")[0];

  const forbidden = await request("/api/admin/overview", { token: userCookie });
  assert.equal(forbidden.response.status, 403);

  const userLogin = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "+966500111222", password: "a-unique-password-with-more-than-12-characters" }
  });
  assert.equal(userLogin.response.status, 200);
  const badPassword = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "+966500111222", password: "wrong-password" }
  });
  assert.equal(badPassword.response.status, 401);

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    body: { identifier: "admin@example.test", password: adminPassword }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get("set-cookie").split(";")[0];

  const users = await request("/api/admin/users?filter=unverified&search=mina", { token: adminCookie });
  assert.equal(users.response.status, 200);
  assert.equal(users.json.total, 1);
  const userId = users.json.users[0].id;
  const verified = await request(`/api/admin/users/${userId}`, {
    token: adminCookie,
    method: "PATCH",
    body: { verificationLevel: "verified", accountStatus: "active" }
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.json.user.verificationLevel, "verified");

  const brand = await request("/api/admin/brand", {
    token: adminCookie,
    method: "PATCH",
    body: { appName: "NEXVO Studio", appVerified: true, showVerifiedBadge: true }
  });
  assert.equal(brand.response.status, 200);
  assert.equal(brand.json.appVerified, true);

  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="teal"/></svg>').toString("base64")}`;
  const uploaded = await request("/api/admin/brand/assets/logo", {
    token: adminCookie,
    method: "POST",
    body: { dataUrl: svgDataUrl }
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.json.assets.logo.mimeType, "image/svg+xml");
  const asset = await fetch(`${baseUrl}${uploaded.json.assets.logo.path}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-security-policy"), /sandbox/);

  const audit = await request("/api/admin/audit", { token: adminCookie });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.json.entries.some((entry) => entry.action === "admin.user.update"));
});
