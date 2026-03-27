import type { Express } from "express";
import type { Server } from "http";
import { storage as _baseStorage, loadPublishedIds as _sqliteLoadIds, markPublishedId as _sqliteMarkId } from "./storage";
import * as _storageModule from "./storage";

// Unified storage proxy: reads activeStorage at call time so PG is used after initStorage()
const storage = new Proxy({} as typeof _baseStorage, {
  get(_t, prop) {
    const backend = (_storageModule as any).activeStorage ?? _baseStorage;
    const val = (backend as any)[prop];
    return typeof val === "function" ? val.bind(backend) : val;
  }
});

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

import { fetchOzonReviewsStreaming, postOzonResponse, testOzonCredentials, parseOzonCsvReviews, OzonPremiumPlusError, fetchOzonQuestions, postOzonQuestionAnswer } from "./ozon";
import { generateAiResponse, generateQuestionAnswer, type AiProvider } from "./ai";
import {
  registerUser,
  loginUser,
  getAllUsersAsync,
  updateUserStatusAsync,
  deleteUserAsync,
  requireAuth,
  requireAdmin,
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

  // Register new user
  app.post("/api/auth/register", async (req, res) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password || !name) {
      res.status(400).json({ error: "Укажите email, пароль и имя" });
      return;
    }
    const result = await registerUser(email, password, name);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ user: result.user });
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

  // ── Settings ───────────────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    const s = await storage.getSettings();
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

  app.post("/api/settings", async (req, res) => {
    try {
      const s = await storage.upsertSettings(req.body);
      res.json(s);
    } catch (e: unknown) {
      res.status(400).json({ error: String(e) });
    }
  });

  // ── AI Balance ──────────────────────────────────────────────────────────────
  app.get("/api/ai/balance", async (_req, res) => {
    const settings = await storage.getSettings();
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
  app.get("/api/stats", async (_req, res) => {
    const stats = await storage.getStats();
    let qStats = { total: 0, new: 0, pendingApproval: 0, approved: 0, published: 0, rejected: 0 };
    try { qStats = await (storage as any).getQuestionStats(); } catch {}
    res.json({ ...stats, questions: qStats });
  });

  // ── Analytics ────────────────────────────────────────────────────────────────
  // Returns time-series data grouped by local day/hour for the selected period
  // Query params: period=day|week|month|custom, from=ISO, to=ISO, tzOffset=minutes (e.g. -180 for MSK)
  app.get("/api/analytics", async (req, res) => {
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
      const allReviews = await storage.getReviews();
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
  app.get("/api/reviews", async (req, res) => {
    let reviews = await storage.getReviews();
    const { status, rating } = req.query;
    if (status && status !== "all") {
      reviews = reviews.filter((r) => r.status === status);
    }
    if (rating) {
      reviews = reviews.filter((r) => r.rating === Number(rating));
    }
    res.json(reviews);
  });

  app.get("/api/reviews/:id", async (req, res) => {
    const review = await storage.getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });
    res.json(review);
  });

  // ── Test Ozon credentials ────────────────────────────────────────────────
  app.post("/api/ozon/test", async (req, res) => {
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
  app.post("/api/reviews/import-csv", async (req, res) => {
    const { csvText } = req.body;
    if (!csvText) {
      return res.status(400).json({ error: "csvText required" });
    }
    try {
      const ozonReviews = parseOzonCsvReviews(csvText);
      let newCount = 0;
      for (const or of ozonReviews) {
        const existing = await storage.getReviewByOzonId(or.review_id);
        if (!existing) {
          await storage.createReview({
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

  app.get("/api/background-status", (_req, res) => {
    res.json({ busy: backgroundTasksRunning > 0, tasks: backgroundTasksRunning });
  });

  // ── Background auto-generate queue ──────────────────────────────────────
  // Auto-generates AI responses for all "new" text reviews after fetch
  async function runAutoGenerateQueue(
    settings: Awaited<ReturnType<typeof storage.getSettings>>
  ): Promise<void> {
    if (!settings) return;
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) return;

    const allReviews = await storage.getReviews();
    // Only text reviews (not auto-publishable) with status "new"
    const toGenerate = allReviews.filter(
      (r) => r.status === "new" && (r.reviewText ?? "").trim() !== ""
    );

    if (toGenerate.length === 0) return;
    console.log(`[auto-generate] Generating for ${toGenerate.length} text reviews`);

    for (const review of toGenerate) {
      try {
        await storage.updateReviewStatus(review.id, "generating");
        const responseText = await generateAiResponse({
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: review.reviewText,
          template: settings?.responseTemplate || undefined,
          apiKey,
          provider,
        });

        const existing = await storage.getResponseByReviewId(review.id);
        if (existing) {
          await storage.updateResponse(existing.id, { responseText, aiGenerated: true });
        } else {
          await storage.createResponse({
            reviewId: review.id,
            responseText,
            aiGenerated: true,
            sheetsRowId: "",
            approvedAt: null,
            publishedAt: null,
          });
        }
        await storage.updateReviewStatus(review.id, "pending_approval");
        console.log(`[auto-generate] Done: ${review.ozonReviewId}`);
      } catch (e) {
        console.error(`[auto-generate] Failed for ${review.ozonReviewId}:`, e);
        await storage.updateReviewStatus(review.id, "new");
      }
    }
    console.log(`[auto-generate] Queue complete`);
  }

  // ── Background auto-publish queue ────────────────────────────────────────
  // Runs after fetch completes — processes queued auto-publishable reviews asynchronously
  async function runAutoPublishQueue(
    reviewIds: number[],
    settings: Awaited<ReturnType<typeof storage.getSettings>>
  ): Promise<void> {
    if (!settings || reviewIds.length === 0) return;
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) return;

    console.log(`[auto-publish] Starting background queue: ${reviewIds.length} reviews`);

    for (const reviewId of reviewIds) {
      try {
        const review = await storage.getReviewById(reviewId);
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
        const savedResponse = await storage.createResponse({
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
          await storage.updateResponse(savedResponse.id, { publishedAt: now });
          await storage.updateReviewStatus(review.id, "published", { autoPublished: true });
          markPublishedId(review.ozonReviewId);
          // Record to persistent history
          storage.recordPublishHistory({
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
          await storage.updateReviewStatus(review.id, "pending_approval");
        }
      } catch (autoErr) {
        console.error(`[auto-publish] Error for reviewId=${reviewId}:`, autoErr);
      }
    }

    console.log(`[auto-publish] Queue done: ${reviewIds.length} processed`);
  }

  // ── Fetch from Ozon (streaming with progress via POST + ndjson) ────────────
  app.post("/api/reviews/fetch-from-ozon-stream", async (req, res) => {
    const settings = await storage.getSettings();
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

            const existing = await storage.getReviewByOzonId(or.review_id);
            if (existing) continue;

            const reviewRating = or.rating ?? 5;
            const reviewText = (or.text ?? "").trim();
            const isAutoPublishable = reviewRating >= 4 && reviewText === "";

            // Phase 1: save review quickly (no AI/Ozon calls here)
            const savedReview = await storage.createReview({
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

      const settingsSnap = await storage.getSettings();

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
      const stuckIds = (await storage.getReviews())
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
  app.post("/api/reviews/fetch-from-ozon", async (_req, res) => {
    const settings = await storage.getSettings();
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

            const existing = await storage.getReviewByOzonId(or.review_id);
            if (existing) {
              foundExisting = true;
              continue;
            }
            await storage.createReview({
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
  app.post("/api/reviews/process-stuck", async (_req, res) => {
    const settings = await storage.getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }
    const { apiKey } = getActiveApiKey(settings);
    if (!apiKey) return res.status(400).json({ error: "Настройте API ключ AI" });

    const reviews = await storage.getReviews();
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
  app.post("/api/reviews/clear-all", async (_req, res) => {
    try {
      await storage.clearAllData();
      res.json({ success: true });
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Add demo reviews ───────────────────────────────────────────────────────
  app.post("/api/reviews/add-demo", async (_req, res) => {
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
      const existing = await storage.getReviewByOzonId(d.ozonReviewId);
      if (!existing) {
        await storage.createReview(d);
        created++;
      }
    }
    res.json({ success: true, created });
  });

  // ── Generate AI response ───────────────────────────────────────────────────
  app.post("/api/reviews/:id/generate", async (req, res) => {
    const settings = await storage.getSettings();
    const { apiKey, provider } = getActiveApiKey(settings);
    if (!apiKey) {
      return res.status(400).json({ error: "Настройте API ключ выбранного провайдера в разделе Настройки" });
    }

    const review = await storage.getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Отзыв не найден" });

    try {
      await storage.updateReviewStatus(review.id, "generating");

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
      const existingResponse = await storage.getResponseByReviewId(review.id);
      let savedResponse;
      if (existingResponse) {
        savedResponse = await storage.updateResponse(existingResponse.id, {
          responseText,
          aiGenerated: true,
        });
      } else {
        savedResponse = await storage.createResponse({
          reviewId: review.id,
          responseText,
          aiGenerated: true,
          sheetsRowId: "",
          approvedAt: null,
          publishedAt: null,
        });
      }

      await storage.updateReviewStatus(review.id, "pending_approval");

      // Sheet is written only at publish time (not at generate time)

      const updated = await storage.getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      await storage.updateReviewStatus(review.id, "new");
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Generate all pending ──────────────────────────────────────────────────
  app.post("/api/reviews/generate-all", async (_req, res) => {
    const settings = await storage.getSettings();
    const { apiKey: allApiKey, provider: allProvider } = getActiveApiKey(settings);
    if (!allApiKey) {
      return res.status(400).json({ error: "Настройте API ключ выбранного провайдера" });
    }

    const reviews = await storage.getReviews();
    // Exclude auto-publishable reviews (4-5★ with no text) — they go through auto-publish queue
    const isAutoPublishable = (r: typeof reviews[0]) =>
      r.rating >= 4 && (r.reviewText ?? "").trim() === "";
    const toProcess = reviews.filter((r) => r.status === "new" && !isAutoPublishable(r));
    let processed = 0;

    for (const review of toProcess) {
      try {
        await storage.updateReviewStatus(review.id, "generating");
        const responseText = await generateAiResponse({
          productName: review.productName,
          authorName: review.authorName,
          rating: review.rating,
          reviewText: review.reviewText,
          template: settings?.responseTemplate || undefined,
          apiKey: allApiKey,
          provider: allProvider,
        });

        const existingResponse = await storage.getResponseByReviewId(review.id);
        let savedResponse;
        if (existingResponse) {
          savedResponse = await storage.updateResponse(existingResponse.id, {
            responseText,
            aiGenerated: true,
          });
        } else {
          savedResponse = await storage.createResponse({
            reviewId: review.id,
            responseText,
            aiGenerated: true,
            sheetsRowId: "",
            approvedAt: null,
            publishedAt: null,
          });
        }

        await storage.updateReviewStatus(review.id, "pending_approval");

        // Sheet is written only at publish time (not at generate time)
        processed++;
      } catch (e) {
        console.error(`Error generating for review ${review.id}:`, e);
        await storage.updateReviewStatus(review.id, "new");
      }
    }

    res.json({ success: true, processed });
  });

  // ── Update response text ───────────────────────────────────────────────────
  app.patch("/api/reviews/:id/response", async (req, res) => {
    const review = await storage.getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });

    const { responseText } = req.body;
    if (!responseText) return res.status(400).json({ error: "responseText required" });

    try {
      const existingResponse = await storage.getResponseByReviewId(review.id);
      if (existingResponse) {
        await storage.updateResponse(existingResponse.id, { responseText });
      } else {
        await storage.createResponse({
          reviewId: review.id,
          responseText,
          aiGenerated: false,
          sheetsRowId: "",
          approvedAt: null,
          publishedAt: null,
        });
      }
      const updated = await storage.getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Approve = publish immediately to Ozon ──────────────────────────────────
  app.post("/api/reviews/:id/approve", async (req, res) => {
    const settings = await storage.getSettings();
    const review = await storage.getReviewById(Number(req.params.id));
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
      await storage.updateResponse(response.id, { approvedAt: now, publishedAt: now });
      await storage.updateReviewStatus(review.id, "published");
      markPublishedId(review.ozonReviewId);
      // Record to persistent history
      storage.recordPublishHistory({
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

      const updated = await storage.getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });
  app.post("/api/reviews/:id/reject", async (req, res) => {
    const review = await storage.getReviewById(Number(req.params.id));
    if (!review) return res.status(404).json({ error: "Not found" });

    await storage.updateReviewStatus(review.id, "rejected");

    const updated = await storage.getReviewById(review.id);
    res.json(updated);
  });

  // ── Publish all approved reviews ────────────────────────────────────────────
  app.post("/api/reviews/publish-all-approved", async (_req, res) => {
    const settings = await storage.getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }

    const reviews = await storage.getReviews();
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
        await storage.updateResponse(review.response.id, { publishedAt: new Date() });
        await storage.updateReviewStatus(review.id, "published");
        markPublishedId(review.ozonReviewId);
        storage.recordPublishHistory({
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
  app.post("/api/reviews/:id/publish", async (req, res) => {
    const settings = await storage.getSettings();
    if (!settings?.ozonClientId || !settings?.ozonApiKey) {
      return res.status(400).json({ error: "Настройте Ozon API ключи" });
    }

    const review = await storage.getReviewById(Number(req.params.id));
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
      await storage.updateResponse(review.response.id, { publishedAt: new Date() });
      await storage.updateReviewStatus(review.id, "published");
      markPublishedId(review.ozonReviewId);
      storage.recordPublishHistory({
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
      const updated = await storage.getReviewById(review.id);
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Export to Excel ────────────────────────────────────────────────────────────────
  // GET /api/export/excel?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/api/export/excel", async (req, res) => {
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

      const rows = storage.getPublishHistory(fromISO, toISO);

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
      const questions = await (storage as any).getQuestions(filters);
      res.json(questions);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/sync — синхронизация вопросов с Ozon
  app.post("/api/questions/sync", requireAuth, async (req, res) => {
    try {
      const settings = await storage.getSettings();
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
          const existing = await (storage as any).getQuestionByOzonId(q.question_id);
          if (existing) { skipped++; continue; }

          await (storage as any).createQuestion({
            ozonQuestionId: q.question_id,
            productId: q.product_id,
            productName: q.product_name,
            ozonSku: String(q.sku),
            authorName: q.author_name,
            questionText: q.question_text,
            questionDate: q.created_at,
            status: q.is_answered ? "published" : "new",
            isAnswered: q.is_answered,
            autoPublished: false,
          });
          synced++;

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

  // POST /api/questions/:id/generate — сгенерировать ответ AI
  app.post("/api/questions/:id/generate", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await (storage as any).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }

      const settings = await storage.getSettings();
      const { apiKey, provider } = getActiveApiKey(settings);
      if (!apiKey) { res.status(400).json({ error: "Не настроен AI ключ" }); return; }

      await (storage as any).updateQuestionStatus(id, "generating");

      let aiText: string;
      try {
        aiText = await generateQuestionAnswer({
          questionText: question.questionText,
          productName: question.productName,
          template: (settings as any)?.questionTemplate || undefined,
          apiKey,
          provider,
        });
      } catch (e) {
        await (storage as any).updateQuestionStatus(id, "new");
        throw e;
      }

      // Upsert response
      const existing = await (storage as any).getQuestionResponseByQuestionId(id);
      if (existing) {
        await (storage as any).updateQuestionResponse(existing.id, {
          responseText: aiText,
          originalAiText: aiText,
          aiGenerated: true,
          approvedAt: null,
          publishedAt: null,
        });
      } else {
        await (storage as any).createQuestionResponse({
          questionId: id,
          responseText: aiText,
          originalAiText: aiText,
          aiGenerated: true,
        });
      }

      await (storage as any).updateQuestionStatus(id, "pending_approval");
      const updated = await (storage as any).getQuestionById(id);
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
      const existing = await (storage as any).getQuestionResponseByQuestionId(id);
      if (!existing) { res.status(404).json({ error: "Ответ не найден" }); return; }
      await (storage as any).updateQuestionResponse(existing.id, { responseText });
      const updated = await (storage as any).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/approve — одобрить ответ
  app.post("/api/questions/:id/approve", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await (storage as any).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }
      const resp = await (storage as any).getQuestionResponseByQuestionId(id);
      if (resp) {
        await (storage as any).updateQuestionResponse(resp.id, { approvedAt: new Date().toISOString() });
      }
      await (storage as any).updateQuestionStatus(id, "approved");
      const updated = await (storage as any).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/reject — отклонить вопрос
  app.post("/api/questions/:id/reject", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await (storage as any).updateQuestionStatus(id, "rejected");
      const updated = await (storage as any).getQuestionById(id);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/questions/:id/publish — опубликовать ответ на Ozon
  app.post("/api/questions/:id/publish", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const question = await (storage as any).getQuestionById(id);
      if (!question) { res.status(404).json({ error: "Вопрос не найден" }); return; }

      const resp = await (storage as any).getQuestionResponseByQuestionId(id);
      if (!resp?.responseText) {
        res.status(400).json({ error: "Нет текста ответа для публикации" });
        return;
      }

      const settings = await storage.getSettings();
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
      await (storage as any).updateQuestionResponse(resp.id, { publishedAt: now });
      await (storage as any).updateQuestionStatus(id, "published", { isAnswered: true, autoPublished: false });
      const updated = await (storage as any).getQuestionById(id);
      res.json({ status: "published", question: updated });
    } catch (e) {
      console.error("[questions/publish]", e);
      res.status(500).json({ error: String(e) });
    }
  });


}