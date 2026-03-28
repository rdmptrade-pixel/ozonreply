import type { Express } from "express";
import type { Server } from "http";
import { storage as _baseStorage, loadPublishedIds as _sqliteLoadIds, markPublishedId as _sqliteMarkId } from "./storage";
import * as _storageModule from "./storage";
import type { Settings } from "@shared/schema";

// Unified storage proxy: reads activeStorage at call time so PG is used after initStorage()
const storage = new Proxy({} as typeof _baseStorage, {
  get(_t, prop) {
    const backend = (_storageModule as any).activeStorage ?? _baseStorage;
    const val = (backend as any)[prop];
    return typeof val === "function" ? val.bind(backend) : val;
  }
});

// ── Tenant-aware storage helper ────────────────────────────────────────────────
// Returns a thin wrapper that injects tenantId into storage calls requiring it.
// Superadmin (tenantId = undefined/null) defaults to tenant 1 for backward compat.
function tStorage(tenantId: number | undefined | null) {
  const tid = tenantId ?? 1;
  return {
    getSettings: () => storage.getSettings(tid),
    upsertSettings: (data: any) => storage.upsertSettings(data, tid),
    getReviews: (filters?: any) => storage.getReviews(tid, filters),
    getReviewById: (id: number) => storage.getReviewById(id, tid),
    getReviewByOzonId: (ozonId: string) => storage.getReviewByOzonId(ozonId, tid),
    createReview: (data: any) => storage.createReview({ ...data, tenantId: tid }),
    updateReviewStatus: (id: number, status: string, extra?: any) => storage.updateReviewStatus(id, status, extra),
    getResponseByReviewId: (reviewId: number) => storage.getResponseByReviewId(reviewId),
    createResponse: (data: any) => storage.createResponse({ ...data, tenantId: tid }),
    updateResponse: (id: number, data: any) => storage.updateResponse(id, data),
    getStats: () => storage.getStats(tid),
    clearAllData: () => storage.clearAllData(tid),
    getPublishHistory: (from?: string, to?: string) => (storage as any).getPublishHistory(tid, from, to),
    recordPublishHistory: (entry: any) => (storage as any).recordPublishHistory({ ...entry, tenantId: tid }),
    getQuestions: (filters?: any) => storage.getQuestions(tid, filters),
    getQuestionById: (id: number) => storage.getQuestionById(id, tid),
    getQuestionByOzonId: (ozonId: string) => storage.getQuestionByOzonId(ozonId, tid),
    createQuestion: (data: any) => storage.createQuestion({ ...data, tenantId: tid }),
    updateQuestionStatus: (id: number, status: string, extra?: any) => storage.updateQuestionStatus(id, status, extra),
    getQuestionResponseByQuestionId: (qid: number) => storage.getQuestionResponseByQuestionId(qid),
    createQuestionResponse: (data: any) => storage.createQuestionResponse({ ...data, tenantId: tid }),
    updateQuestionResponse: (id: number, data: any) => storage.updateQuestionResponse(id, data),
    getQuestionStats: () => storage.getQuestionStats(tid),
  };
}

// Helper to get tenantId from authenticated request
function reqTenantId(req: any): number {
  return req.tenantId ?? 1;
}

// Published IDs: use PG when available, SQLite otherwise
async function loadPublishedIds(): Promise<Set<string>> {
  const pg = (globalThis as any).__pgPublishedIds;
  if (pg) return pg.loadPublishedIdsPg();
  return _sqliteLoadIds();
}

function markPublishedId(ozonReviewId: string): void {
  const pg = (globalThis as any).__pgPublishedIds;
  if (pg) { pg.markPublishedIdPg(ozonReviewId).catch(() => {}); return; }
  _sqliteMarkId(ozonReviewId);
}

import { fetchOzonReviewsStreaming, postOzonResponse, testOzonCredentials, parseOzonCsvReviews, OzonPremiumPlusError, fetchOzonQuestions, postOzonQuestionAnswer, fetchOzonQuestionAnswers, fetchOzonProductInfo, fetchAllOzonProductIds, fetchOzonProductInfoByOfferIds } from "./ozon";
// Shared pg pool for direct queries (only used when PG_CONNECTION_STRING is set)
import { Pool as PgPool } from "pg";
const _pgPool = process.env.PG_CONNECTION_STRING
  ? new PgPool({ connectionString: process.env.PG_CONNECTION_STRING, ssl: { rejectUnauthorized: false }, max: 3 })
  : null;
async function pgQuery(sql: string, params?: any[]): Promise<{ rows: any[] }> {
  if (!_pgPool) return { rows: [] };
  return _pgPool.query(sql, params);
}
import { generateAiResponse, generateQuestionAnswer, type AiProvider } from "./ai";
import {
  registerUser,
  loginUser,
  getAllUsersAsync,
  updateUserStatusAsync,
  deleteUserAsync,
  requireAuth,
  requireAdmin,
  requireSuperadmin,
  type AuthRequest,
} from "./auth";

function getActiveApiKey(settings: { aiProvider?: string; openaiApiKey?: string; deepseekApiKey?: string; perplexityApiKey?: string } | undefined): { apiKey: string; provider: AiProvider } {
  const provider = (settings?.aiProvider ?? "deepseek") as AiProvider;
  const keys: Record<AiProvider, string> = {
    deepseek: settings?.deepseekApiKey ?? "",
    perplexity: settings?.perplexityApiKey ?? "",
    openai: settings?.openaiApiKey ?? "",
  };
  return { apiKey: keys[provider] ?? "", provider };
}
export async function registerRoutes(httpServer: Server, app: Express): Promise<void> {
  // ── Auth ───────────────────────────────────────────────────────────────────

  // Register new user — creates a new tenant + owner
  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name, companyName } = req.body ?? {};
    if (!email || !password || !name) {
      res.status(400).json({ error: "Укажите email, пароль и имя" });
      return;
    }

    // Create tenant first (unless this is the superadmin email)
    const SUPERADMIN_EMAIL = "rd.mptrade@gmail.com";
    const isSuperadmin = email.toLowerCase().trim() === SUPERADMIN_EMAIL.toLowerCase();

    let tenantId: number | null = null;
    if (!isSuperadmin) {
      const tenant = await storage.createTenant({
        name: companyName || name,
        plan: "trial",
        status: "active",
      });
      tenantId = tenant.id;
    }

    const result = await registerUser(email, password, name, tenantId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ user: result.user, tenantId });
  });

  // Login
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: "Укажите email и пароль" });
      return;
    }
    const result = await loginUser(email, password);
    if (!result.ok) {
      res.status(401).json({ error: result.error });
      return;
    }
    res.json({ token: result.token, user: result.user });
  });

  // Get current user (validates token)
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: (req as AuthRequest).user });
  });

  // ── Admin: user management ─────────────────────────────────────────────────

  // List all users
  app.get("/api/admin/users", requireAdmin, async (_req, res) => {
    const users = await getAllUsersAsync();
    res.json(users.map(u => { const { passwordHash, approvedBy, ...pub } = u as any; return pub; }));
  });

  // Approve / reject / set role
  app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, role } = req.body ?? {};
    const adminUser = (req as AuthRequest).user!;

    if (status && !["approved", "rejected", "pending"].includes(status)) {
      res.status(400).json({ error: "Неверный статус" });
      return;
    }

    if (status) {
      const r = await updateUserStatusAsync(id, status, adminUser.email);
      if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    }

    if (role && ["admin", "user"].includes(role)) {
      // Update role — works for both PG and file-based storage
      const pg = (globalThis as any).__pgUsers;
      if (pg) {
        await pg.updateUserPg(id, { role });
      } else {
        const fs = require("fs");
        const path = require("path");
        const usersFile = path.join(process.cwd(), "data", "users.json");
        try {
          const allUsers = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
          const idx = allUsers.findIndex((u: any) => u.id === id);
          if (idx !== -1) { allUsers[idx].role = role; fs.writeFileSync(usersFile, JSON.stringify(allUsers, null, 2)); }
        } catch {}
      }
    }

    res.json({ ok: true });
  });

  // Delete user
  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const adminUser = (req as AuthRequest).user!;
    if (adminUser.id === id) {
      res.status(400).json({ error: "Нельзя удалить собственный аккаунт" });
      return;
    }
    const r = await deleteUserAsync(id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ ok: true });
  });

  // ── Tenants (superadmin only) ────────────────────────────────────────────────

  // List all tenants
  app.get("/api/admin/tenants", requireSuperadmin, async (_req, res) => {
    const tenants = await storage.getTenants();
    // Add per-tenant user count
    const users = await getAllUsersAsync();
    const result = tenants.map((t: any) => ({
      ...t,
      userCount: users.filter((u: any) => u.tenantId === t.id).length,
    }));
    res.json(result);
  });

  // Get single tenant
  app.get("/api/admin/tenants/:id", requireSuperadmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const tenant = await storage.getTenantById(id);
    if (!tenant) { res.status(404).json({ error: "Тенант не найден" }); return; }
    res.json(tenant);
  });

  // Update tenant (plan, status)
  app.patch("/api/admin/tenants/:id", requireSuperadmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { plan, status, name } = req.body ?? {};
    const allowed: any = {};
    if (plan && ["trial", "paid", "suspended"].includes(plan)) allowed.plan = plan;
    if (status && ["active", "suspended"].includes(status)) allowed.status = status;
    if (name) allowed.name = name;
    const tenant = await storage.updateTenant(id, allowed);
    res.json(tenant);
  });

  // Suspend tenant
  app.post("/api/admin/tenants/:id/suspend", requireSuperadmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const tenant = await storage.updateTenant(id, { status: "suspended" });
    res.json(tenant);
  });

  // Activate tenant
  app.post("/api/admin/tenants/:id/activate", requireSuperadmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const tenant = await storage.updateTenant(id, { status: "active" });
    res.json(tenant);
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  app.get("/api/settings", requireAuth, async (req, res) => {
    const s = await tStorage(reqTenantId(req)).getSettings();
    res.json(s ?? {
      id: 0,
      ozonClientId: "",
      ozonApiKey: "",
      openaiApiKey: "",
      deepseekApiKey: "",
      perplexityApiKey: "",
      aiProvider: "deepseek",
      googleSheetsId: "",
      responseTemplate: "",
      autoPublish: false,
      syncInterval: 30,
    });
  });

  app.post("/api/settings", requireAuth, async (req, res) => {
    try {
      const s = await tStorage(reqTenantId(req)).upsertSettings(req.body);
      res.json(s);
    } catch (e: unknown) {
      res.status(400).json({ error: String(e) });
    }
  });

  // ── AI Balance ──────────────────────────────────────────────────────────────
  app.get("/api/ai/balance", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) return res.json({ available: false, error: "Нет API ключа" });

    try {
      if (provider === "deepseek") {
        const r = await fetch("https://api.deepseek.com/user/balance", {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });
        if (!r.ok) return res.json({ available: false, error: `HTTP ${r.status}` });
        const data = await r.json() as { is_available: boolean; balance_infos: { currency: string; total_balance: string; topped_up_balance: string }[] };
        const usd = data.balance_infos?.find((b) => b.currency === "USD");
        return res.json({
          available: data.is_available,
          balance: usd ? parseFloat(usd.total_balance) : null,
          currency: "USD",
          provider: "DeepSeek",
        });
      }
      // Perplexity не имеет публичного API баланса
      return res.json({ available: true, balance: null, provider: "Perplexity", error: "Баланс недоступен для Perplexity" });
    } catch (e: unknown) {
      return res.json({ available: false, error: String(e) });
    }
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get("/api/stats", requireAuth, async (req, res) => {
    const stats = await tStorage(reqTenantId(req)).getStats();
    let qStats = { total: 0, new: 0, pendingApproval: 0, approved: 0, published: 0, rejected: 0 };
    try { qStats = await tStorage(reqTenantId(req)).getQuestionStats(); } catch {}
    res.json({ ...stats, questions: qStats });
  });

  // ── Analytics ────────────────────────────────────────────────────────────────
  // Returns time-series data grouped by local day/hour for the selected period
  // Query params: period=day|week|month|custom, from=ISO, to=ISO, tzOffset=minutes (e.g. -180 for MSK)
  app.get("/api/analytics", requireAuth, async (req, res) => {
    try {
      const { period, from, to, tzOffset: tzOffsetStr } = req.query as Record<string, string>;

      // tzOffset: client's getTimezoneOffset() which is negative for UTC+ zones
      // e.g. Moscow = -180 (UTC+3). Convert to milliseconds for shifting.
      const tzOffsetMin = tzOffsetStr ? parseInt(tzOffsetStr, 10) : 0;
      // Shift in ms to convert UTC midnight to local midnight
      const tzShiftMs = -tzOffsetMin * 60 * 1000; // positive for UTC+ zones
      // SQLite time modifier string e.g. "+3 hours" for MSK
      const tzHours = -tzOffsetMin / 60;
      const sqlTzModifier = tzHours >= 0 ? `+${tzHours} hours` : `${tzHours} hours`;

      // Calculate date range in local time, then convert to UTC for DB query
      const nowUtc = Date.now();
      // "now" in local time as a Date (shifted)
      const nowLocal = new Date(nowUtc + tzShiftMs);

      let dateFrom: Date;
      let dateTo: Date;

      if (period === "day") {
        // Local today: 00:00..23:59 in local time → convert back to UTC
        const localMidnight = new Date(nowLocal);
        localMidnight.setUTCHours(0, 0, 0, 0);
        dateFrom = new Date(localMidnight.getTime() - tzShiftMs);
        dateTo = new Date(dateFrom.getTime() + 24 * 60 * 60 * 1000 - 1);
      } else if (period === "week") {
        const localMidnightToday = new Date(nowLocal);
        localMidnightToday.setUTCHours(0, 0, 0, 0);
        const localMidnight7ago = new Date(localMidnightToday.getTime() - 6 * 24 * 60 * 60 * 1000);
        dateFrom = new Date(localMidnight7ago.getTime() - tzShiftMs);
        const localMidnightEnd = new Date(localMidnightToday);
        dateTo = new Date(localMidnightEnd.getTime() - tzShiftMs + 24 * 60 * 60 * 1000 - 1);
      } else if (period === "custom" && from && to) {
        // from/to are YYYY-MM-DD local dates — treat as local midnight
        const [fy, fm, fd] = from.split("-").map(Number);
        const [ty, tm, td] = to.split("-").map(Number);
        const localFrom = new Date(Date.UTC(fy, fm - 1, fd, 0, 0, 0, 0));
        const localTo = new Date(Date.UTC(ty, tm - 1, td, 23, 59, 59, 999));
        dateFrom = new Date(localFrom.getTime() - tzShiftMs);
        dateTo = new Date(localTo.getTime() - tzShiftMs);
      } else {
        // default: month (30 days)
        const localMidnightToday = new Date(nowLocal);
        localMidnightToday.setUTCHours(0, 0, 0, 0);
        const localMidnight30ago = new Date(localMidnightToday.getTime() - 29 * 24 * 60 * 60 * 1000);
        dateFrom = new Date(localMidnight30ago.getTime() - tzShiftMs);
        dateTo = new Date(localMidnightToday.getTime() - tzShiftMs + 24 * 60 * 60 * 1000 - 1);
      }

      const fromISO = dateFrom.toISOString();
      const toISO = dateTo.toISOString();

      // Fetch all reviews in range and group in JS — works for both SQLite and PostgreSQL.
      // Use created_at (when loaded into system) for time-series grouping.
      const allReviews = await tStorage(reqTenantId(req)).getReviews();
      const inRange = allReviews.filter((r) => {
        const ts = r.createdAt;
        return ts >= fromISO && ts <= toISO;
      });

      // Rating distribution
      const ratingDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const r of inRange) {
        if (r.rating >= 1 && r.rating <= 5) ratingDist[r.rating]++;
      }

      // Fill gaps: generate all days in range so chart has no holes
      const series: { day: string; total: number; auto: number; manual: number; pending: number }[] = [];

      // For "day" period, group by LOCAL hour
      if (period === "day") {
        const hourBuckets: Record<string, { total: number; auto: number; manual: number; pending: number }> = {};
        for (const r of inRange) {
          const localDate = new Date(new Date(r.createdAt).getTime() + tzShiftMs);
          const hour = String(localDate.getUTCHours()).padStart(2, "0");
          if (!hourBuckets[hour]) hourBuckets[hour] = { total: 0, auto: 0, manual: 0, pending: 0 };
          hourBuckets[hour].total++;
          if (r.status === "published" && r.autoPublished) hourBuckets[hour].auto++;
          else if (r.status === "published" && !r.autoPublished) hourBuckets[hour].manual++;
          else if (["new", "generating", "pending_approval"].includes(r.status)) hourBuckets[hour].pending++;
        }
        for (let h = 0; h < 24; h++) {
          const key = String(h).padStart(2, "0");
          const found = hourBuckets[key];
          series.push({ day: `${key}:00`, total: found?.total ?? 0, auto: found?.auto ?? 0, manual: found?.manual ?? 0, pending: found?.pending ?? 0 });
        }
      } else {
        // Group by local day
        const dayBuckets: Record<string, { total: number; auto: number; manual: number; pending: number }> = {};
        for (const r of inRange) {
          const localDate = new Date(new Date(r.createdAt).getTime() + tzShiftMs);
          const key = localDate.toISOString().slice(0, 10);
          if (!dayBuckets[key]) dayBuckets[key] = { total: 0, auto: 0, manual: 0, pending: 0 };
          dayBuckets[key].total++;
          if (r.status === "published" && r.autoPublished) dayBuckets[key].auto++;
          else if (r.status === "published" && !r.autoPublished) dayBuckets[key].manual++;
          else if (["new", "generating", "pending_approval"].includes(r.status)) dayBuckets[key].pending++;
        }
        // Fill by local day
        const cur = new Date(dateFrom.getTime() + tzShiftMs); // shift to local
        cur.setUTCHours(0, 0, 0, 0);
        const end = new Date(dateTo.getTime() + tzShiftMs);
        end.setUTCHours(0, 0, 0, 0);
        while (cur <= end) {
          const key = cur.toISOString().slice(0, 10);
          const found = dayBuckets[key];
          series.push({ day: key, total: found?.total ?? 0, auto: found?.auto ?? 0, manual: found?.manual ?? 0, pending: found?.pending ?? 0 });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }

      res.json({ series, ratingDist, from: fromISO, to: toISO });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Reviews list ───────────────────────────────────────────────────────────
  app.get("/api/reviews", requireAuth, async (req, res) => {
    let reviews = await tStorage(reqTenantId(req)).getReviews();
    const { status, rating } = req.query;
    if (status && status !== "all") {
      reviews = reviews.filter((r) => r.status === status);
    }
    if (rating) {
      reviews = reviews.filter((r) => r.rating === Number(rating));
    }
    res.json(reviews);
  });

  app.get("/api/reviews/:id", requireAuth, async (req, res) => {
    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });
    res.json(review);
  });

  // ── Test Ozon credentials ────────────────────────────────────────────────
  app.post("/api/ozon/test", requireAuth, async (req, res) => {
    const { clientId, apiKey } = req.body;
    if (!clientId || !apiKey) {
      return res.status(400).json({ error: "Укажите Client-ID и API ключ" });
    }
    try {
      const result = await testOzonCredentials(clientId, apiKey);
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Import reviews from CSV ────────────────────────────────────────────────
  app.post("/api/reviews/import-csv", requireAuth, async (req, res) => {
    const { csvText } = req.body;
    if (!csvText) {
      return res.status(400).json({ error: "csvText required" });
    }
    try {
      const ozonReviews = parseOzonCsvReviews(csvText);
      let newCount = 0;
      for (const or of ozonReviews) {
        const existing = await tStorage(reqTenantId(req)).getReviewByOzonId(or.review_id);
        if (!existing) {
          await tStorage(reqTenantId(req)).createReview({
            ozonReviewId: or.review_id,
            productId: String(or.product_id ?? or.sku ?? ""),
            productName: or.product_name ?? "",
            authorName: or.author_name ?? "",
            rating: or.rating ?? 5,
            reviewText: or.text ?? "",
            reviewDate: or.created_at ?? new Date().toISOString(),
            hasPhotos: false,
            status: "new",
          });
          newCount++;
        }
      }
      res.json({ success: true, parsed: ozonReviews.length, new: newCount });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Background task counter ───────────────────────────────────────────────
  // Tracks whether background generation/publish is in progress
  let backgroundTasksRunning = 0;

  app.get("/api/background-status", requireAuth, (req, res) => {
    res.json({ busy: backgroundTasksRunning > 0, tasks: backgroundTasksRunning });
  });

  // ── Background auto-generate queue ──────────────────────────────────────
  // Auto-generates AI responses for all "new" text reviews after fetch
  async function runAutoGenerateQueue(
    settings: Settings | null
  ): Promise<void> {
    if (!settings) return;
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) return;

    const allReviews = await tStorage(reqTenantId(req)).getReviews();
    // Only text reviews (not auto-publishable) with status "new"
    const toGenerate = allReviews.filter(
      (r) => r.status === "new" && (r.reviewText ?? "").trim() !== ""
    );

    if (toGenerate.length === 0) return;
    console.log(`[auto-generate] Generating for ${toGenerate.length} text reviews`);

    for (const review of toGenerate) {
      try {
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "generating");
        const responseText = await generateAiResponse({
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: review.reviewText,
          template: settings?.responseTemplate || undefined,
          apiKey,
          provider,
        });

        const existing = await tStorage(reqTenantId(req)).getResponseByReviewId(review.id);
        if (existing) {
          await tStorage(reqTenantId(req)).updateResponse(existing.id, { responseText, aiGenerated: true });
        } else {
          await tStorage(reqTenantId(req)).createResponse({
            reviewId: review.id,
            responseText,
            aiGenerated: true,
            sheetsRowId: "",
            approvedAt: null,
            publishedAt: null,
          });
        }
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "pending_approval");
        console.log(`[auto-generate] Done: ${review.ozonReviewId}`);
      } catch (e) {
        console.error(`[auto-generate] Failed for ${review.ozonReviewId}:`, e);
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "new");
      }
    }
    console.log(`[auto-generate] Queue complete`);
  }

  // ── Background auto-publish queue ────────────────────────────────────────
  // Runs after fetch completes — processes queued auto-publishable reviews asynchronously
  async function runAutoPublishQueue(
    reviewIds: number[],
    settings: Settings | null
  ): Promise<void> {
    if (!settings || reviewIds.length === 0) return;
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) return;

    console.log(`[auto-publish] Starting background queue: ${reviewIds.length} reviews`);

    for (const reviewId of reviewIds) {
      try {
        const review = await tStorage(reqTenantId(req)).getReviewById(reviewId);
        if (!review || review.status !== "new") continue; // already processed

        const responseText = await generateAiResponse({
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: "",
          template: settings?.responseTemplate || undefined,
          apiKey,
          provider,
        });

        const now = new Date();
        const savedResponse = await tStorage(reqTenantId(req)).createResponse({
          reviewId: review.id,
          responseText,
          aiGenerated: true,
          sheetsRowId: "",
          approvedAt: now,
          publishedAt: null,
        });

        // Publish to Ozon
        let publishOk = false;
        try {
          await postOzonResponse(
            settings.ozonClientId!,
            settings.ozonApiKey!,
            review.ozonReviewId,
            responseText
          );
          publishOk = true;
        } catch (pubErr) {
          console.error(`[auto-publish] Ozon error for ${review.ozonReviewId}:`, pubErr);
        }

        if (publishOk) {
          await tStorage(reqTenantId(req)).updateResponse(savedResponse.id, { publishedAt: now });
          await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "published", { autoPublished: true });
          markPublishedId(review.ozonReviewId);
          // Record to persistent history
          tStorage(reqTenantId(req)).recordPublishHistory({
            ozonReviewId: review.ozonReviewId,
            ozonSku: review.ozonSku ?? review.productId ?? "",
            productName: review.productName,
            authorName: review.authorName,
            rating: review.rating,
            reviewText: review.reviewText ?? "",
            responseText,
            autoPublished: true,
            publishedAt: now.toISOString(),
          });
          console.log(`[auto-publish] OK: ${review.ozonReviewId}`);
        } else {
          await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "pending_approval");
        }
      } catch (autoErr) {
        console.error(`[auto-publish] Error for reviewId=${reviewId}:`, autoErr);
      }
    }

    console.log(`[auto-publish] Queue done: ${reviewIds.length} processed`);
  }

  // ── Fetch from Ozon (streaming with progress via POST + ndjson) ────────────
  app.post("/api/reviews/fetch-from-ozon-stream", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      res.status(400).json({ error: "Настройте Ozon API ключи в разделе Настройки" });
      return;
    }

    // Optional limit: how many new reviews to fetch at most (0 = unlimited)
    const maxNew: number = typeof req.body?.limit === "number" ? req.body.limit : 0;

    // ndjson streaming headers
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (data: object) => res.write(JSON.stringify(data) + "\n");

    let newCount = 0;
    let totalFetched = 0;
    // Reviews queued for background auto-publish (4-5★ no text)
    const autoPublishQueue: number[] = [];
    // Load persisted published IDs — survives clearAllData()
    const publishedIds = await loadPublishedIds();


    try {
      const { totalFetched: fetched, stopped } = await fetchOzonReviewsStreaming(
        settings.ozonClientId,
        settings.ozonApiKey,
        async (batch) => {
          totalFetched += batch.length;
          let pageNewCount = 0;
          let hitLimit = false;

          for (const or of batch) {
            // Skip reviews already answered on Ozon or with PROCESSED status
            if (or.is_answered) continue;
            if (or.status === "PROCESSED") continue;
            // Skip reviews we already published (even if DB was cleared)
            if (publishedIds.has(or.review_id)) continue;

            const existing = await tStorage(reqTenantId(req)).getReviewByOzonId(or.review_id);
            if (existing) continue;

            const reviewRating = or.rating ?? 5;
            const reviewText = (or.text ?? "").trim();
            const isAutoPublishable = reviewRating >= 4 && reviewText === "";

            // Phase 1: save review quickly (no AI/Ozon calls here)
            const savedReview = await tStorage(reqTenantId(req)).createReview({
              ozonReviewId: or.review_id,
              productId: String(or.product_id ?? or.sku ?? ""),
              productName: or.product_name ?? "",
              authorName: or.author_name ?? "",
              rating: reviewRating,
              reviewText: or.text ?? "",
              reviewDate: or.created_at ?? new Date().toISOString(),
              hasPhotos: (or.photos_amount ?? or.media_files?.length ?? 0) > 0,
              status: "new",
              ozonSku: String(or.sku ?? ""),
              ozonStatus: or.status ?? "UNPROCESSED",
              isAnswered: false,
            });
            newCount++;
            pageNewCount++;

            // Queue for background auto-publish instead of blocking here
            if (isAutoPublishable) {
              autoPublishQueue.push(savedReview.id);
            }
            // Text reviews (manual) are written to sheet AFTER AI response is generated,
            // not at fetch time (empty rows without answers are useless in the sheet)

            // Check limit
            if (maxNew > 0 && newCount >= maxNew) {
              hitLimit = true;
              break;
            }
          }

          // Send progress update after each page
          send({ type: "progress", fetched: totalFetched, new: newCount });

          if (hitLimit) return false;
          // Always continue fetching — Ozon filters UNPROCESSED, so everything
          // returned is potentially actionable. Never stop early based on known IDs.
          return true;
        }
      );

      // Phase 1 complete — respond to client immediately
      send({ type: "done", fetched, new: newCount, stopped, autoPublished: autoPublishQueue.length, autoPublishPending: autoPublishQueue.length });
      res.end();

      const settingsSnap = await tStorage(reqTenantId(req)).getSettings();

      // Phase 2: run auto-publish in background (after response sent)
      if (autoPublishQueue.length > 0) {
        backgroundTasksRunning++;
        runAutoPublishQueue(autoPublishQueue, settingsSnap)
          .catch((err) => console.error("[auto-publish] Queue crashed:", err))
          .finally(() => { backgroundTasksRunning = Math.max(0, backgroundTasksRunning - 1); });
      }

      // Phase 3: auto-generate AI responses for all new text reviews in background
      backgroundTasksRunning++;
      runAutoGenerateQueue(settingsSnap)
        .catch((err) => console.error("[auto-generate] Queue crashed:", err))
        .finally(() => { backgroundTasksRunning = Math.max(0, backgroundTasksRunning - 1); });

      // Phase 4: catch any stuck auto-publishable reviews (4-5★ no text) missed during load
      const stuckIds = (await tStorage(reqTenantId(req)).getReviews())
        .filter((r) => r.status === "new" && (r.reviewText ?? "").trim() === "" && r.rating >= 4)
        .map((r) => r.id);
      if (stuckIds.length > 0) {
        console.log(`[stuck-cleanup] Found ${stuckIds.length} stuck auto-publishable reviews, queuing...`);
        backgroundTasksRunning++;
        runAutoPublishQueue(stuckIds, settingsSnap)
          .catch((e) => console.error("[stuck-cleanup] crashed:", e))
          .finally(() => { backgroundTasksRunning = Math.max(0, backgroundTasksRunning - 1); });
      }
    } catch (e: unknown) {
      if (e instanceof OzonPremiumPlusError) {
        send({ type: "error", code: "PREMIUM_PLUS_REQUIRED", error: "Требуется подписка Premium Plus" });
      } else {
        send({ type: "error", error: String(e) });
      }
      res.end();
    }
  });

  // ── Fetch from Ozon (simple POST, kept for compatibility) ──────────────────
  app.post("/api/reviews/fetch-from-ozon", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи в разделе Настройки" });
    }

    try {
      let newCount = 0;
      let totalFetched = 0;

      const { totalFetched: fetched, stopped } = await fetchOzonReviewsStreaming(
        settings.ozonClientId,
        settings.ozonApiKey,
        async (batch) => {
          totalFetched += batch.length;
          let foundExisting = false;

          for (const or of batch) {
            // Skip reviews that already have an answer on Ozon
            if (or.is_answered) continue;

            const existing = await tStorage(reqTenantId(req)).getReviewByOzonId(or.review_id);
            if (existing) {
              foundExisting = true;
              continue;
            }
            await tStorage(reqTenantId(req)).createReview({
              ozonReviewId: or.review_id,
              productId: String(or.product_id ?? or.sku ?? ""),
              productName: or.product_name ?? "",
              authorName: or.author_name ?? "",
              rating: or.rating ?? 5,
              reviewText: or.text ?? "",
              reviewDate: or.created_at ?? new Date().toISOString(),
              hasPhotos: (or.media_files?.length ?? 0) > 0,
              status: "new",
              ozonSku: String(or.sku ?? ""),
              ozonStatus: or.status ?? "UNPROCESSED",
              isAnswered: false,
            });
            newCount++;
          }

          if (foundExisting && newCount > 0) return false;
          return true;
        }
      );

      res.json({ success: true, fetched, new: newCount, stopped });
    } catch (e: unknown) {
      if (e instanceof OzonPremiumPlusError) {
        return res.status(403).json({
          error: e.message,
          code: "PREMIUM_PLUS_REQUIRED",
        });
      }
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Process stuck auto-publishable reviews ──────────────────────────────────
  // Runs auto-publish for reviews stuck in 'new' status with no text (4-5★)
  app.post("/api/reviews/process-stuck", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }
    const { apiKey } = getActiveApiKey(settings);
    if (!apiKey) return res.status(400).json({ error: "Настройте API ключ AI" });

    const reviews = await tStorage(reqTenantId(req)).getReviews();
    const stuck = reviews
      .filter(r => r.status === "new" && (r.reviewText ?? "").trim() === "" && r.rating >= 4)
      .map(r => r.id);

    if (stuck.length === 0) return res.json({ success: true, queued: 0 });

    backgroundTasksRunning++;
    runAutoPublishQueue(stuck, settings)
      .catch(e => console.error("[process-stuck] crashed:", e))
      .finally(() => { backgroundTasksRunning = Math.max(0, backgroundTasksRunning - 1); });

    res.json({ success: true, queued: stuck.length });
  });

  // ── Clear all reviews & responses ───────────────────────────────────────────
  app.post("/api/reviews/clear-all", requireAuth, async (req, res) => {
    try {
      await tStorage(reqTenantId(req)).clearAllData();
      res.json({ success: true });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Add demo reviews ───────────────────────────────────────────────────────
  app.post("/api/reviews/add-demo", requireAuth, async (req, res) => {
    const demos = [
      {
        ozonReviewId: `demo_${Date.now()}_1`,
        productId: "123456",
        productName: "Наушники беспроводные Premium",
        authorName: "Александр К.",
        rating: 5,
        reviewText: "Отличные наушники! Звук просто потрясающий, батарея держит весь день. Очень доволен покупкой, рекомендую всем!",
        reviewDate: new Date().toISOString(),
        hasPhotos: false,
        status: "new" as const,
      },
      {
        ozonReviewId: `demo_${Date.now()}_2`,
        productId: "789012",
        productName: "Кроссовки спортивные Air Max",
        authorName: "Мария П.",
        rating: 3,
        reviewText: "Размер немного маломерит, пришлось брать на размер больше. В целом качество нормальное, но цена завышена.",
        reviewDate: new Date(Date.now() - 86400000).toISOString(),
        hasPhotos: false,
        status: "new" as const,
      },
      {
        ozonReviewId: `demo_${Date.now()}_3`,
        productId: "345678",
        productName: "Кофемашина автоматическая",
        authorName: "Дмитрий С.",
        rating: 1,
        reviewText: "Пришёл бракованный товар. Кофемашина не включается. Очень расстроен, ждал 2 недели.",
        reviewDate: new Date(Date.now() - 172800000).toISOString(),
        hasPhotos: true,
        status: "new" as const,
      },
      {
        ozonReviewId: `demo_${Date.now()}_4`,
        productId: "901234",
        productName: "Умные часы SmartWatch Pro",
        authorName: "Елена В.",
        rating: 4,
        reviewText: "Хорошие часы за свои деньги. Есть небольшие нюансы с синхронизацией, но в целом работают отлично.",
        reviewDate: new Date(Date.now() - 259200000).toISOString(),
        hasPhotos: false,
        status: "new" as const,
      },
    ];

    let created = 0;
    for (const d of demos) {
      const existing = await tStorage(reqTenantId(req)).getReviewByOzonId(d.ozonReviewId);
      if (!existing) {
        await tStorage(reqTenantId(req)).createReview(d);
        created++;
      }
    }
    res.json({ success: true, created });
  });

  // ── Generate AI response ───────────────────────────────────────────────────
  app.post("/api/reviews/:id/generate", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) {
      return res.status(400).json({ error: "Настройте API ключ выбранного провайдера в разделе Настройки" });
    }

    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Отзыв не найден" });

    try {
      await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "generating");

      const responseText = await generateAiResponse({
        productName: review.productName,
        authorName: review.authorName,
        rating: review.rating,
        reviewText: review.reviewText,
        template: settings?.responseTemplate || undefined,
        apiKey,
        provider,
      });

      // Create or update response
      const existingResponse = await tStorage(reqTenantId(req)).getResponseByReviewId(review.id);
      let savedResponse;
      if (existingResponse) {
        savedResponse = await tStorage(reqTenantId(req)).updateResponse(existingResponse.id, {
          responseText,
          aiGenerated: true,
        });
      } else {
        savedResponse = await tStorage(reqTenantId(req)).createResponse({
          reviewId: review.id,
          responseText,
          aiGenerated: true,
          sheetsRowId: "",
          approvedAt: null,
          publishedAt: null,
        });
      }

      await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "pending_approval");

      // Sheet is written only at publish time (not at generate time)

      const updated = await tStorage(reqTenantId(req)).getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "new");
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Generate all pending ──────────────────────────────────────────────────
  app.post("/api/reviews/generate-all", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    const { apiKey: allApiKey, provider: allProvider } = getActiveApiKey(settings);
    if (!allApiKey) {
      return res.status(400).json({ error: "Настройте API ключ выбранного провайдера" });
    }

    const reviews = await tStorage(reqTenantId(req)).getReviews();
    // Exclude auto-publishable reviews (4-5★ with no text) — they go through auto-publish queue
    const isAutoPublishable = (r: typeof reviews[0]) =>
      r.rating >= 4 && (r.reviewText ?? "").trim() === "";
    const toProcess = reviews.filter((r) => r.status === "new" && !isAutoPublishable(r));
    let processed = 0;

    for (const review of toProcess) {
      try {
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "generating");
        const responseText = await generateAiResponse({
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: review.reviewText,
          template: settings?.responseTemplate || undefined,
          apiKey: allApiKey,
          provider: allProvider,
        });

        const existingResponse = await tStorage(reqTenantId(req)).getResponseByReviewId(review.id);
        let savedResponse;
        if (existingResponse) {
          savedResponse = await tStorage(reqTenantId(req)).updateResponse(existingResponse.id, {
            responseText,
            aiGenerated: true,
          });
        } else {
          savedResponse = await tStorage(reqTenantId(req)).createResponse({
            reviewId: review.id,
            responseText,
            aiGenerated: true,
            sheetsRowId: "",
            approvedAt: null,
            publishedAt: null,
          });
        }

        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "pending_approval");

        // Sheet is written only at publish time (not at generate time)
        processed++;
      } catch (e) {
        console.error(`Error generating for review ${review.id}:`, e);
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "new");
      }
    }

    res.json({ success: true, processed });
  });

  // ── Update response text ───────────────────────────────────────────────────
  app.patch("/api/reviews/:id/response", requireAuth, async (req, res) => {
    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });

    const { responseText } = req.body;
    if (!responseText) return res.status(400).json({ error: "responseText required" });

    try {
      const existingResponse = await tStorage(reqTenantId(req)).getResponseByReviewId(review.id);
      if (existingResponse) {
        await tStorage(reqTenantId(req)).updateResponse(existingResponse.id, { responseText });
      } else {
        await tStorage(reqTenantId(req)).createResponse({
          reviewId: review.id,
          responseText,
          aiGenerated: false,
          sheetsRowId: "",
          approvedAt: null,
          publishedAt: null,
        });
      }
      const updated = await tStorage(reqTenantId(req)).getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Approve = publish immediately to Ozon ──────────────────────────────────
  app.post("/api/reviews/:id/approve", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });

    const response = review.response;
    if (!response) return res.status(400).json({ error: "Нет сгенерированного ответа" });
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }

    try {
      const now = new Date();
      await postOzonResponse(
        settings.ozonClientId,
        settings.ozonApiKey,
        review.ozonReviewId,
        response.responseText
      );
      await tStorage(reqTenantId(req)).updateResponse(response.id, { approvedAt: now, publishedAt: now });
      await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "published");
      markPublishedId(review.ozonReviewId);
      // Record to persistent history
      tStorage(reqTenantId(req)).recordPublishHistory({
        ozonReviewId: review.ozonReviewId,
        ozonSku: review.ozonSku ?? review.productId ?? "",
        productName: review.productName,
        authorName: review.authorName,
        rating: review.rating,
        reviewText: review.reviewText ?? "",
        responseText: response.responseText,
        originalAiText: (response as any).originalAiText ?? "",
        autoPublished: false,
        publishedAt: now.toISOString(),
      });

      const updated = await tStorage(reqTenantId(req)).getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });
  app.post("/api/reviews/:id/reject", requireAuth, async (req, res) => {
    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });

    await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "rejected");

    const updated = await tStorage(reqTenantId(req)).getReviewById(review.id);
    res.json(updated);
  });

  // ── Publish all approved reviews ────────────────────────────────────────────
  app.post("/api/reviews/publish-all-approved", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }

    const reviews = await tStorage(reqTenantId(req)).getReviews();
    const approved = reviews.filter((r) => r.status === "approved");
    let published = 0;
    const errors: string[] = [];

    for (const review of approved) {
      if (!review.response?.responseText) continue;
      try {
        await postOzonResponse(
          settings.ozonClientId,
          settings.ozonApiKey,
          review.ozonReviewId,
          review.response.responseText
        );
        await tStorage(reqTenantId(req)).updateResponse(review.response.id, { publishedAt: new Date() });
        await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "published");
        markPublishedId(review.ozonReviewId);
        tStorage(reqTenantId(req)).recordPublishHistory({
          ozonReviewId: review.ozonReviewId,
          ozonSku: review.ozonSku ?? review.productId ?? "",
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: review.reviewText ?? "",
          responseText: review.response.responseText,
          autoPublished: false,
          publishedAt: new Date().toISOString(),
        });
        published++;
      } catch (e) {
        errors.push(`#${review.id}: ${String(e)}`);
      }
    }

    res.json({ success: true, published, errors, total: approved.length });
  });

  // ── Publish to Ozon manually ───────────────────────────────────────────────
  app.post("/api/reviews/:id/publish", requireAuth, async (req, res) => {
    const settings = await tStorage(reqTenantId(req)).getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }

    const review = await tStorage(reqTenantId(req)).getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });
    if (!review.response?.responseText) {
      return res.status(400).json({ error: "Нет текста ответа" });
    }

    try {
      await postOzonResponse(
        settings.ozonClientId,
        settings.ozonApiKey,
        review.ozonReviewId,
        review.response.responseText
      );
      await tStorage(reqTenantId(req)).updateResponse(review.response.id, { publishedAt: new Date() });
      await tStorage(reqTenantId(req)).updateReviewStatus(review.id, "published");
      markPublishedId(review.ozonReviewId);
      tStorage(reqTenantId(req)).recordPublishHistory({
        ozonReviewId: review.ozonReviewId,
        ozonSku: review.ozonSku ?? review.productId ?? "",
        productName: review.productName,
        authorName: review.authorName,
        rating: review.rating,
        reviewText: review.reviewText ?? "",
        responseText: review.response.responseText,
        autoPublished: false,
        publishedAt: new Date().toISOString(),
      });
      const updated = await tStorage(reqTenantId(req)).getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Export to Excel ────────────────────────────────────────────────────────────────
  // GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/api/export/excel", requireAuth, async (req, res) => {
    try {
      const { from, to } = req.query as Record<string, string>;

      // Convert local date strings to UTC range
      let fromISO: string | undefined;
      let toISO: string | undefined;
      if (from) {
        fromISO = new Date(from + "T00:00:00.000Z").toISOString();
      }
      if (to) {
        const d = new Date(to + "T00:00:00.000Z");
        d.setUTCDate(d.getUTCDate() + 1); // include full end day
        toISO = d.toISOString();
      }

      const rows = tStorage(reqTenantId(req)).getPublishHistory(fromISO, toISO);

      const ExcelJSModule = await import("exceljs");
      const ExcelJS = (ExcelJSModule as any).default ?? ExcelJSModule;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "OzonReply";
      workbook.created = new Date();

      // Helper to style a header row
      const styleHeader = (sheet: ExcelJS.Worksheet, cols: any[]) => {
        sheet.columns = cols;
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
        headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
        headerRow.alignment = { vertical: "middle", horizontal: "center" };
        headerRow.height = 20;
        sheet.views = [{ state: "frozen", ySplit: 1 }];
      };

      const finalizeSheet = (sheet: ExcelJS.Worksheet, wrapCols: string[]) => {
        wrapCols.forEach(k => {
          sheet.getColumn(k).alignment = { wrapText: true, vertical: "top" };
        });
        sheet.eachRow((row, rowNum) => {
          if (rowNum > 1 && rowNum % 2 === 0) {
            row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FF" } };
          }
        });
      };

      const STAR = ["", "★", "★★", "★★★", "★★★★", "★★★★★"];

      // Sheet 1: Auto-published
      // Columns: Дата, SKU, Оценка, Ответ (no Товар, no Покупатель, no Текст отзыва)
      const autoSheet = workbook.addWorksheet("Авто-публикации");
      styleHeader(autoSheet, [
        { header: "Дата публикации", key: "published_at", width: 22 },
        { header: "SKU", key: "ozon_sku", width: 16 },
        { header: "Оценка", key: "rating", width: 8 },
        { header: "Ответ", key: "response_text", width: 70 },
      ]);

      // Sheet 2: Manual published
      // Columns: Дата, SKU, Оценка, Текст отзыва, Ответ (no Товар, no Покупатель)
      const manualSheet = workbook.addWorksheet("Ручные публикации");
      styleHeader(manualSheet, [
        { header: "Дата публикации", key: "published_at", width: 22 },
        { header: "SKU", key: "ozon_sku", width: 16 },
        { header: "Оценка", key: "rating", width: 8 },
        { header: "Текст отзыва", key: "review_text", width: 60 },
        { header: "Ответ", key: "response_text", width: 70 },
      ]);

      // Sheet 3: Edited responses (where original AI text differs from published text)
      const editedSheet = workbook.addWorksheet("Обучение ИИ");
      styleHeader(editedSheet, [
        { header: "Дата публикации", key: "published_at", width: 22 },
        { header: "SKU", key: "ozon_sku", width: 16 },
        { header: "Оценка", key: "rating", width: 8 },
        { header: "Текст отзыва", key: "review_text", width: 60 },
        { header: "Ответ ИИ", key: "original_ai_text", width: 70 },
        { header: "Отредактированный ответ", key: "response_text", width: 70 },
      ]);

      for (const row of rows) {
        const dt = row.published_at ? new Date(row.published_at) : null;
        const dateStr = dt ? dt.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : "";
        const stars = STAR[row.rating] ?? String(row.rating);

        if (row.auto_published) {
          autoSheet.addRow({
            published_at: dateStr,
            ozon_sku: row.ozon_sku,
            rating: stars,
            response_text: row.response_text,
          });
        } else {
          manualSheet.addRow({
            published_at: dateStr,
            ozon_sku: row.ozon_sku,
            rating: stars,
            review_text: row.review_text,
            response_text: row.response_text,
          });
        }

        // Add to edited sheet if response was modified (original differs from published)
        const orig = (row.original_ai_text ?? "").trim();
        const published = (row.response_text ?? "").trim();
        if (orig && orig !== published) {
          editedSheet.addRow({
            published_at: dateStr,
            ozon_sku: row.ozon_sku,
            rating: stars,
            review_text: row.review_text,
            original_ai_text: row.original_ai_text,
            response_text: row.response_text,
          });
        }
      }

      finalizeSheet(autoSheet, ["response_text"]);
      finalizeSheet(manualSheet, ["review_text", "response_text"]);
      finalizeSheet(editedSheet, ["review_text", "original_ai_text", "response_text"]);

      const fromStr = from || "all";
      const toStr = to || "now";
      const filename = `ozonreply_${fromStr}_${toStr}.xlsx`
        .replace(/[^a-z0-9_.-]/gi, "_");

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error("[export/excel]", e);
      res.status(500).json({ error: String(e) });
    }
  });
  // ────────────────────────────────────────────────────────────────────────────
  // Q&A: Вопросы покупателей
  // ────────────────────────────────────────────────────────────────────────────

  // GET /api/questions — список вопросов с фильтрами
  app.get("/api/questions", requireAuth, async (req, res) => {
    try {
      const status = String(req.query.status ?? "");
      const product_id = String(req.query.product_id ?? "");
      const filters: { status?: string; productId?: string } = {};
      if (status && status !== "all" && status !== "undefined") filters.status = status;
      if (product_id && product_id !== "undefined") filters.productId = product_id;
      const questions = await tStorage(reqTenantId(req)).getQuestions(filters);
      res.json(questions);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/sync — синхронизация вопросов с Ozon
  app.post("/api/questions/sync", requireAuth, async (req, res) => {
    try {
      const settings = await tStorage(reqTenantId(req)).getSettings();
      const questionApiKey = settings?.questionApiKey || settings?.ozonApiKey;
      if (!settings?.ozonClientId || !questionApiKey) {
        res.status(400).json({ error: "Не настроен API ключ для вопросов. Добавьте Question API Key в настройках." });
        return;
      }

      // Optional limit: how many new questions to fetch at most (0 = unlimited)
      const maxNew: number = typeof req.body?.limit === "number" ? req.body.limit : 0;

      let synced = 0;
      let skipped = 0;
      let lastId: string | undefined;
      const MAX_PAGES = 100;

      outer: for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchOzonQuestions(settings.ozonClientId, questionApiKey, lastId);
        if (!result.questions.length) break;

        for (const q of result.questions) {
          const existing = await tStorage(reqTenantId(req)).getQuestionByOzonId(q.question_id);

          if (existing) {
            // If already in DB but now answered — update status and save Ozon answer
            if (q.is_answered && existing.status === "new") {
              await tStorage(reqTenantId(req)).updateQuestionStatus(existing.id, "published", { isAnswered: true });
              // Load and save Ozon's original answer as knowledge base
              try {
                const answers = await fetchOzonQuestionAnswers(settings.ozonClientId, questionApiKey, q.question_id);
                if (answers.length > 0) {
                  const existingResp = await tStorage(reqTenantId(req)).getQuestionResponseByQuestionId(existing.id);
                  if (!existingResp) {
                    await tStorage(reqTenantId(req)).createQuestionResponse({
                      questionId: existing.id,
                      responseText: answers[0].answerText,
                      originalAiText: answers[0].answerText,
                      aiGenerated: false,
                    });
                  }
                }
              } catch {}
            }
            skipped++;
            continue;
          }

          const savedQ = await tStorage(reqTenantId(req)).createQuestion({
            ozonQuestionId: q.question_id,
            productId: q.product_id,
            productName: q.product_name,
            productUrl: q.product_url ?? "",
            ozonSku: String(q.sku),
            authorName: q.author_name,
            questionText: q.question_text,
            questionDate: q.created_at,
            status: q.is_answered ? "published" : "new",
            isAnswered: q.is_answered,
            autoPublished: false,
          });
          synced++;

          // For answered questions: load Ozon's answer as knowledge base
          if (q.is_answered && savedQ) {
            try {
              const answers = await fetchOzonQuestionAnswers(settings.ozonClientId, questionApiKey, q.question_id);
              if (answers.length > 0) {
                await tStorage(reqTenantId(req)).createQuestionResponse({
                  questionId: savedQ.id,
                  responseText: answers[0].answerText,
                  originalAiText: answers[0].answerText,
                  aiGenerated: false,
                });
              }
            } catch {}
          }

          // Stop if limit reached
          if (maxNew > 0 && synced >= maxNew) break outer;
        }

        if (!result.hasNext || !result.lastId) break;
        lastId = result.lastId;
      }

      res.json({ synced, skipped });
    } catch (e) {
      console.error("[questions/sync]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/products/sync-info — загрузить описания товаров из Ozon по всем SKU в базе
  app.post("/api/products/sync-info", requireAuth, async (_req, res) => {
    try {
      const settings = await tStorage(reqTenantId(req)).getSettings();
      const productApiKey = (settings as any)?.productApiKey || settings?.ozonApiKey;
      if (!settings?.ozonClientId || !productApiKey) {
        res.status(400).json({ error: "Не настроен Product API Key. Добавьте ключ с ролью Products в Настройках." });
        return;
      }

      // Collect unique SKUs directly via storage proxy (works for both PG and SQLite)
      let allSkus: string[] = [];
      try {
        // Try PG direct query first
        const skuRows = await pgQuery(
          "SELECT DISTINCT ozon_sku FROM questions WHERE ozon_sku != '' AND ozon_sku ~ '^[0-9]+$' ORDER BY ozon_sku"
        );
        allSkus = skuRows.rows.map((r: any) => r.ozon_sku).filter(Boolean);
      } catch {
        // Fallback: get from questions list
        const qs = await tStorage(reqTenantId(req)).getQuestions({}) ?? [];
        const skuSet = new Set<string>();
        for (const q of qs) { if (q.ozonSku && /^\d+$/.test(q.ozonSku)) skuSet.add(q.ozonSku); }
        allSkus = [...skuSet];
      }

      if (!allSkus.length) {
        res.json({ synced: 0, message: "Нет SKU — сначала синхронизируйте вопросы" });
        return;
      }

      console.log(`[products/sync-info] Found ${allSkus.length} unique SKUs`);

      // Fetch in batches of 100 (Ozon API limit)
      const BATCH = 100;
      let synced = 0;
      let errors = 0;
      for (let i = 0; i < allSkus.length; i += BATCH) {
        const batchSkus = allSkus.slice(i, i + BATCH);
        const batch = batchSkus.map(Number).filter(n => !isNaN(n) && n > 0);
        if (!batch.length) continue;
        try {
          const products = await fetchOzonProductInfo(settings.ozonClientId, productApiKey, batch);
          console.log(`[products/sync-info] Batch ${i}-${i+BATCH}: got ${products.length} products`);
          for (const p of products) {
            if (!p.sku || !p.name) continue;
            await (storage as any).upsertProductCache({
              ozonSku: p.sku,
              productId: p.productId,
              name: p.name,
              description: p.description || "",
              attributes: p.attributes || "",
            });
            // Update product_name in ALL questions with this SKU (overwrite with real name)
            try {
              await pgQuery(
                "UPDATE questions SET product_name = $1 WHERE ozon_sku = $2",
                [p.name, p.sku]
              );
            } catch {}
            synced++;
          }
        } catch (e) {
          console.error(`[products/sync-info] batch ${i} error:`, e);
          errors++;
        }
      }

      res.json({ synced, total: allSkus.length, errors });
    } catch (e) {
      console.error("[products/sync-info]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/products/sync-catalog — загрузить весь ассортимент магазина из Ozon
  app.post("/api/products/sync-catalog", requireAuth, async (_req, res) => {
    try {
      const settings = await tStorage(reqTenantId(req)).getSettings();
      const productApiKey = (settings as any)?.productApiKey || settings?.ozonApiKey;
      if (!settings?.ozonClientId || !productApiKey) {
        res.status(400).json({ error: "Не настроен Product API Key. Добавьте ключ с ролью Admin read only." });
        return;
      }

      // 1. Получаем все offer_id товаров магазина
      console.log("[sync-catalog] Fetching all product IDs...");
      const offerIds = await fetchAllOzonProductIds(settings.ozonClientId, productApiKey);
      console.log(`[sync-catalog] Total products: ${offerIds.length}`);

      if (!offerIds.length) {
        res.json({ synced: 0, total: 0 });
        return;
      }

      // 2. Загружаем инфо батчами по 100
      const BATCH = 100;
      let synced = 0;
      let errors = 0;

      for (let i = 0; i < offerIds.length; i += BATCH) {
        const batch = offerIds.slice(i, i + BATCH);
        try {
          const products = await fetchOzonProductInfoByOfferIds(settings.ozonClientId, productApiKey, batch);
          for (const p of products) {
            if (!p.name) continue;
            await (storage as any).upsertProductCache({
              ozonSku: p.sku || (p as any).offerId || String(i + synced),
              productId: p.productId,
              offerId: (p as any).offerId ?? "",
              name: p.name,
              description: p.description || "",
              attributes: p.attributes || "",
              category: (p as any).category || "",
            });
            // Обновить product_name в вопросах если SKU совпадает
            if (p.sku) {
              try {
                await pgQuery("UPDATE questions SET product_name=$1 WHERE ozon_sku=$2", [p.name, p.sku]);
              } catch {}
            }
            synced++;
          }
          console.log(`[sync-catalog] Batch ${i}-${i+BATCH}: saved ${products.length}`);
        } catch (e) {
          console.error(`[sync-catalog] batch ${i} error:`, e);
          errors++;
        }
      }

      res.json({ synced, total: offerIds.length, errors });
    } catch (e) {
      console.error("[sync-catalog]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/generate — сгенерировать ответ AI
  app.post("/api/questions/:id/generate", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await tStorage(reqTenantId(req)).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }

      const settings = await tStorage(reqTenantId(req)).getSettings();
      const { apiKey, provider } = getActiveApiKey(settings);
      if (!apiKey) { res.status(400).json({ error: "Не настроен AI ключ" }); return; }

      await tStorage(reqTenantId(req)).updateQuestionStatus(id, "generating");

      // Load product description from cache
      const productCache = question.ozonSku
        ? await (storage as any).getProductCache?.(question.ozonSku).catch(() => null)
        : null;

      // Load knowledge base: answered Q&A for same SKU
      const knowledgeBase = question.ozonSku
        ? await (storage as any).getKnowledgeBySku?.(question.ozonSku, 5).catch(() => [])
        : [];

      // Load similar products for recommendations
      const similarProducts = (productCache?.name || question.productName)
        ? await (storage as any).getSimilarProducts?.(question.ozonSku ?? "", productCache?.name || question.productName, 5).catch(() => [])
        : [];

      let aiText: string;
      try {
        aiText = await generateQuestionAnswer({
          questionText: question.questionText,
          productName: question.productName || productCache?.name || "",
          productDescription: productCache?.description || undefined,
          productAttributes: productCache?.attributes || undefined,
          knowledgeBase: knowledgeBase?.length ? knowledgeBase : undefined,
          similarProducts: similarProducts?.length ? similarProducts : undefined,
          template: (settings as any)?.questionTemplate || undefined,
          apiKey,
          provider,
        });
      } catch (e) {
        await tStorage(reqTenantId(req)).updateQuestionStatus(id, "new");
        throw e;
      }

      // Upsert response
      const existing = await tStorage(reqTenantId(req)).getQuestionResponseByQuestionId(id);
      if (existing) {
        await tStorage(reqTenantId(req)).updateQuestionResponse(existing.id, {
          responseText: aiText,
          originalAiText: aiText,
          aiGenerated: true,
          approvedAt: null,
          publishedAt: null,
        });
      } else {
        await tStorage(reqTenantId(req)).createQuestionResponse({
          questionId: id,
          responseText: aiText,
          originalAiText: aiText,
          aiGenerated: true,
        });
      }

      await tStorage(reqTenantId(req)).updateQuestionStatus(id, "pending_approval");
      const updated = await tStorage(reqTenantId(req)).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      console.error("[questions/generate]", e);
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/questions/:id/response — сохранить отредактированный ответ
  app.patch("/api/questions/:id/response", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { responseText } = req.body ?? {};
      if (!responseText) { res.status(400).json({ error: "Нет текста ответа" }); return; }
      const existing = await tStorage(reqTenantId(req)).getQuestionResponseByQuestionId(id);
      if (!existing) { res.status(404).json({ error: "Ответ не найден" }); return; }
      await tStorage(reqTenantId(req)).updateQuestionResponse(existing.id, { responseText });
      const updated = await tStorage(reqTenantId(req)).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/approve — одобрить ответ
  app.post("/api/questions/:id/approve", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await tStorage(reqTenantId(req)).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }
      const resp = await tStorage(reqTenantId(req)).getQuestionResponseByQuestionId(id);
      if (resp) {
        await tStorage(reqTenantId(req)).updateQuestionResponse(resp.id, { approvedAt: new Date().toISOString() });
      }
      await tStorage(reqTenantId(req)).updateQuestionStatus(id, "approved");
      const updated = await tStorage(reqTenantId(req)).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/reject — отклонить вопрос
  app.post("/api/questions/:id/reject", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await tStorage(reqTenantId(req)).updateQuestionStatus(id, "rejected");
      const updated = await tStorage(reqTenantId(req)).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/publish — опубликовать ответ на Ozon
  app.post("/api/questions/:id/publish", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await tStorage(reqTenantId(req)).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }

      const resp = await tStorage(reqTenantId(req)).getQuestionResponseByQuestionId(id);
      if (!resp?.responseText) {
        res.status(400).json({ error: "Нет текста ответа для публикации" });
        return;
      }

      const settings = await tStorage(reqTenantId(req)).getSettings();
      const questionApiKey = settings?.questionApiKey || settings?.ozonApiKey;
      if (!settings?.ozonClientId || !questionApiKey) {
        res.status(400).json({ error: "Не настроен API ключ для вопросов. Добавьте Question API Key в настройках." });
        return;
      }

      await postOzonQuestionAnswer(
        settings.ozonClientId,
        questionApiKey,
        question.ozonQuestionId,
        resp.responseText
      );

      const now = new Date().toISOString();
      await tStorage(reqTenantId(req)).updateQuestionResponse(resp.id, { publishedAt: now });
      await tStorage(reqTenantId(req)).updateQuestionStatus(id, "published", { isAnswered: true, autoPublished: false });
      const updated = await tStorage(reqTenantId(req)).getQuestionById(id);
      res.json({ status: "published", question: updated });
    } catch (e) {
      console.error("[questions/publish]", e);
      res.status(500).json({ error: String(e) });
    }
  });


}