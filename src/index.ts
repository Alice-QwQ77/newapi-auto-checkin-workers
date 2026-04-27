import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { validator } from 'hono/validator';
import { z } from 'zod';

type Bindings = {
  DB: D1Database;
  APP_NAME: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_PASSWORD?: string;
  SESSION_TTL_SECONDS?: string;
  LOG_RETENTION_DAYS?: string;
};

type Variables = {
  session: SessionPayload | null;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type SiteRow = {
  id: number;
  name: string;
  base_url: string;
  access_token: string;
  user_id: number;
  enabled: number;
  notes: string;
  last_status: string;
  last_message: string;
  last_checkin_at: string | null;
  last_success_at: string | null;
  last_http_status: number | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: number;
  site_id: number | null;
  site_name: string;
  trigger_type: string;
  status: string;
  http_status: number | null;
  success: number;
  quota_awarded: string | null;
  response_message: string | null;
  response_body: string | null;
  requested_at: string;
  completed_at: string | null;
};

type SessionPayload = {
  username: string;
  createdAt: string;
};

type CheckinResult = {
  ok: boolean;
  status: string;
  httpStatus: number;
  quotaAwarded?: string | null;
  message: string;
  bodyText: string;
  completedAt: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const siteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  accessToken: z.string().trim().min(1).max(255),
  userId: z.coerce.number().int().positive(),
  enabled: z.coerce.boolean().default(true),
  notes: z.string().max(500).optional().default(''),
});

const bulkImportSchema = z.object({
  items: z.array(siteSchema).min(1),
});

const manualRunSchema = z.object({
  siteIds: z.array(z.number().int().positive()).min(1),
});

app.use('*', async (c, next) => {
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.set('session', await getSession(c));
  await next();
});

app.get('/', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.redirect('/login');
  }
  return c.html(renderOptimizedAppHtml(c.env.APP_NAME || 'New API Auto Check-in', session.username));
});

app.get('/login', async (c) => {
  const session = c.get('session');
  if (session) {
    return c.redirect('/');
  }
  return c.html(renderOptimizedLoginHtml(c.env.APP_NAME || 'New API Auto Check-in'));
});

app.post(
  '/auth/login',
  validator('form', (value, c) => {
    const parsed = loginSchema.safeParse(value);
    if (!parsed.success) {
      return c.text('用户名或密码不能为空', 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const { username, password } = c.req.valid('form');
    const isValid = await verifyAdminLogin(c.env, username, password);
    if (!isValid) {
      return c.text('用户名或密码错误', 401);
    }

    const sessionId = crypto.randomUUID();
    const ttl = getSessionTtlSeconds(c.env);
    const now = new Date();
    const payload: SessionPayload = {
      username,
      createdAt: now.toISOString(),
    };

    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    await c.env.DB.prepare(`
      INSERT INTO sessions (id, username, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `)
      .bind(sessionId, payload.username, payload.createdAt, expiresAt)
      .run();

    setCookie(c, 'session_id', sessionId, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: ttl,
    });

    return c.redirect('/');
  },
);

app.post('/auth/logout', async (c) => {
  const sessionId = getCookie(c, 'session_id');
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  deleteCookie(c, 'session_id', { path: '/' });
  return c.redirect('/login');
});

app.use('/api/*', async (c, next) => {
  if (!c.get('session')) {
    return c.json({ success: false, message: '未登录或会话已失效' }, 401);
  }
  await next();
});

app.get('/api/summary', async (c) => {
  const siteCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabledCount FROM sites',
  ).first<{ count: number; enabledCount: number | null }>();

  const latestRun = await c.env.DB.prepare(
    'SELECT status, site_name, requested_at, response_message FROM checkin_runs ORDER BY id DESC LIMIT 1',
  ).first<{ status: string; site_name: string; requested_at: string; response_message: string | null }>();

  const recentRuns = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successCount FROM checkin_runs WHERE requested_at >= datetime('now', '-1 day')",
  ).first<{ count: number; successCount: number | null }>();

  return c.json({
    success: true,
    data: {
      totalSites: siteCountResult?.count ?? 0,
      enabledSites: siteCountResult?.enabledCount ?? 0,
      recentRuns: recentRuns?.count ?? 0,
      recentSuccess: recentRuns?.successCount ?? 0,
      latestRun: latestRun ?? null,
    },
  });
});

app.get('/api/sites', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, name, base_url, access_token, user_id, enabled, notes, last_status, last_message, last_checkin_at, last_success_at, last_http_status, created_at, updated_at FROM sites ORDER BY id DESC',
  ).all<SiteRow>();
  return c.json({ success: true, data: rows.results ?? [] });
});

app.post(
  '/api/sites',
  validator('json', (value, c) => {
    const parsed = siteSchema.safeParse(value);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error.issues[0]?.message ?? '参数错误' }, 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const payload = c.req.valid('json');
    const now = new Date().toISOString();

    try {
      const result = await c.env.DB.prepare(`
        INSERT INTO sites (name, base_url, access_token, user_id, enabled, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          payload.name,
          normalizeBaseUrl(payload.baseUrl),
          payload.accessToken,
          payload.userId,
          payload.enabled ? 1 : 0,
          payload.notes.trim(),
          now,
          now,
        )
        .run();

      return c.json({ success: true, data: { id: result.meta.last_row_id } });
    } catch (error) {
      return c.json({ success: false, message: toErrorMessage(error, '新增站点失败，名称可能重复') }, 400);
    }
  },
);

app.put(
  '/api/sites/:id',
  validator('json', (value, c) => {
    const parsed = siteSchema.safeParse(value);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error.issues[0]?.message ?? '参数错误' }, 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const id = Number(c.req.param('id'));
    const payload = c.req.valid('json');
    const now = new Date().toISOString();

    try {
      await c.env.DB.prepare(`
        UPDATE sites
        SET name = ?, base_url = ?, access_token = ?, user_id = ?, enabled = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `)
        .bind(
          payload.name,
          normalizeBaseUrl(payload.baseUrl),
          payload.accessToken,
          payload.userId,
          payload.enabled ? 1 : 0,
          payload.notes.trim(),
          now,
          id,
        )
        .run();
      return c.json({ success: true });
    } catch (error) {
      return c.json({ success: false, message: toErrorMessage(error, '更新站点失败') }, 400);
    }
  },
);

app.delete('/api/sites/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

app.post(
  '/api/sites/import',
  validator('json', (value, c) => {
    const parsed = bulkImportSchema.safeParse(value);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error.issues[0]?.message ?? '导入数据格式错误' }, 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const payload = c.req.valid('json');
    const now = new Date().toISOString();

    const statements = payload.items.map((item) =>
      c.env.DB.prepare(`
        INSERT INTO sites (name, base_url, access_token, user_id, enabled, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          base_url = excluded.base_url,
          access_token = excluded.access_token,
          user_id = excluded.user_id,
          enabled = excluded.enabled,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).bind(
        item.name,
        normalizeBaseUrl(item.baseUrl),
        item.accessToken,
        item.userId,
        item.enabled ? 1 : 0,
        item.notes.trim(),
        now,
        now,
      ),
    );

    await c.env.DB.batch(statements);
    return c.json({ success: true, data: { imported: payload.items.length } });
  },
);

app.get('/api/logs', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 200);
  const rows = await c.env.DB.prepare(`
    SELECT id, site_id, site_name, trigger_type, status, http_status, success, quota_awarded, response_message, response_body, requested_at, completed_at
    FROM checkin_runs
    ORDER BY id DESC
    LIMIT ?
  `)
    .bind(limit)
    .all<RunRow>();
  return c.json({ success: true, data: rows.results ?? [] });
});

app.post(
  '/api/checkin/run',
  validator('json', (value, c) => {
    const parsed = manualRunSchema.safeParse(value);
    if (!parsed.success) {
      return c.json({ success: false, message: parsed.error.issues[0]?.message ?? '执行参数错误' }, 400);
    }
    return parsed.data;
  }),
  async (c) => {
    const { siteIds } = c.req.valid('json');
    const results = await runSitesByIds(c.env, siteIds, 'manual');
    return c.json({ success: true, data: results });
  },
);

app.post('/api/checkin/run-all', async (c) => {
  const rows = await c.env.DB.prepare('SELECT id FROM sites WHERE enabled = 1 ORDER BY id ASC').all<{ id: number }>();
  const siteIds = (rows.results ?? []).map((item) => item.id);
  const results = await runSitesByIds(c.env, siteIds, 'manual-all');
  return c.json({ success: true, data: results });
});

app.notFound((c) => c.text('Not Found', 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function runScheduled(env: Bindings) {
  await cleanupOldLogs(env);
  const rows = await env.DB.prepare('SELECT id FROM sites WHERE enabled = 1 ORDER BY id ASC').all<{ id: number }>();
  const siteIds = (rows.results ?? []).map((item) => item.id);
  await runSitesByIds(env, siteIds, 'cron');
}

async function runSitesByIds(env: Bindings, siteIds: number[], triggerType: string) {
  const uniqueIds = [...new Set(siteIds)].filter(Boolean);
  if (uniqueIds.length === 0) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = await env.DB.prepare(`
    SELECT id, name, base_url, access_token, user_id, enabled, notes, last_status, last_message, last_checkin_at, last_success_at, last_http_status, created_at, updated_at
    FROM sites
    WHERE id IN (${placeholders})
    ORDER BY id ASC
  `)
    .bind(...uniqueIds)
    .all<SiteRow>();

  const results = [];
  for (const site of rows.results ?? []) {
    const result = await runSingleCheckin(env, site, triggerType);
    results.push({
      siteId: site.id,
      siteName: site.name,
      ...result,
    });
  }
  return results;
}

async function runSingleCheckin(env: Bindings, site: SiteRow, triggerType: string): Promise<CheckinResult> {
  const requestedAt = new Date().toISOString();
  const url = `${normalizeBaseUrl(site.base_url)}/api/user/checkin`;

  let result: CheckinResult;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${site.access_token}`,
        'New-Api-User': String(site.user_id),
        Accept: 'application/json',
      },
    });

    const bodyText = await response.text();
    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsedBody = null;
    }

    const success = response.ok && parsedBody?.success === true;
    const message =
      typeof parsedBody?.message === 'string'
        ? parsedBody.message
        : success
          ? '签到成功'
          : `HTTP ${response.status}`;

    const data = parsedBody && typeof parsedBody.data === 'object' ? (parsedBody.data as Record<string, unknown>) : null;
    const quotaAwarded = data && 'quota_awarded' in data ? String(data.quota_awarded ?? '') : null;

    result = {
      ok: success,
      status: success ? 'success' : 'failed',
      httpStatus: response.status,
      quotaAwarded,
      message,
      bodyText,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    result = {
      ok: false,
      status: 'error',
      httpStatus: 0,
      message: toErrorMessage(error, '请求失败'),
      bodyText: '',
      completedAt: new Date().toISOString(),
    };
  }

  await persistRun(env, site, triggerType, requestedAt, result);
  return result;
}

async function persistRun(
  env: Bindings,
  site: SiteRow,
  triggerType: string,
  requestedAt: string,
  result: CheckinResult,
) {
  const statusMessage = result.message.slice(0, 500);
  const responseBody = result.bodyText.slice(0, 4000);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO checkin_runs
      (site_id, site_name, trigger_type, status, http_status, success, quota_awarded, response_message, response_body, requested_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      site.id,
      site.name,
      triggerType,
      result.status,
      result.httpStatus,
      result.ok ? 1 : 0,
      result.quotaAwarded ?? null,
      statusMessage,
      responseBody,
      requestedAt,
      result.completedAt,
    ),
    env.DB.prepare(`
      UPDATE sites
      SET last_status = ?, last_message = ?, last_http_status = ?, last_checkin_at = ?, last_success_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      result.status,
      statusMessage,
      result.httpStatus || null,
      result.completedAt,
      result.ok ? result.completedAt : site.last_success_at,
      result.completedAt,
      site.id,
    ),
  ]);
}

async function cleanupOldLogs(env: Bindings) {
  const retentionDays = getLogRetentionDays(env);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM checkin_runs WHERE requested_at < ?').bind(cutoff).run();
}

async function getSession(c: AppContext): Promise<SessionPayload | null> {
  const sessionId = getCookie(c, 'session_id');
  if (!sessionId) {
    return null;
  }

  await c.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();

  const row = await c.env.DB.prepare(`
    SELECT username, created_at
    FROM sessions
    WHERE id = ? AND expires_at > ?
    LIMIT 1
  `)
    .bind(sessionId, new Date().toISOString())
    .first<{ username: string; created_at: string }>();

  if (!row) {
    return null;
  }

  return {
    username: row.username,
    createdAt: row.created_at,
  };
}

async function verifyAdminLogin(env: Bindings, username: string, password: string) {
  const expectedUser = env.ADMIN_USERNAME || 'admin';
  if (username !== expectedUser) {
    return false;
  }

  if (env.ADMIN_PASSWORD_HASH) {
    const digest = await sha256Hex(password);
    return safeEqual(digest, env.ADMIN_PASSWORD_HASH.trim().toLowerCase());
  }

  if (env.ADMIN_PASSWORD) {
    return safeEqual(password, env.ADMIN_PASSWORD);
  }

  return false;
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function getSessionTtlSeconds(env: Bindings) {
  const ttl = Number(env.SESSION_TTL_SECONDS || '604800');
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 604800;
}

function getLogRetentionDays(env: Bindings) {
  const days = Number(env.LOG_RETENTION_DAYS || '7');
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, '');
}

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function renderOptimizedLoginHtml(appName: string) {
  return html`<!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${appName} - 登录</title>
        <style>${optimizedStyles}</style>
      </head>
      <body class="auth-page">
        <main class="auth-shell">
          <section class="auth-panel">
            <div class="brand-mark">NA</div>
            <h1>${appName}</h1>
            <p class="subtle">New API check-in console</p>
            <form method="post" action="/auth/login" class="auth-form">
              <label>
                <span>用户名</span>
                <input name="username" placeholder="admin" autocomplete="username" required />
              </label>
              <label>
                <span>密码</span>
                <input type="password" name="password" placeholder="请输入密码" autocomplete="current-password" required />
              </label>
              <button type="submit" class="primary-btn full-width">登录</button>
            </form>
          </section>
          <aside class="auth-aside">
            <div class="auth-metric">
              <span>Storage</span>
              <strong>D1</strong>
            </div>
            <div class="auth-metric">
              <span>Schedule</span>
              <strong>16:00 CST</strong>
            </div>
            <div class="auth-metric">
              <span>Retention</span>
              <strong>7 days</strong>
            </div>
          </aside>
        </main>
      </body>
    </html>`;
}

function renderOptimizedAppHtml(appName: string, username: string) {
  return html`<!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${appName}</title>
        <style>${optimizedStyles}</style>
      </head>
      <body>
        <div class="workspace">
          <aside class="sidebar">
            <div class="brand">
              <div class="brand-mark">NA</div>
              <div>
                <strong>${appName}</strong>
                <span>Check-in Console</span>
              </div>
            </div>
            <nav class="nav-list" aria-label="主导航">
              <button class="nav-item active" data-view-target="overview" type="button">概览</button>
              <button class="nav-item" data-view-target="sites" type="button">站点</button>
              <button class="nav-item" data-view-target="import" type="button">导入</button>
              <button class="nav-item" data-view-target="logs" type="button">日志</button>
            </nav>
            <div class="sidebar-footer">
              <span>定时</span>
              <strong>每日 16:00</strong>
            </div>
          </aside>

          <main class="main">
            <header class="topbar">
              <div>
                <h1>自动签到管理</h1>
                <p class="subtle">北京时间 16:00 自动执行，日志保留 7 天。</p>
              </div>
              <div class="topbar-actions">
                <span class="user-chip">${username}</span>
                <button id="refresh-all" class="ghost-btn" type="button">刷新</button>
                <form method="post" action="/auth/logout">
                  <button class="ghost-btn" type="submit">退出</button>
                </form>
              </div>
            </header>

            <section class="notice-line" id="toast" aria-live="polite"></section>

            <section class="view active" data-view="overview">
              <div class="metric-grid" id="summary"></div>
              <div class="split-grid">
                <section class="surface">
                  <div class="section-head">
                    <div>
                      <h2>最近站点</h2>
                      <p class="subtle">按最后更新时间排序。</p>
                    </div>
                    <button class="ghost-btn" data-view-target="sites" type="button">管理站点</button>
                  </div>
                  <div id="recent-sites" class="compact-list"></div>
                </section>
                <section class="surface">
                  <div class="section-head">
                    <div>
                      <h2>最近日志</h2>
                      <p class="subtle">展示最新执行结果。</p>
                    </div>
                    <button class="ghost-btn" data-view-target="logs" type="button">查看日志</button>
                  </div>
                  <div id="recent-logs" class="compact-list"></div>
                </section>
              </div>
            </section>

            <section class="view" data-view="sites">
              <div class="workspace-grid">
                <section class="surface">
                  <div class="section-head">
                    <div>
                      <h2>站点列表</h2>
                      <p class="subtle"><span id="site-count">0</span> 个站点，已选择 <span id="selected-count">0</span> 个。</p>
                    </div>
                    <div class="toolbar">
                      <button id="run-selected" class="ghost-btn" type="button">执行选中</button>
                      <button id="run-all" class="primary-btn" type="button">执行全部</button>
                    </div>
                  </div>
                  <div class="filters">
                    <input id="site-search" type="search" placeholder="搜索名称、URL、备注" />
                    <select id="site-filter" aria-label="站点状态筛选">
                      <option value="all">全部状态</option>
                      <option value="enabled">仅启用</option>
                      <option value="disabled">仅停用</option>
                      <option value="success">最近成功</option>
                      <option value="failed">最近失败</option>
                    </select>
                  </div>
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th class="check-col"><input id="select-all-sites" type="checkbox" aria-label="选择全部站点" /></th>
                          <th>站点</th>
                          <th>用户</th>
                          <th>状态</th>
                          <th>最近执行</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody id="site-table"></tbody>
                    </table>
                  </div>
                </section>

                <aside class="surface sticky-panel">
                  <div class="section-head compact">
                    <div>
                      <h2 id="form-title">新增站点</h2>
                      <p class="subtle">Access Token 会在列表中脱敏显示。</p>
                    </div>
                  </div>
                  <form id="site-form" class="field-stack">
                    <input type="hidden" name="id" />
                    <label>
                      <span>站点名称</span>
                      <input name="name" required placeholder="主站" />
                    </label>
                    <label>
                      <span>站点 URL</span>
                      <input name="baseUrl" type="url" required placeholder="https://example.com" />
                    </label>
                    <label>
                      <span>系统访问令牌</span>
                      <input name="accessToken" required placeholder="Access Token" />
                    </label>
                    <label>
                      <span>用户 ID</span>
                      <input name="userId" type="number" min="1" required placeholder="1" />
                    </label>
                    <label class="inline-check">
                      <input name="enabled" type="checkbox" checked />
                      <span>启用自动签到</span>
                    </label>
                    <label>
                      <span>备注</span>
                      <textarea name="notes" rows="3" placeholder="可选"></textarea>
                    </label>
                    <div class="toolbar end">
                      <button type="button" id="reset-form" class="ghost-btn">清空</button>
                      <button type="submit" class="primary-btn">保存</button>
                    </div>
                  </form>
                </aside>
              </div>
            </section>

            <section class="view" data-view="import">
              <section class="surface">
                <div class="section-head">
                  <div>
                    <h2>批量导入</h2>
                    <p class="subtle">同名站点会被覆盖更新。</p>
                  </div>
                  <button id="import-submit" class="primary-btn" type="button">导入</button>
                </div>
                <div class="import-grid">
                  <label class="upload-box">
                    <span>选择 JSON 文件</span>
                    <input id="import-file" type="file" accept=".json,application/json" />
                  </label>
                  <textarea id="import-json" rows="16" spellcheck="false" placeholder='[{"name":"主站","baseUrl":"https://demo.com","accessToken":"token","userId":1,"enabled":true}]'></textarea>
                </div>
              </section>
            </section>

            <section class="view" data-view="logs">
              <section class="surface">
                <div class="section-head">
                  <div>
                    <h2>运行日志</h2>
                    <p class="subtle">最多显示最近 100 条，定时清理 7 天前记录。</p>
                  </div>
                  <div class="toolbar">
                    <input id="log-search" type="search" placeholder="搜索日志" />
                    <button id="refresh-logs" class="ghost-btn" type="button">刷新</button>
                  </div>
                </div>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>站点</th>
                        <th>触发</th>
                        <th>结果</th>
                        <th>HTTP</th>
                        <th>额度</th>
                        <th>消息</th>
                      </tr>
                    </thead>
                    <tbody id="log-table"></tbody>
                  </table>
                </div>
              </section>
            </section>
          </main>
        </div>

        <script>
          const state = {
            sites: [],
            logs: [],
            selected: new Set(),
            siteQuery: '',
            siteFilter: 'all',
            logQuery: ''
          };

          const statusLabels = {
            success: '成功',
            failed: '失败',
            error: '错误',
            idle: '待执行'
          };

          async function api(path, options = {}) {
            const response = await fetch(path, {
              headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
              ...options,
            });
            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json') ? await response.json() : await response.text();
            if (!response.ok || (data && data.success === false)) {
              throw new Error((data && data.message) || '请求失败');
            }
            return data;
          }

          function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (char) => ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            }[char]));
          }

          function toast(message, type = 'info') {
            const el = document.getElementById('toast');
            el.textContent = message;
            el.dataset.type = type;
            el.classList.add('visible');
            window.clearTimeout(toast.timer);
            toast.timer = window.setTimeout(() => el.classList.remove('visible'), 3200);
          }

          function maskToken(token) {
            if (!token) return '';
            if (token.length <= 10) return '********';
            return token.slice(0, 5) + '...' + token.slice(-5);
          }

          function formatTime(value) {
            if (!value) return '-';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return value;
            return date.toLocaleString('zh-CN', { hour12: false });
          }

          function statusPill(status) {
            const key = status || 'idle';
            return '<span class="status-pill ' + escapeHtml(key) + '">' + escapeHtml(statusLabels[key] || key) + '</span>';
          }

          function getSiteById(id) {
            return state.sites.find((site) => site.id === id);
          }

          function filteredSites() {
            const query = state.siteQuery.trim().toLowerCase();
            return state.sites.filter((site) => {
              const text = [site.name, site.base_url, site.notes, site.last_message].join(' ').toLowerCase();
              const matchesQuery = !query || text.includes(query);
              const matchesFilter =
                state.siteFilter === 'all' ||
                (state.siteFilter === 'enabled' && site.enabled) ||
                (state.siteFilter === 'disabled' && !site.enabled) ||
                (state.siteFilter === 'success' && site.last_status === 'success') ||
                (state.siteFilter === 'failed' && ['failed', 'error'].includes(site.last_status));
              return matchesQuery && matchesFilter;
            });
          }

          function renderSummary(data) {
            const latest = data.latestRun
              ? escapeHtml(data.latestRun.site_name) + ' / ' + escapeHtml(statusLabels[data.latestRun.status] || data.latestRun.status)
              : '暂无记录';
            const cards = [
              ['站点总数', data.totalSites],
              ['启用站点', data.enabledSites],
              ['24h 执行', data.recentRuns],
              ['24h 成功', data.recentSuccess],
              ['最近执行', latest]
            ];
            document.getElementById('summary').innerHTML = cards.map(([label, value]) =>
              '<article class="metric-card"><span>' + label + '</span><strong>' + value + '</strong></article>'
            ).join('');
          }

          function renderRecentSites() {
            const items = state.sites.slice(0, 6);
            document.getElementById('recent-sites').innerHTML = items.length ? items.map((site) =>
              '<div class="compact-row">' +
                '<div><strong>' + escapeHtml(site.name) + '</strong><span>' + escapeHtml(site.base_url) + '</span></div>' +
                statusPill(site.last_status || 'idle') +
              '</div>'
            ).join('') : '<div class="empty-state">暂无站点</div>';
          }

          function renderRecentLogs() {
            const items = state.logs.slice(0, 6);
            document.getElementById('recent-logs').innerHTML = items.length ? items.map((item) =>
              '<div class="compact-row">' +
                '<div><strong>' + escapeHtml(item.site_name) + '</strong><span>' + escapeHtml(formatTime(item.requested_at)) + '</span></div>' +
                statusPill(item.status) +
              '</div>'
            ).join('') : '<div class="empty-state">暂无日志</div>';
          }

          function renderSites() {
            const sites = filteredSites();
            document.getElementById('site-count').textContent = String(state.sites.length);
            document.getElementById('selected-count').textContent = String(state.selected.size);
            document.getElementById('select-all-sites').checked = sites.length > 0 && sites.every((site) => state.selected.has(site.id));

            document.getElementById('site-table').innerHTML = sites.length ? sites.map((site) =>
              '<tr>' +
                '<td class="check-col"><input data-action="select" data-id="' + site.id + '" type="checkbox" ' + (state.selected.has(site.id) ? 'checked' : '') + ' /></td>' +
                '<td><div class="primary-cell"><strong>' + escapeHtml(site.name) + '</strong><span>' + escapeHtml(site.base_url) + '</span><code>' + escapeHtml(maskToken(site.access_token)) + '</code></div></td>' +
                '<td>#' + escapeHtml(site.user_id) + '</td>' +
                '<td><div class="status-stack">' + (site.enabled ? '<span class="status-pill enabled">启用</span>' : '<span class="status-pill disabled">停用</span>') + statusPill(site.last_status || 'idle') + '</div></td>' +
                '<td><div class="primary-cell"><span>' + escapeHtml(formatTime(site.last_checkin_at)) + '</span><small>' + escapeHtml(site.last_message || '-') + '</small></div></td>' +
                '<td><div class="toolbar compact-actions">' +
                  '<button data-action="run" data-id="' + site.id + '" class="ghost-btn" type="button">执行</button>' +
                  '<button data-action="edit" data-id="' + site.id + '" class="ghost-btn" type="button">编辑</button>' +
                  '<button data-action="delete" data-id="' + site.id + '" class="danger-btn" type="button">删除</button>' +
                '</div></td>' +
              '</tr>'
            ).join('') : '<tr><td colspan="6"><div class="empty-state">没有匹配的站点</div></td></tr>';
          }

          function renderLogs() {
            const query = state.logQuery.trim().toLowerCase();
            const logs = state.logs.filter((item) =>
              !query || [item.site_name, item.trigger_type, item.status, item.response_message, item.response_body].join(' ').toLowerCase().includes(query)
            );
            document.getElementById('log-table').innerHTML = logs.length ? logs.map((item) =>
              '<tr>' +
                '<td>' + escapeHtml(formatTime(item.requested_at)) + '</td>' +
                '<td>' + escapeHtml(item.site_name) + '</td>' +
                '<td>' + escapeHtml(item.trigger_type) + '</td>' +
                '<td>' + statusPill(item.status) + '</td>' +
                '<td>' + escapeHtml(item.http_status || '-') + '</td>' +
                '<td>' + escapeHtml(item.quota_awarded || '-') + '</td>' +
                '<td><div class="log-message">' + escapeHtml(item.response_message || '') + '</div><details><summary>响应体</summary><pre>' + escapeHtml(item.response_body || '') + '</pre></details></td>' +
              '</tr>'
            ).join('') : '<tr><td colspan="7"><div class="empty-state">暂无匹配日志</div></td></tr>';
          }

          async function loadSummary() {
            const { data } = await api('/api/summary');
            renderSummary(data);
          }

          async function loadSites() {
            const { data } = await api('/api/sites');
            state.sites = data;
            state.selected = new Set([...state.selected].filter((id) => data.some((site) => site.id === id)));
            renderSites();
            renderRecentSites();
          }

          async function loadLogs() {
            const { data } = await api('/api/logs?limit=100');
            state.logs = data;
            renderLogs();
            renderRecentLogs();
          }

          function resetForm() {
            const form = document.getElementById('site-form');
            form.reset();
            form.elements.id.value = '';
            form.elements.enabled.checked = true;
            document.getElementById('form-title').textContent = '新增站点';
          }

          async function refreshAll(silent = false) {
            await Promise.all([loadSummary(), loadSites(), loadLogs()]);
            if (!silent) toast('数据已刷新', 'success');
          }

          function switchView(name) {
            document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
            document.querySelectorAll('[data-view-target]').forEach((el) => el.classList.toggle('active', el.dataset.viewTarget === name));
          }

          document.addEventListener('click', async (event) => {
            const nav = event.target.closest('[data-view-target]');
            if (nav) {
              switchView(nav.dataset.viewTarget);
              return;
            }

            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const id = Number(button.dataset.id);
            const action = button.dataset.action;
            const site = getSiteById(id);
            if (!site) return;

            if (action === 'edit') {
              const form = document.getElementById('site-form');
              form.elements.id.value = String(site.id);
              form.elements.name.value = site.name;
              form.elements.baseUrl.value = site.base_url;
              form.elements.accessToken.value = site.access_token;
              form.elements.userId.value = String(site.user_id);
              form.elements.enabled.checked = Boolean(site.enabled);
              form.elements.notes.value = site.notes || '';
              document.getElementById('form-title').textContent = '编辑站点';
              return;
            }

            if (action === 'delete') {
              if (!confirm('确认删除站点 ' + site.name + ' 吗？')) return;
              await api('/api/sites/' + id, { method: 'DELETE' });
              state.selected.delete(id);
              await refreshAll(true);
              toast('站点已删除', 'success');
              return;
            }

            if (action === 'run') {
              toast('正在执行 ' + site.name, 'info');
              await api('/api/checkin/run', { method: 'POST', body: JSON.stringify({ siteIds: [id] }) });
              await refreshAll(true);
              toast('执行完成', 'success');
            }
          });

          document.getElementById('site-table').addEventListener('change', (event) => {
            const input = event.target.closest('input[data-action="select"]');
            if (!input) return;
            const id = Number(input.dataset.id);
            if (input.checked) state.selected.add(id);
            else state.selected.delete(id);
            renderSites();
          });

          document.getElementById('select-all-sites').addEventListener('change', (event) => {
            filteredSites().forEach((site) => {
              if (event.target.checked) state.selected.add(site.id);
              else state.selected.delete(site.id);
            });
            renderSites();
          });

          document.getElementById('site-search').addEventListener('input', (event) => {
            state.siteQuery = event.target.value;
            renderSites();
          });

          document.getElementById('site-filter').addEventListener('change', (event) => {
            state.siteFilter = event.target.value;
            renderSites();
          });

          document.getElementById('log-search').addEventListener('input', (event) => {
            state.logQuery = event.target.value;
            renderLogs();
          });

          document.getElementById('site-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const payload = {
              name: form.elements.name.value.trim(),
              baseUrl: form.elements.baseUrl.value.trim(),
              accessToken: form.elements.accessToken.value.trim(),
              userId: Number(form.elements.userId.value),
              enabled: form.elements.enabled.checked,
              notes: form.elements.notes.value.trim()
            };
            const id = form.elements.id.value;
            await api(id ? '/api/sites/' + id : '/api/sites', {
              method: id ? 'PUT' : 'POST',
              body: JSON.stringify(payload)
            });
            resetForm();
            await refreshAll(true);
            toast('站点已保存', 'success');
          });

          document.getElementById('run-all').addEventListener('click', async () => {
            toast('正在执行全部启用站点', 'info');
            await api('/api/checkin/run-all', { method: 'POST' });
            await refreshAll(true);
            toast('批量执行完成', 'success');
          });

          document.getElementById('run-selected').addEventListener('click', async () => {
            const siteIds = [...state.selected];
            if (siteIds.length === 0) {
              toast('请先选择站点', 'warning');
              return;
            }
            toast('正在执行选中站点', 'info');
            await api('/api/checkin/run', { method: 'POST', body: JSON.stringify({ siteIds }) });
            await refreshAll(true);
            toast('选中站点执行完成', 'success');
          });

          document.getElementById('refresh-all').addEventListener('click', () => refreshAll());
          document.getElementById('refresh-logs').addEventListener('click', async () => {
            await loadLogs();
            toast('日志已刷新', 'success');
          });
          document.getElementById('reset-form').addEventListener('click', resetForm);

          document.getElementById('import-file').addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            document.getElementById('import-json').value = await file.text();
          });

          document.getElementById('import-submit').addEventListener('click', async () => {
            const text = document.getElementById('import-json').value.trim();
            if (!text) {
              toast('请先提供 JSON 数据', 'warning');
              return;
            }
            const items = JSON.parse(text);
            await api('/api/sites/import', {
              method: 'POST',
              body: JSON.stringify({ items })
            });
            document.getElementById('import-json').value = '';
            document.getElementById('import-file').value = '';
            await refreshAll(true);
            switchView('sites');
            toast('导入完成，共 ' + items.length + ' 条', 'success');
          });

          refreshAll(true).catch((error) => toast(error.message || '加载失败', 'error'));
        </script>
      </body>
    </html>`;
}

const optimizedStyles = `
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-soft: #f1f5f9;
    --text: #172033;
    --muted: #687386;
    --line: #d9e0ea;
    --primary: #176b87;
    --primary-dark: #0f4b61;
    --green: #1d7f54;
    --red: #b42318;
    --amber: #9a6700;
    --blue: #2457c5;
    --shadow: 0 18px 45px rgba(23, 32, 51, 0.08);
    --radius: 8px;
    --font: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    background:
      linear-gradient(180deg, rgba(230, 236, 243, 0.88), rgba(246, 247, 249, 0.7) 220px),
      repeating-linear-gradient(90deg, rgba(23, 32, 51, 0.035) 0 1px, transparent 1px 80px),
      var(--bg);
    font-family: var(--font);
    font-size: 14px;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
  }

  button {
    border: 0;
  }

  input,
  select,
  textarea {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: #fff;
    color: var(--text);
    padding: 10px 12px;
    outline: none;
  }

  input:focus,
  select:focus,
  textarea:focus {
    border-color: rgba(23, 107, 135, 0.65);
    box-shadow: 0 0 0 3px rgba(23, 107, 135, 0.12);
  }

  textarea {
    resize: vertical;
    min-height: 84px;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 24px;
    line-height: 1.2;
  }

  h2 {
    font-size: 16px;
    line-height: 1.35;
  }

  .subtle {
    color: var(--muted);
  }

  .auth-page {
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .auth-shell {
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(220px, 320px);
    width: min(820px, 100%);
    min-height: 440px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .auth-panel {
    padding: 42px;
  }

  .auth-panel h1 {
    margin-top: 18px;
  }

  .auth-form {
    display: grid;
    gap: 16px;
    margin-top: 34px;
  }

  .auth-form label,
  .field-stack label {
    display: grid;
    gap: 7px;
    font-weight: 600;
  }

  .auth-aside {
    display: grid;
    align-content: end;
    gap: 12px;
    padding: 26px;
    color: #fff;
    background:
      linear-gradient(150deg, rgba(23, 107, 135, 0.92), rgba(29, 127, 84, 0.84)),
      linear-gradient(90deg, rgba(255, 255, 255, 0.12) 1px, transparent 1px);
    background-size: auto, 38px 38px;
  }

  .auth-metric {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.22);
  }

  .brand-mark {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    color: #fff;
    background: var(--primary);
    font-weight: 800;
  }

  .workspace {
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    min-height: 100vh;
  }

  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 24px;
    padding: 22px;
    background: #fff;
    border-right: 1px solid var(--line);
  }

  .brand {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .brand strong,
  .brand span {
    display: block;
  }

  .brand span {
    margin-top: 3px;
    color: var(--muted);
    font-size: 12px;
  }

  .nav-list {
    display: grid;
    align-content: start;
    gap: 6px;
  }

  .nav-item {
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--radius);
    color: var(--muted);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .nav-item:hover,
  .nav-item.active {
    color: var(--primary-dark);
    background: #e8f2f5;
  }

  .sidebar-footer {
    display: grid;
    gap: 4px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel-soft);
  }

  .sidebar-footer span {
    color: var(--muted);
    font-size: 12px;
  }

  .main {
    min-width: 0;
    padding: 22px;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: center;
    margin-bottom: 18px;
  }

  .topbar-actions,
  .toolbar,
  .filters {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .topbar-actions form {
    margin: 0;
  }

  .user-chip {
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: #fff;
    color: var(--muted);
  }

  .view {
    display: none;
  }

  .view.active {
    display: grid;
    gap: 18px;
  }

  .surface {
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 10px 28px rgba(23, 32, 51, 0.05);
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid var(--line);
  }

  .section-head.compact {
    border-bottom: 0;
    padding-bottom: 8px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(140px, 1fr));
    gap: 12px;
  }

  .metric-card {
    display: grid;
    align-content: space-between;
    min-height: 108px;
    padding: 16px;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 10px 28px rgba(23, 32, 51, 0.05);
  }

  .metric-card span {
    color: var(--muted);
  }

  .metric-card strong {
    margin-top: 18px;
    font-size: 22px;
    line-height: 1.2;
    word-break: break-word;
  }

  .split-grid,
  .workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
    gap: 18px;
    align-items: start;
  }

  .workspace-grid {
    grid-template-columns: minmax(0, 1fr) 360px;
  }

  .sticky-panel {
    position: sticky;
    top: 22px;
  }

  .field-stack {
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .inline-check {
    display: flex !important;
    grid-template-columns: none !important;
    flex-direction: row;
    align-items: center;
    gap: 10px !important;
  }

  .inline-check input {
    width: 16px;
    height: 16px;
  }

  .primary-btn,
  .ghost-btn,
  .danger-btn {
    min-height: 38px;
    padding: 0 14px;
    border-radius: var(--radius);
    cursor: pointer;
    white-space: nowrap;
  }

  .primary-btn {
    color: #fff;
    background: var(--primary);
  }

  .primary-btn:hover {
    background: var(--primary-dark);
  }

  .ghost-btn {
    color: var(--text);
    background: #fff;
    border: 1px solid var(--line);
  }

  .ghost-btn:hover,
  .ghost-btn.active {
    border-color: rgba(23, 107, 135, 0.38);
    color: var(--primary-dark);
    background: #e8f2f5;
  }

  .danger-btn {
    color: var(--red);
    background: #fff;
    border: 1px solid rgba(180, 35, 24, 0.28);
  }

  .danger-btn:hover {
    background: rgba(180, 35, 24, 0.08);
  }

  .full-width {
    width: 100%;
  }

  .end {
    justify-content: flex-end;
  }

  .filters {
    padding: 0 16px 16px;
  }

  .filters input {
    max-width: 360px;
  }

  .filters select {
    max-width: 160px;
  }

  .table-wrap {
    overflow: auto;
    border-top: 1px solid var(--line);
  }

  table {
    width: 100%;
    min-width: 850px;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
    text-align: left;
  }

  th {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    background: #f8fafc;
  }

  .check-col {
    width: 42px;
  }

  .check-col input {
    width: 16px;
    height: 16px;
  }

  .primary-cell {
    display: grid;
    gap: 4px;
    min-width: 180px;
  }

  .primary-cell span,
  .primary-cell small {
    color: var(--muted);
  }

  code {
    color: var(--blue);
    font-family: "Cascadia Mono", "Consolas", monospace;
    font-size: 12px;
  }

  .compact-actions {
    flex-wrap: nowrap;
  }

  .status-stack {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    background: #eef2f7;
    color: var(--muted);
  }

  .status-pill.success,
  .status-pill.enabled {
    background: rgba(29, 127, 84, 0.12);
    color: var(--green);
  }

  .status-pill.failed,
  .status-pill.error {
    background: rgba(180, 35, 24, 0.12);
    color: var(--red);
  }

  .status-pill.idle {
    background: rgba(154, 103, 0, 0.13);
    color: var(--amber);
  }

  .status-pill.disabled {
    background: #edf0f4;
    color: var(--muted);
  }

  .compact-list {
    display: grid;
    padding: 6px 16px 16px;
  }

  .compact-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }

  .compact-row:last-child {
    border-bottom: 0;
  }

  .compact-row div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .compact-row span {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .import-grid {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 16px;
    padding: 16px;
  }

  .upload-box {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 12px;
    min-height: 220px;
    border: 1px dashed #9da8b7;
    border-radius: var(--radius);
    background: #f8fafc;
    color: var(--muted);
    text-align: center;
  }

  .upload-box input {
    max-width: 220px;
  }

  .log-message {
    max-width: 360px;
    color: var(--text);
  }

  details summary {
    margin-top: 6px;
    color: var(--primary-dark);
    cursor: pointer;
  }

  pre {
    max-width: 520px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
  }

  .empty-state {
    padding: 24px;
    color: var(--muted);
    text-align: center;
  }

  .notice-line {
    position: fixed;
    top: 18px;
    right: 18px;
    z-index: 20;
    min-width: 220px;
    max-width: min(380px, calc(100vw - 36px));
    padding: 12px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--line);
    background: #fff;
    box-shadow: var(--shadow);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-8px);
    transition: opacity 160ms ease, transform 160ms ease;
  }

  .notice-line.visible {
    opacity: 1;
    transform: translateY(0);
  }

  .notice-line[data-type="success"] {
    border-color: rgba(29, 127, 84, 0.35);
    color: var(--green);
  }

  .notice-line[data-type="error"] {
    border-color: rgba(180, 35, 24, 0.35);
    color: var(--red);
  }

  .notice-line[data-type="warning"] {
    border-color: rgba(154, 103, 0, 0.38);
    color: var(--amber);
  }

  @media (max-width: 1080px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: static;
      height: auto;
      grid-template-columns: 1fr;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .nav-list {
      display: flex;
      overflow-x: auto;
    }

    .nav-item {
      min-width: 88px;
      text-align: center;
    }

    .sidebar-footer {
      display: none;
    }

    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .split-grid,
    .workspace-grid,
    .import-grid {
      grid-template-columns: 1fr;
    }

    .sticky-panel {
      position: static;
    }
  }

  @media (max-width: 680px) {
    body {
      font-size: 13px;
    }

    .main,
    .sidebar,
    .auth-panel {
      padding: 16px;
    }

    .topbar,
    .section-head,
    .auth-shell {
      display: grid;
      grid-template-columns: 1fr;
    }

    .auth-aside {
      display: none;
    }

    .metric-grid {
      grid-template-columns: 1fr;
    }

    .topbar-actions,
    .toolbar,
    .filters {
      align-items: stretch;
    }

    .topbar-actions > *,
    .toolbar > *,
    .filters > * {
      flex: 1 1 auto;
    }

    .compact-actions {
      flex-wrap: wrap;
    }
  }
`;

function renderLoginHtml(appName: string) {
  return html`<!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${appName} - 登录</title>
        <style>${styles}</style>
      </head>
      <body class="login-body">
        <main class="login-shell">
          <section class="login-card">
            <p class="eyebrow">Cloudflare Workers</p>
            <h1>${appName}</h1>
            <p class="muted">登录后可以查看签到状态、日志并执行单站或批量签到。</p>
            <form method="post" action="/auth/login" class="stack">
              <label>
                <span>用户名</span>
                <input name="username" placeholder="admin" autocomplete="username" required />
              </label>
              <label>
                <span>密码</span>
                <input type="password" name="password" placeholder="请输入密码" autocomplete="current-password" required />
              </label>
              <button type="submit">登录管理台</button>
            </form>
          </section>
        </main>
      </body>
    </html>`;
}

function renderAppHtml(appName: string, username: string) {
  return html`<!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${appName}</title>
        <style>${styles}</style>
      </head>
      <body>
        <div class="app-shell">
          <header class="hero">
            <div>
              <p class="eyebrow">New API 自动签到</p>
              <h1>${appName}</h1>
              <p class="muted">统一管理站点、查看签到状态与运行日志，并支持手动单站或全量签到。</p>
            </div>
            <div class="hero-actions">
              <span class="pill">已登录：${username}</span>
              <form method="post" action="/auth/logout">
                <button class="secondary" type="submit">退出登录</button>
              </form>
            </div>
          </header>

          <section class="stats-grid" id="summary"></section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>站点管理</h2>
                <p class="muted">保存 New API 站点地址、系统访问令牌与用户 ID。</p>
              </div>
              <div class="action-row">
                <button id="refresh-sites" class="secondary" type="button">刷新列表</button>
                <button id="run-all" type="button">批量签到</button>
              </div>
            </div>

            <form id="site-form" class="form-grid">
              <input type="hidden" name="id" />
              <label>
                <span>站点名称</span>
                <input name="name" required placeholder="例如：主站" />
              </label>
              <label>
                <span>站点 URL</span>
                <input name="baseUrl" type="url" required placeholder="https://example.com" />
              </label>
              <label>
                <span>系统访问令牌</span>
                <input name="accessToken" required placeholder="个人设置生成的 access token" />
              </label>
              <label>
                <span>用户 ID</span>
                <input name="userId" type="number" min="1" required placeholder="例如：1" />
              </label>
              <label class="toggle">
                <span>启用签到</span>
                <input name="enabled" type="checkbox" checked />
              </label>
              <label class="wide">
                <span>备注</span>
                <textarea name="notes" rows="2" placeholder="可选备注"></textarea>
              </label>
              <div class="action-row wide">
                <button type="submit">保存站点</button>
                <button type="button" id="reset-form" class="secondary">清空表单</button>
              </div>
            </form>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>名称</th>
                    <th>地址</th>
                    <th>用户ID</th>
                    <th>状态</th>
                    <th>最近结果</th>
                    <th>最近成功</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="site-table"></tbody>
              </table>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>批量导入</h2>
                <p class="muted">支持上传 JSON 数组，字段为 name、baseUrl、accessToken、userId、enabled、notes。</p>
              </div>
            </div>
            <div class="stack">
              <input id="import-file" type="file" accept=".json,application/json" />
              <textarea id="import-json" rows="7" placeholder='[{"name":"主站","baseUrl":"https://demo.com","accessToken":"token","userId":1,"enabled":true}]'></textarea>
              <div class="action-row">
                <button id="import-submit" type="button">导入或覆盖站点</button>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>运行日志</h2>
                <p class="muted">展示最近签到记录，包括 HTTP 状态、返回消息与额度结果。</p>
              </div>
              <button id="refresh-logs" class="secondary" type="button">刷新日志</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>站点</th>
                    <th>触发方式</th>
                    <th>结果</th>
                    <th>HTTP</th>
                    <th>额度</th>
                    <th>消息</th>
                  </tr>
                </thead>
                <tbody id="log-table"></tbody>
              </table>
            </div>
          </section>
        </div>

        <script>
          const state = { sites: [] };

          async function api(path, options = {}) {
            const response = await fetch(path, {
              headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
              ...options,
            });
            const contentType = response.headers.get('content-type') || '';
            const data = contentType.includes('application/json') ? await response.json() : await response.text();
            if (!response.ok || (data && data.success === false)) {
              throw new Error((data && data.message) || '请求失败');
            }
            return data;
          }

          function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (char) => ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            }[char]));
          }

          function maskToken(token) {
            if (!token) return '';
            if (token.length <= 10) return '********';
            return token.slice(0, 4) + '***' + token.slice(-4);
          }

          function getSiteById(id) {
            return state.sites.find((site) => site.id === id);
          }

          async function loadSummary() {
            const { data } = await api('/api/summary');
            const cards = [
              ['站点总数', data.totalSites],
              ['启用站点', data.enabledSites],
              ['24h 执行次数', data.recentRuns],
              ['24h 成功次数', data.recentSuccess]
            ];
            const latest = data.latestRun
              ? '<div class="latest-run"><strong>最近执行：</strong>' + escapeHtml(data.latestRun.site_name) + ' / ' + escapeHtml(data.latestRun.status) + ' / ' + escapeHtml(data.latestRun.requested_at) + '</div>'
              : '<div class="latest-run"><strong>最近执行：</strong>暂无记录</div>';
            document.getElementById('summary').innerHTML = cards.map(([label, value]) => '<article class="stat-card"><span>' + label + '</span><strong>' + value + '</strong></article>').join('') + latest;
          }

          async function loadSites() {
            const { data } = await api('/api/sites');
            state.sites = data;
            document.getElementById('site-table').innerHTML = data.map((site) => '<tr>' +
              '<td>' + site.id + '</td>' +
              '<td><strong>' + escapeHtml(site.name) + '</strong><div class="tiny muted">' + escapeHtml(maskToken(site.access_token)) + '</div></td>' +
              '<td>' + escapeHtml(site.base_url) + '</td>' +
              '<td>' + escapeHtml(site.user_id) + '</td>' +
              '<td><span class="pill ' + (site.enabled ? 'ok' : 'idle') + '">' + (site.enabled ? '启用' : '停用') + '</span></td>' +
              '<td><span class="pill ' + escapeHtml(site.last_status || 'idle') + '">' + escapeHtml(site.last_status || 'idle') + '</span><div class="tiny muted">' + escapeHtml(site.last_message || '') + '</div></td>' +
              '<td>' + escapeHtml(site.last_success_at || '-') + '</td>' +
              '<td><div class="action-row">' +
                '<button data-action="run" data-id="' + site.id + '" type="button">签到</button>' +
                '<button data-action="edit" data-id="' + site.id + '" class="secondary" type="button">编辑</button>' +
                '<button data-action="delete" data-id="' + site.id + '" class="danger" type="button">删除</button>' +
              '</div></td>' +
            '</tr>').join('');
          }

          async function loadLogs() {
            const { data } = await api('/api/logs?limit=100');
            document.getElementById('log-table').innerHTML = data.map((item) => '<tr>' +
              '<td>' + escapeHtml(item.requested_at) + '</td>' +
              '<td>' + escapeHtml(item.site_name) + '</td>' +
              '<td>' + escapeHtml(item.trigger_type) + '</td>' +
              '<td><span class="pill ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span></td>' +
              '<td>' + escapeHtml(item.http_status || '-') + '</td>' +
              '<td>' + escapeHtml(item.quota_awarded || '-') + '</td>' +
              '<td><div>' + escapeHtml(item.response_message || '') + '</div><details><summary>响应体</summary><pre>' + escapeHtml(item.response_body || '') + '</pre></details></td>' +
            '</tr>').join('');
          }

          function resetForm() {
            const form = document.getElementById('site-form');
            form.reset();
            form.elements.id.value = '';
            form.elements.enabled.checked = true;
          }

          async function refreshAll() {
            await Promise.all([loadSummary(), loadSites(), loadLogs()]);
          }

          document.getElementById('site-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const payload = {
              name: form.elements.name.value.trim(),
              baseUrl: form.elements.baseUrl.value.trim(),
              accessToken: form.elements.accessToken.value.trim(),
              userId: Number(form.elements.userId.value),
              enabled: form.elements.enabled.checked,
              notes: form.elements.notes.value.trim()
            };
            const id = form.elements.id.value;
            await api(id ? '/api/sites/' + id : '/api/sites', {
              method: id ? 'PUT' : 'POST',
              body: JSON.stringify(payload)
            });
            resetForm();
            await refreshAll();
          });

          document.getElementById('site-table').addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const id = Number(button.dataset.id);
            const action = button.dataset.action;
            const site = getSiteById(id);
            if (!site) return;

            if (action === 'edit') {
              const form = document.getElementById('site-form');
              form.elements.id.value = String(site.id);
              form.elements.name.value = site.name;
              form.elements.baseUrl.value = site.base_url;
              form.elements.accessToken.value = site.access_token;
              form.elements.userId.value = String(site.user_id);
              form.elements.enabled.checked = Boolean(site.enabled);
              form.elements.notes.value = site.notes || '';
              window.scrollTo({ top: 0, behavior: 'smooth' });
              return;
            }

            if (action === 'delete') {
              if (!confirm('确认删除站点 ' + site.name + ' 吗？')) return;
              await api('/api/sites/' + id, { method: 'DELETE' });
              await refreshAll();
              return;
            }

            if (action === 'run') {
              await api('/api/checkin/run', {
                method: 'POST',
                body: JSON.stringify({ siteIds: [id] })
              });
              await refreshAll();
            }
          });

          document.getElementById('run-all').addEventListener('click', async () => {
            await api('/api/checkin/run-all', { method: 'POST' });
            await refreshAll();
          });

          document.getElementById('refresh-sites').addEventListener('click', loadSites);
          document.getElementById('refresh-logs').addEventListener('click', loadLogs);
          document.getElementById('reset-form').addEventListener('click', resetForm);

          document.getElementById('import-file').addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const text = await file.text();
            document.getElementById('import-json').value = text;
          });

          document.getElementById('import-submit').addEventListener('click', async () => {
            const text = document.getElementById('import-json').value.trim();
            if (!text) {
              throw new Error('请先提供 JSON 数据');
            }
            const items = JSON.parse(text);
            await api('/api/sites/import', {
              method: 'POST',
              body: JSON.stringify({ items })
            });
            document.getElementById('import-json').value = '';
            document.getElementById('import-file').value = '';
            await refreshAll();
          });

          refreshAll().catch((error) => {
            alert(error.message || '加载失败');
          });
        </script>
      </body>
    </html>`;
}

const styles = `
  :root {
    --bg: #f4efe7;
    --surface: rgba(255, 250, 244, 0.88);
    --text: #1f1a17;
    --muted: #6f6258;
    --line: rgba(81, 60, 40, 0.14);
    --accent: #c75c2f;
    --accent-dark: #8e3a15;
    --ok: #2f7d4a;
    --warn: #986914;
    --error: #9d2f2f;
    --shadow: 0 20px 50px rgba(110, 73, 33, 0.13);
    --radius: 24px;
    --font: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--text);
    font-family: var(--font);
    background:
      radial-gradient(circle at top left, rgba(232, 154, 102, 0.24), transparent 34%),
      radial-gradient(circle at bottom right, rgba(70, 126, 132, 0.18), transparent 30%),
      linear-gradient(135deg, #f8f3eb, #f2e7dc 42%, #efe7df 100%);
    min-height: 100vh;
  }

  .login-body {
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .login-shell,
  .app-shell {
    width: min(1180px, calc(100vw - 32px));
    margin: 0 auto;
    padding: 28px 0 48px;
  }

  .login-card,
  .panel,
  .stat-card,
  .latest-run,
  .hero {
    background: var(--surface);
    backdrop-filter: blur(16px);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }

  .login-card {
    max-width: 480px;
    margin: 10vh auto 0;
    padding: 32px;
  }

  .hero {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    padding: 28px;
    margin-bottom: 18px;
  }

  .hero-actions,
  .action-row,
  .stack {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .stack {
    flex-direction: column;
    align-items: stretch;
  }

  .eyebrow {
    margin: 0 0 10px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 12px;
    color: var(--accent-dark);
  }

  h1, h2 {
    margin: 0;
  }

  h1 {
    font-size: clamp(30px, 4vw, 46px);
  }

  h2 {
    font-size: 24px;
    margin-bottom: 6px;
  }

  .muted {
    color: var(--muted);
  }

  .tiny {
    font-size: 12px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 18px;
  }

  .stat-card,
  .latest-run {
    padding: 20px;
  }

  .stat-card span {
    display: block;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .stat-card strong {
    font-size: 34px;
  }

  .panel {
    padding: 22px;
    margin-bottom: 18px;
  }

  .panel-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 18px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }

  .wide {
    grid-column: 1 / -1;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-weight: 600;
  }

  input, textarea, button {
    font: inherit;
  }

  input, textarea {
    width: 100%;
    border-radius: 16px;
    border: 1px solid rgba(95, 68, 43, 0.16);
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.78);
    color: var(--text);
  }

  .toggle {
    justify-content: flex-end;
  }

  .toggle input {
    width: auto;
    align-self: flex-start;
    transform: scale(1.2);
  }

  button {
    border: 0;
    border-radius: 999px;
    padding: 12px 18px;
    background: linear-gradient(135deg, var(--accent), #df8156);
    color: white;
    cursor: pointer;
    transition: transform 120ms ease, opacity 120ms ease;
  }

  button:hover {
    transform: translateY(-1px);
  }

  button.secondary {
    background: rgba(255, 255, 255, 0.78);
    color: var(--text);
    border: 1px solid var(--line);
  }

  button.danger {
    background: rgba(157, 47, 47, 0.9);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(94, 75, 57, 0.1);
    color: var(--text);
    font-size: 12px;
  }

  .pill.ok,
  .pill.success {
    background: rgba(47, 125, 74, 0.14);
    color: var(--ok);
  }

  .pill.failed,
  .pill.error {
    background: rgba(157, 47, 47, 0.12);
    color: var(--error);
  }

  .pill.idle {
    background: rgba(152, 105, 20, 0.12);
    color: var(--warn);
  }

  .table-wrap {
    overflow: auto;
    border-radius: 20px;
    border: 1px solid var(--line);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 920px;
    background: rgba(255, 251, 246, 0.72);
  }

  th, td {
    padding: 14px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    vertical-align: top;
  }

  th {
    color: var(--muted);
    font-size: 13px;
    background: rgba(255, 247, 239, 0.86);
  }

  pre {
    margin: 8px 0 0;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
  }

  details summary {
    cursor: pointer;
    color: var(--accent-dark);
    margin-top: 8px;
  }

  @media (max-width: 760px) {
    .hero,
    .panel-head {
      flex-direction: column;
    }

    .app-shell,
    .login-shell {
      width: min(100vw - 20px, 1180px);
      padding-top: 12px;
    }

    .panel,
    .hero,
    .login-card {
      border-radius: 20px;
      padding: 18px;
    }
  }
`;
