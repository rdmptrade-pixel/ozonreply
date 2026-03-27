/**
 * PostgreSQL storage implementation for Timeweb App Platform deployment.
 * Used when DATABASE_URL env variable is set.
 */
import { Pool } from "pg";

// ── Connection pool ────────────────────────────────────────────────────────────
// SSL: always use rejectUnauthorized=false.
// Timeweb uses a self-signed CA chain — we encrypt traffic but skip chain verification.
const pgConnectionString = process.env.PG_CONNECTION_STRING;

const pool = new Pool({
  connectionString: pgConnectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Bootstrap tables ───────────────────────────────────────────────────────────
export async function initPgDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      ozon_review_id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 5,
      review_text TEXT NOT NULL DEFAULT '',
      review_date TEXT NOT NULL DEFAULT '',
      has_photos BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'new',
      ozon_sku TEXT NOT NULL DEFAULT '',
      ozon_status TEXT NOT NULL DEFAULT '',
      is_answered BOOLEAN NOT NULL DEFAULT FALSE,
      auto_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_ozon_id ON reviews(ozon_review_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL,
      response_text TEXT NOT NULL DEFAULT '',
      ai_generated BOOLEAN NOT NULL DEFAULT TRUE,
      sheets_row_id TEXT NOT NULL DEFAULT '',
      original_ai_text TEXT NOT NULL DEFAULT '',
      approved_at TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_responses_review_id ON responses(review_id);

    CREATE TABLE IF NOT EXISTS publish_history (
      id SERIAL PRIMARY KEY,
      ozon_review_id TEXT NOT NULL UNIQUE,
      ozon_sku TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 5,
      review_text TEXT NOT NULL DEFAULT '',
      response_text TEXT NOT NULL DEFAULT '',
      original_ai_text TEXT NOT NULL DEFAULT '',
      auto_published BOOLEAN NOT NULL DEFAULT FALSE,
      published_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_publish_history_published_at ON publish_history(published_at);

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ozon_client_id TEXT NOT NULL DEFAULT '',
      ozon_api_key TEXT NOT NULL DEFAULT '',
      question_api_key TEXT NOT NULL DEFAULT '',
      product_api_key TEXT NOT NULL DEFAULT '',
      openai_api_key TEXT NOT NULL DEFAULT '',
      deepseek_api_key TEXT NOT NULL DEFAULT '',
      perplexity_api_key TEXT NOT NULL DEFAULT '',
      ai_provider TEXT NOT NULL DEFAULT 'deepseek',
      google_sheets_id TEXT NOT NULL DEFAULT '',
      response_template TEXT NOT NULL DEFAULT '',
      question_template TEXT NOT NULL DEFAULT '',
      auto_publish BOOLEAN NOT NULL DEFAULT FALSE,
      sync_interval INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      ozon_question_id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      product_url TEXT NOT NULL DEFAULT '',
      ozon_sku TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      question_text TEXT NOT NULL DEFAULT '',
      question_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      is_answered BOOLEAN NOT NULL DEFAULT FALSE,
      auto_published BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_questions_ozon_id ON questions(ozon_question_id);
    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);

    CREATE TABLE IF NOT EXISTS question_responses (
      id SERIAL PRIMARY KEY,
      question_id INTEGER NOT NULL,
      response_text TEXT NOT NULL DEFAULT '',
      original_ai_text TEXT NOT NULL DEFAULT '',
      ai_generated BOOLEAN NOT NULL DEFAULT TRUE,
      approved_at TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_question_responses_question_id ON question_responses(question_id);

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT '',
      approved_at TEXT,
      approved_by TEXT
    );

    CREATE TABLE IF NOT EXISTS published_ids (
      ozon_review_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS product_cache (
      id SERIAL PRIMARY KEY,
      ozon_sku TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      attributes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_product_cache_sku ON product_cache(ozon_sku);
  `);

  // Seed settings from ENV on first run (if table is empty)
  const existing = await pool.query("SELECT id FROM settings LIMIT 1");
  if (existing.rowCount === 0) {
    await pool.query(`
      INSERT INTO settings (id, ozon_client_id, ozon_api_key, deepseek_api_key, perplexity_api_key, ai_provider)
      VALUES (1, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [
      process.env.OZON_CLIENT_ID ?? "",
      process.env.OZON_API_KEY ?? "",
      process.env.DEEPSEEK_API_KEY ?? "",
      process.env.PERPLEXITY_API_KEY ?? "",
      process.env.AI_PROVIDER ?? "deepseek",
    ]);
  }

  console.log("[pg] Database initialized");
}

function nowStr(): string {
  return new Date().toISOString();
}

// ── Published IDs ──────────────────────────────────────────────────────────────
export async function loadPublishedIdsPg(): Promise<Set<string>> {
  const r = await pool.query("SELECT ozon_review_id FROM published_ids");
  return new Set<string>(r.rows.map((row: any) => row.ozon_review_id));
}

export async function markPublishedIdPg(ozonReviewId: string): Promise<void> {
  await pool.query(
    "INSERT INTO published_ids (ozon_review_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [ozonReviewId]
  );
}

// ── Users ──────────────────────────────────────────────────────────────────────
export async function loadUsersPg(): Promise<any[]> {
  const r = await pool.query("SELECT * FROM users ORDER BY id");
  return r.rows.map(row => ({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  }));
}

export async function saveUserPg(user: any): Promise<void> {
  await pool.query(`
    INSERT INTO users (email, password_hash, name, role, status, created_at, approved_at, approved_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      approved_at = EXCLUDED.approved_at,
      approved_by = EXCLUDED.approved_by
  `, [user.email, user.passwordHash, user.name, user.role, user.status, user.createdAt, user.approvedAt ?? null, user.approvedBy ?? null]);
}

export async function updateUserPg(id: number, data: Partial<any>): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (data.status !== undefined) { sets.push(`status = $${i++}`); vals.push(data.status); }
  if (data.role !== undefined) { sets.push(`role = $${i++}`); vals.push(data.role); }
  if (data.approvedAt !== undefined) { sets.push(`approved_at = $${i++}`); vals.push(data.approvedAt); }
  if (data.approvedBy !== undefined) { sets.push(`approved_by = $${i++}`); vals.push(data.approvedBy); }
  if (sets.length === 0) return;
  vals.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

export async function deleteUserPg(id: number): Promise<void> {
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}

// ── Storage class ──────────────────────────────────────────────────────────────
export class PgStorage {

  async getSettings(): Promise<any> {
    // Self-healing migration for older DBs
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS question_template TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS question_api_key TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS product_api_key TEXT NOT NULL DEFAULT ''");
    } catch {}

    // Always read from DB first
    const r = await pool.query("SELECT * FROM settings WHERE id = 1");
    const dbRow = r.rowCount && r.rowCount > 0 ? r.rows[0] : null;

    // ENV provides defaults, but DB values ALWAYS win for any field set via UI
    const envSettings = this._getEnvSettings();
    if (envSettings) {
      return {
        ...envSettings,
        // All user-managed fields: prefer DB value if set (non-empty)
        questionApiKey:   dbRow?.question_api_key   || envSettings.questionApiKey   || "",
        productApiKey:    dbRow?.product_api_key     || envSettings.productApiKey    || "",
        openaiApiKey:     dbRow?.openai_api_key      || envSettings.openaiApiKey     || "",
        deepseekApiKey:   dbRow?.deepseek_api_key    || envSettings.deepseekApiKey   || "",
        perplexityApiKey: dbRow?.perplexity_api_key  || envSettings.perplexityApiKey || "",
        aiProvider:       dbRow?.ai_provider         || envSettings.aiProvider       || "deepseek",
        googleSheetsId:   dbRow?.google_sheets_id    || envSettings.googleSheetsId   || "",
        responseTemplate: dbRow?.response_template   || envSettings.responseTemplate || "",
        questionTemplate: dbRow?.question_template   || envSettings.questionTemplate || "",
        autoPublish:      dbRow?.auto_publish        ?? envSettings.autoPublish,
        syncInterval:     dbRow?.sync_interval       ?? envSettings.syncInterval,
      };
    }

    if (!dbRow) return null;
    return {
      id: 1,
      ozonClientId: dbRow.ozon_client_id,
      ozonApiKey: dbRow.ozon_api_key,
      questionApiKey: dbRow.question_api_key ?? "",
      productApiKey: dbRow.product_api_key ?? "",
      openaiApiKey: dbRow.openai_api_key,
      deepseekApiKey: dbRow.deepseek_api_key,
      perplexityApiKey: dbRow.perplexity_api_key,
      aiProvider: dbRow.ai_provider,
      googleSheetsId: dbRow.google_sheets_id,
      responseTemplate: dbRow.response_template,
      questionTemplate: dbRow.question_template ?? "",
      autoPublish: dbRow.auto_publish,
      syncInterval: dbRow.sync_interval,
    };
  }

  private _getEnvSettings(): any | null {
    // If all required keys are in ENV, use them (useful for Timeweb where secrets are ENV vars)
    const clientId = process.env.OZON_CLIENT_ID;
    const apiKey = process.env.OZON_API_KEY;
    if (!clientId || !apiKey) return null;
    return {
      id: 1,
      ozonClientId: clientId,
      ozonApiKey: apiKey,
      questionApiKey: process.env.QUESTION_API_KEY ?? "",
      productApiKey: process.env.PRODUCT_API_KEY ?? "",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
      perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "",
      aiProvider: process.env.AI_PROVIDER ?? "deepseek",
      googleSheetsId: "",
      responseTemplate: process.env.RESPONSE_TEMPLATE ?? "",
      questionTemplate: "",
      autoPublish: false,
      syncInterval: 30,
    };
  }

  async upsertSettings(data: any): Promise<any> {
    // Ensure columns exist (migration for older DBs)
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS question_template TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS question_api_key TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS product_api_key TEXT NOT NULL DEFAULT ''");
    } catch {}

    await pool.query(`
      INSERT INTO settings (id, ozon_client_id, ozon_api_key, question_api_key, product_api_key,
        openai_api_key, deepseek_api_key, perplexity_api_key, ai_provider, google_sheets_id,
        response_template, question_template, auto_publish, sync_interval)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        ozon_client_id = EXCLUDED.ozon_client_id,
        ozon_api_key = EXCLUDED.ozon_api_key,
        question_api_key = EXCLUDED.question_api_key,
        product_api_key = EXCLUDED.product_api_key,
        openai_api_key = EXCLUDED.openai_api_key,
        deepseek_api_key = EXCLUDED.deepseek_api_key,
        perplexity_api_key = EXCLUDED.perplexity_api_key,
        ai_provider = EXCLUDED.ai_provider,
        google_sheets_id = EXCLUDED.google_sheets_id,
        response_template = EXCLUDED.response_template,
        question_template = EXCLUDED.question_template,
        auto_publish = EXCLUDED.auto_publish,
        sync_interval = EXCLUDED.sync_interval
    `, [
      data.ozonClientId, data.ozonApiKey, data.questionApiKey ?? "", data.productApiKey ?? "",
      data.openaiApiKey ?? "", data.deepseekApiKey ?? "", data.perplexityApiKey ?? "",
      data.aiProvider ?? "deepseek", data.googleSheetsId ?? "",
      data.responseTemplate ?? "", data.questionTemplate ?? "",
      data.autoPublish ?? false, data.syncInterval ?? 30,
    ]);
    return { id: 1, ...data };
  }

  private _rowToReview(row: any): any {
    return {
      id: row.id,
      ozonReviewId: row.ozon_review_id,
      productId: row.product_id,
      productName: row.product_name,
      authorName: row.author_name,
      rating: row.rating,
      reviewText: row.review_text,
      reviewDate: row.review_date,
      hasPhotos: Boolean(row.has_photos),
      status: row.status,
      ozonSku: row.ozon_sku,
      ozonStatus: row.ozon_status,
      isAnswered: Boolean(row.is_answered),
      autoPublished: Boolean(row.auto_published),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private _rowToResponse(row: any): any {
    return {
      id: row.id,
      reviewId: row.review_id,
      responseText: row.response_text,
      aiGenerated: Boolean(row.ai_generated),
      sheetsRowId: row.sheets_row_id,
      originalAiText: row.original_ai_text,
      approvedAt: row.approved_at,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async _attachResponse(review: any): Promise<any> {
    const r = await pool.query(
      "SELECT * FROM responses WHERE review_id = $1 LIMIT 1",
      [review.id]
    );
    return r.rowCount! > 0
      ? { ...review, response: this._rowToResponse(r.rows[0]) }
      : review;
  }

  async getReviews(filters?: { status?: string; rating?: number }): Promise<any[]> {
    let q = "SELECT * FROM reviews";
    const conditions: string[] = [];
    const vals: any[] = [];
    if (filters?.status) { vals.push(filters.status); conditions.push(`status = $${vals.length}`); }
    if (filters?.rating) { vals.push(filters.rating); conditions.push(`rating = $${vals.length}`); }
    if (conditions.length) q += " WHERE " + conditions.join(" AND ");
    q += " ORDER BY created_at DESC";
    const r = await pool.query(q, vals);
    const reviews = r.rows.map(row => this._rowToReview(row));
    return Promise.all(reviews.map(rv => this._attachResponse(rv)));
  }

  async getReviewById(id: number): Promise<any> {
    const r = await pool.query("SELECT * FROM reviews WHERE id = $1", [id]);
    if (r.rowCount === 0) return null;
    return this._attachResponse(this._rowToReview(r.rows[0]));
  }

  async getReviewByOzonId(ozonReviewId: string): Promise<any> {
    const r = await pool.query("SELECT * FROM reviews WHERE ozon_review_id = $1", [ozonReviewId]);
    if (r.rowCount === 0) return null;
    return this._attachResponse(this._rowToReview(r.rows[0]));
  }

  async createReview(data: any): Promise<any> {
    const ts = nowStr();
    const r = await pool.query(`
      INSERT INTO reviews (ozon_review_id, product_id, product_name, author_name, rating, review_text,
        review_date, has_photos, status, ozon_sku, ozon_status, is_answered, auto_published, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      data.ozonReviewId, data.productId ?? "", data.productName ?? "",
      data.authorName ?? "", data.rating ?? 5, data.reviewText ?? "",
      data.reviewDate ?? ts, Boolean(data.hasPhotos), data.status ?? "new",
      data.ozonSku ?? "", data.ozonStatus ?? "", Boolean(data.isAnswered),
      Boolean(data.autoPublished), ts, ts,
    ]);
    return this._rowToReview(r.rows[0]);
  }

  async updateReviewStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<any> {
    const sets = ["status = $1", "updated_at = $2"];
    const vals: any[] = [status, nowStr()];
    let i = 3;
    for (const [k, v] of Object.entries(extra ?? {})) {
      const col = k.replace(/([A-Z])/g, "_$1").toLowerCase();
      sets.push(`${col} = $${i++}`);
      vals.push(v instanceof Date ? v.toISOString() : v);
    }
    vals.push(id);
    const r = await pool.query(
      `UPDATE reviews SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    return this._rowToReview(r.rows[0]);
  }

  async getResponseByReviewId(reviewId: number): Promise<any> {
    const r = await pool.query("SELECT * FROM responses WHERE review_id = $1 LIMIT 1", [reviewId]);
    return r.rowCount! > 0 ? this._rowToResponse(r.rows[0]) : null;
  }

  async createResponse(data: any): Promise<any> {
    const ts = nowStr();
    const r = await pool.query(`
      INSERT INTO responses (review_id, response_text, ai_generated, sheets_row_id, original_ai_text,
        approved_at, published_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      data.reviewId, data.responseText ?? "",
      Boolean(data.aiGenerated !== false),
      data.sheetsRowId ?? "",
      data.originalAiText ?? data.responseText ?? "",
      data.approvedAt instanceof Date ? data.approvedAt.toISOString() : (data.approvedAt ?? null),
      data.publishedAt instanceof Date ? data.publishedAt.toISOString() : (data.publishedAt ?? null),
      ts, ts,
    ]);
    return this._rowToResponse(r.rows[0]);
  }

  async updateResponse(id: number, data: any): Promise<any> {
    const sets: string[] = ["updated_at = $1"];
    const vals: any[] = [nowStr()];
    let i = 2;
    const colMap: Record<string, string> = {
      responseText: "response_text", aiGenerated: "ai_generated",
      sheetsRowId: "sheets_row_id", originalAiText: "original_ai_text",
      approvedAt: "approved_at", publishedAt: "published_at",
    };
    for (const [k, v] of Object.entries(data)) {
      const col = colMap[k] ?? k.replace(/([A-Z])/g, "_$1").toLowerCase();
      sets.push(`${col} = $${i++}`);
      vals.push(v instanceof Date ? v.toISOString() : v);
    }
    vals.push(id);
    const r = await pool.query(
      `UPDATE responses SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    return this._rowToResponse(r.rows[0]);
  }

  async getStats(): Promise<any> {
    const r = await pool.query("SELECT status, auto_published FROM reviews");
    const all = r.rows;
    return {
      total: all.length,
      new: all.filter((r: any) => r.status === "new").length,
      pendingApproval: all.filter((r: any) => r.status === "pending_approval").length,
      approved: all.filter((r: any) => r.status === "approved").length,
      published: all.filter((r: any) => r.status === "published").length,
      rejected: all.filter((r: any) => r.status === "rejected").length,
      autoPublished: all.filter((r: any) => Boolean(r.auto_published)).length,
    };
  }

  async recordPublishHistory(entry: any): Promise<void> {
    await pool.query(`
      INSERT INTO publish_history (ozon_review_id, ozon_sku, product_name, author_name, rating,
        review_text, response_text, original_ai_text, auto_published, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (ozon_review_id) DO NOTHING
    `, [
      entry.ozonReviewId, entry.ozonSku ?? "", entry.productName ?? "",
      entry.authorName ?? "", entry.rating ?? 5, entry.reviewText ?? "",
      entry.responseText ?? "", entry.originalAiText ?? "",
      Boolean(entry.autoPublished), entry.publishedAt,
    ]);
  }

  // Make sync method work too (called from routes without await in auto-publish)
  recordPublishHistorySync(entry: any): void {
    this.recordPublishHistory(entry).catch(e =>
      console.error("[pg] recordPublishHistory failed:", e)
    );
  }

  async getPublishHistory(from?: string, to?: string): Promise<any[]> {
    let q = "SELECT * FROM publish_history";
    const vals: any[] = [];
    if (from && to) {
      q += " WHERE published_at >= $1 AND published_at <= $2";
      vals.push(from, to);
    } else if (from) {
      q += " WHERE published_at >= $1"; vals.push(from);
    } else if (to) {
      q += " WHERE published_at <= $1"; vals.push(to);
    }
    q += " ORDER BY published_at DESC";
    const r = await pool.query(q, vals);
    return r.rows;
  }

  async clearAllData(): Promise<void> {
    await pool.query("DELETE FROM responses");
    await pool.query("DELETE FROM reviews");
    console.log("[clearAllData] PG: reviews and responses cleared. publish_history preserved.");
  }

  // ── Startup tasks ──────────────────────────────────────────────────────────
  async resetStuckGenerating(): Promise<void> {
    const r = await pool.query(
      "UPDATE reviews SET status='new', updated_at=$1 WHERE status='generating'",
      [nowStr()]
    );
    if (r.rowCount! > 0) {
      console.log(`[startup] Reset ${r.rowCount} stuck 'generating' review(s) to 'new'`);
    }
  }

  async backfillPublishedIds(): Promise<void> {
    await pool.query(`
      INSERT INTO published_ids (ozon_review_id)
      SELECT ozon_review_id FROM reviews WHERE status = 'published'
      ON CONFLICT DO NOTHING
    `);
  }

  // ── Questions ─────────────────────────────────────────────────────────

  private _rowToQuestion(row: any): any {
    return {
      id: row.id,
      ozonQuestionId: row.ozon_question_id,
      productId: row.product_id,
      productName: row.product_name,
      productUrl: row.product_url ?? "",
      ozonSku: row.ozon_sku,
      authorName: row.author_name,
      questionText: row.question_text,
      questionDate: row.question_date,
      status: row.status,
      isAnswered: Boolean(row.is_answered),
      autoPublished: Boolean(row.auto_published),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private _rowToQuestionResponse(row: any): any {
    return {
      id: row.id,
      questionId: row.question_id,
      responseText: row.response_text,
      originalAiText: row.original_ai_text,
      aiGenerated: Boolean(row.ai_generated),
      approvedAt: row.approved_at,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async _attachQuestionResponse(question: any): Promise<any> {
    const r = await pool.query(
      "SELECT * FROM question_responses WHERE question_id = $1 LIMIT 1",
      [question.id]
    );
    return r.rowCount! > 0
      ? { ...question, response: this._rowToQuestionResponse(r.rows[0]) }
      : question;
  }

  async getQuestions(filters?: { status?: string; productId?: string }): Promise<any[]> {
    let q = "SELECT * FROM questions";
    const conditions: string[] = [];
    const vals: any[] = [];
    if (filters?.status) { vals.push(filters.status); conditions.push(`status = $${vals.length}`); }
    if (filters?.productId) { vals.push(filters.productId); conditions.push(`product_id = $${vals.length}`); }
    if (conditions.length) q += " WHERE " + conditions.join(" AND ");
    q += " ORDER BY created_at DESC";
    const r = await pool.query(q, vals);
    const qs = r.rows.map(row => this._rowToQuestion(row));
    return Promise.all(qs.map(q => this._attachQuestionResponse(q)));
  }

  async getQuestionById(id: number): Promise<any> {
    const r = await pool.query("SELECT * FROM questions WHERE id = $1", [id]);
    if (r.rowCount === 0) return null;
    return this._attachQuestionResponse(this._rowToQuestion(r.rows[0]));
  }

  async getQuestionByOzonId(ozonQuestionId: string): Promise<any> {
    const r = await pool.query("SELECT * FROM questions WHERE ozon_question_id = $1", [ozonQuestionId]);
    if (r.rowCount === 0) return null;
    return this._attachQuestionResponse(this._rowToQuestion(r.rows[0]));
  }

  async createQuestion(data: any): Promise<any> {
    // Self-healing migration for older DBs
    try { await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS product_url TEXT NOT NULL DEFAULT ''"); } catch {}
    const ts = nowStr();
    const r = await pool.query(`
      INSERT INTO questions (ozon_question_id, product_id, product_name, product_url, ozon_sku,
        author_name, question_text, question_date, status, is_answered, auto_published, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      data.ozonQuestionId, data.productId ?? "", data.productName ?? "",
      data.productUrl ?? "", data.ozonSku ?? "", data.authorName ?? "",
      data.questionText ?? "", data.questionDate ?? ts, data.status ?? "new",
      Boolean(data.isAnswered), Boolean(data.autoPublished), ts, ts,
    ]);
    return this._rowToQuestion(r.rows[0]);
  }

  async updateQuestionStatus(id: number, status: string, extra?: Record<string, unknown>): Promise<any> {
    const sets = ["status = $1", "updated_at = $2"];
    const vals: any[] = [status, nowStr()];
    let i = 3;
    for (const [k, v] of Object.entries(extra ?? {})) {
      const col = k.replace(/([A-Z])/g, "_$1").toLowerCase();
      sets.push(`${col} = $${i++}`);
      vals.push(v instanceof Date ? v.toISOString() : v);
    }
    vals.push(id);
    const r = await pool.query(
      `UPDATE questions SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    return this._rowToQuestion(r.rows[0]);
  }

  async getQuestionResponseByQuestionId(questionId: number): Promise<any> {
    const r = await pool.query(
      "SELECT * FROM question_responses WHERE question_id = $1 LIMIT 1",
      [questionId]
    );
    return r.rowCount! > 0 ? this._rowToQuestionResponse(r.rows[0]) : null;
  }

  async createQuestionResponse(data: any): Promise<any> {
    const ts = nowStr();
    const r = await pool.query(`
      INSERT INTO question_responses (question_id, response_text, original_ai_text, ai_generated,
        approved_at, published_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      data.questionId, data.responseText ?? "",
      data.originalAiText ?? data.responseText ?? "",
      Boolean(data.aiGenerated !== false),
      data.approvedAt instanceof Date ? data.approvedAt.toISOString() : (data.approvedAt ?? null),
      data.publishedAt instanceof Date ? data.publishedAt.toISOString() : (data.publishedAt ?? null),
      ts, ts,
    ]);
    return this._rowToQuestionResponse(r.rows[0]);
  }

  async updateQuestionResponse(id: number, data: any): Promise<any> {
    const sets: string[] = ["updated_at = $1"];
    const vals: any[] = [nowStr()];
    let i = 2;
    const colMap: Record<string, string> = {
      responseText: "response_text", originalAiText: "original_ai_text",
      aiGenerated: "ai_generated", approvedAt: "approved_at", publishedAt: "published_at",
    };
    for (const [k, v] of Object.entries(data)) {
      const col = colMap[k] ?? k.replace(/([A-Z])/g, "_$1").toLowerCase();
      sets.push(`${col} = $${i++}`);
      vals.push(v instanceof Date ? v.toISOString() : v);
    }
    vals.push(id);
    const r = await pool.query(
      `UPDATE question_responses SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals
    );
    return this._rowToQuestionResponse(r.rows[0]);
  }

  async getQuestionStats(): Promise<any> {
    const r = await pool.query("SELECT status FROM questions");
    const all = r.rows;
    return {
      total: all.length,
      new: all.filter((r: any) => r.status === "new").length,
      pendingApproval: all.filter((r: any) => r.status === "pending_approval").length,
      approved: all.filter((r: any) => r.status === "approved").length,
      published: all.filter((r: any) => r.status === "published").length,
      rejected: all.filter((r: any) => r.status === "rejected").length,
    };
  }

  async resetStuckGeneratingQuestions(): Promise<void> {
    const r = await pool.query(
      "UPDATE questions SET status='new', updated_at=$1 WHERE status='generating'",
      [nowStr()]
    );
    if (r.rowCount! > 0) {
      console.log(`[startup] Reset ${r.rowCount} stuck 'generating' question(s) to 'new'`);
    }
  }

  // ── Product Cache ─────────────────────────────────────────────────────────

  async upsertProductCache(data: {
    ozonSku: string;
    productId: string;
    name: string;
    description: string;
    attributes: string;
  }): Promise<void> {
    await pool.query(`
      INSERT INTO product_cache (ozon_sku, product_id, name, description, attributes, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (ozon_sku) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        attributes = EXCLUDED.attributes,
        updated_at = EXCLUDED.updated_at
    `, [data.ozonSku, data.productId, data.name, data.description, data.attributes, nowStr()]);
  }

  async getProductCache(ozonSku: string): Promise<any | null> {
    const r = await pool.query("SELECT * FROM product_cache WHERE ozon_sku = $1", [ozonSku]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return { ozonSku: row.ozon_sku, productId: row.product_id, name: row.name, description: row.description, attributes: row.attributes, updatedAt: row.updated_at };
  }

  async getAllProductCacheSkus(): Promise<string[]> {
    const r = await pool.query("SELECT ozon_sku FROM product_cache");
    return r.rows.map((row: any) => row.ozon_sku);
  }

  /**
   * Get up to `limit` answered questions for a given SKU as knowledge base context.
   * Returns pairs of {question, answer} for AI prompt.
   */
  async getKnowledgeBySku(ozonSku: string, limit = 5): Promise<Array<{ question: string; answer: string }>> {
    const r = await pool.query(`
      SELECT q.question_text, qr.response_text
      FROM questions q
      JOIN question_responses qr ON qr.question_id = q.id
      WHERE q.ozon_sku = $1
        AND q.status = 'published'
        AND qr.response_text != ''
      ORDER BY q.created_at DESC
      LIMIT $2
    `, [ozonSku, limit]);
    return r.rows.map((row: any) => ({ question: row.question_text, answer: row.response_text }));
  }
}
