// Ozon Seller API integration

// Actual response shape from /v1/review/list (new format, no `result` wrapper)
interface OzonReviewRaw {
  id: string;           // review UUID
  sku: number;          // product SKU
  text: string;
  published_at: string;
  rating: number;
  status: string;       // "UNPROCESSED" | "PROCESSED"
  is_answered: boolean; // уже есть ответ продавца
  comments_amount: number;
  photos_amount: number;
  videos_amount: number;
  order_status: string;
  is_rating_participant: boolean;
  anonymous?: boolean;
  // Optional fields that may or may not be present
  product_name?: string;
  author_name?: string;
  // Legacy aliases (old API format)
  review_id?: string;
  product_id?: number;
  created_at?: string;
  media_files?: string[];
}

// Normalized shape used throughout the app
interface OzonReview {
  review_id: string;
  sku: number;
  product_id: number;
  product_name: string;
  author_name: string;
  created_at: string;
  rating: number;
  text: string;
  status: string;        // UNPROCESSED | PROCESSED
  is_answered: boolean;  // уже есть ответ на Ozon
  has_content: boolean;
  media_files?: string[];
  photos_amount: number;  // кол-во фото в отзыве
  order_status: string;   // статус заказа: DELIVERED и др.
}

// New API response format: { reviews: [...], last_id: "...", has_next: bool }
interface OzonReviewsResponseNew {
  reviews: OzonReviewRaw[];
  last_id: string;
  has_next: boolean;
}

// Legacy format (just in case): { result: { reviews: [...] } }
interface OzonReviewsResponseLegacy {
  result: {
    reviews: OzonReviewRaw[];
    total: number;
    has_next: boolean;
    last_review_id: string;
  };
}

interface OzonCountResponse {
  result?: {
    waiting?: number;
    declined?: number;
    all?: number;
  };
  code?: number;
  message?: string;
}

export class OzonPremiumPlusError extends Error {
  constructor() {
    super(
      "Метод /v1/review/list требует подписки Ozon Premium Plus.\n\n" +
      "ВСЕ методы API отзывов Ozon доступны только по подписке Premium Plus.\n\n" +
      "Решения:\n" +
      "1. Оформите Premium Plus в личном кабинете Ozon Seller (раздел «Подписки»)\n" +
      "2. Используйте ручной импорт: скачайте отзывы из кабинета Ozon и загрузите их в приложение (кнопка «Импорт CSV»)"
    );
    this.name = "OzonPremiumPlusError";
  }
}

/** Normalize raw API review to internal OzonReview shape */
function normalizeReview(raw: OzonReviewRaw): OzonReview {
  return {
    review_id: raw.id ?? raw.review_id ?? `unknown_${Date.now()}`,
    sku: raw.sku ?? 0,
    product_id: raw.product_id ?? raw.sku ?? 0,
    product_name: raw.product_name ?? "",
    author_name: raw.author_name ?? "",
    created_at: raw.published_at ?? raw.created_at ?? new Date().toISOString(),
    rating: raw.rating ?? 5,
    text: raw.text ?? "",
    status: raw.status ?? "UNPROCESSED",
    is_answered: raw.is_answered ?? false,
    has_content: (raw.text ?? "").length > 0 || (raw.photos_amount ?? 0) > 0,
    media_files: raw.media_files,
    photos_amount: raw.photos_amount ?? 0,
    order_status: raw.order_status ?? "",
  };
}

/**
 * Test whether the Ozon credentials are valid by calling /v1/review/count.
 * Returns { valid: true, requiresPremium: false } if it works,
 *         { valid: true, requiresPremium: true }  if we get a premium error,
 *         { valid: false } if credentials are wrong.
 */
export async function testOzonCredentials(
  clientId: string,
  apiKey: string
): Promise<{ valid: boolean; requiresPremium: boolean; message: string }> {
  try {
    const response = await fetch("https://api-seller.ozon.ru/v1/review/count", {
      method: "POST",
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const text = await response.text();
    let data: OzonCountResponse = {};
    try { data = JSON.parse(text); } catch {}

    if (response.status === 401 || (response.status === 403 && data.code !== -7)) {
      return { valid: false, requiresPremium: false, message: "Неверный Client-ID или API ключ Ozon" };
    }
    if (data.code === -7 || (response.status === 403 && text.includes("Premium"))) {
      return { valid: true, requiresPremium: true, message: "API ключи действительны, но требуется подписка Premium Plus" };
    }
    if (response.ok) {
      return { valid: true, requiresPremium: false, message: "API ключи действительны и подписка активна" };
    }
    return { valid: true, requiresPremium: true, message: "Требуется подписка Premium Plus для доступа к отзывам" };
  } catch (err) {
    return { valid: false, requiresPremium: false, message: `Ошибка подключения: ${String(err)}` };
  }
}

async function fetchOzonReviewsPage(
  clientId: string,
  apiKey: string,
  lastId?: string
): Promise<{ reviews: OzonReview[]; hasNext: boolean; lastId: string }> {
  const body: Record<string, unknown> = {
    sort_dir: "DESC",
    with_comments: false,
    limit: 100,
    status_filter: "UNPROCESSED", // только отзывы без ответа продавца
  };
  if (lastId) {
    body.last_id = lastId;
  }

  const response = await fetch("https://api-seller.ozon.ru/v1/review/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed: { code?: number; message?: string } = {};
    try { parsed = JSON.parse(text); } catch {}

    // Code -7 = ReviewList requires Premium Plus
    if (parsed.code === -7 || text.toLowerCase().includes("premium")) {
      throw new OzonPremiumPlusError();
    }
    throw new Error(`Ozon API error ${response.status}: ${text}`);
  }

  const data = await response.json() as (OzonReviewsResponseNew | OzonReviewsResponseLegacy);

  // Handle both response formats
  let rawReviews: OzonReviewRaw[];
  let hasNext = false;
  let nextLastId = "";

  if ("reviews" in data && Array.isArray(data.reviews)) {
    // New format: { reviews: [...], last_id: ..., has_next: ... }
    rawReviews = data.reviews;
    hasNext = (data as OzonReviewsResponseNew).has_next ?? false;
    nextLastId = (data as OzonReviewsResponseNew).last_id ?? "";
  } else if ("result" in data && data.result?.reviews) {
    // Legacy format: { result: { reviews: [...] } }
    rawReviews = data.result.reviews;
    hasNext = (data as OzonReviewsResponseLegacy).result.has_next ?? false;
    nextLastId = (data as OzonReviewsResponseLegacy).result.last_review_id ?? "";
  } else {
    rawReviews = [];
  }

  return {
    reviews: rawReviews.map(normalizeReview),
    hasNext,
    lastId: nextLastId,
  };
}

/**
 * Fetch reviews from Ozon page by page.
 * Calls onPage() for each batch — if it returns false, stops fetching (early exit).
 * This way the caller can stop as soon as it finds already-known reviews.
 */
export async function fetchOzonReviewsStreaming(
  clientId: string,
  apiKey: string,
  onPage: (reviews: OzonReview[]) => Promise<boolean> // return false to stop
): Promise<{ totalFetched: number; stopped: boolean }> {
  let lastId: string | undefined;
  let totalFetched = 0;
  let stopped = false;

  // Safety cap: 4000 pages × 100 = 400 000 отзывов максимум
  const MAX_PAGES = 4000;
  let page = 0;

  while (page < MAX_PAGES) {
    const result = await fetchOzonReviewsPage(clientId, apiKey, lastId);
    totalFetched += result.reviews.length;
    page++;

    const shouldContinue = await onPage(result.reviews);
    if (!shouldContinue) {
      stopped = true;
      break;
    }

    if (!result.hasNext || !result.lastId) break;
    lastId = result.lastId;
  }

  return { totalFetched, stopped };
}

export async function postOzonResponse(
  clientId: string,
  apiKey: string,
  reviewId: string,
  text: string
): Promise<boolean> {
  // Skip posting for demo/imported reviews (they don't have real Ozon review IDs)
  if (reviewId.startsWith("demo_") || reviewId.startsWith("import_") || reviewId.startsWith("csv_")) {
    console.log(`Skipping Ozon post for non-Ozon review ID: ${reviewId}`);
    return true;
  }

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

      let response: Response;
      try {
        response = await fetch("https://api-seller.ozon.ru/v1/review/comment/create", {
          method: "POST",
          headers: {
            "Client-Id": clientId,
            "Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ review_id: reviewId, text }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errText = await response.text();
        // Ozon returns 409 or specific error when comment already exists
        if (response.status === 409 || errText.toLowerCase().includes("already") || errText.includes("существует")) {
          console.log(`Review ${reviewId} already has a comment on Ozon — treating as success`);
          return true;
        }
        throw new Error(`Ozon API ${response.status}: ${errText}`);
      }

      return true;
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"));
      const isNetwork = err instanceof Error && (err.message.includes("fetch failed") || err.message.includes("ECONNRESET") || err.message.includes("ETIMEDOUT"));

      if ((isTimeout || isNetwork) && attempt < MAX_RETRIES) {
        console.warn(`Ozon publish attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}), retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      if (isTimeout) {
        throw new Error(`Ozon API не отвечает (таймаут ${attempt * 30}с). Проверьте соединение и попробуйте ещё раз.`);
      }
      if (isNetwork) {
        throw new Error(`Ошибка сети при публикации на Ozon. Попробуйте ещё раз.`);
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Не удалось опубликовать ответ на Ozon после нескольких попыток");
}

// ── CSV Import helpers ────────────────────────────────────────────────────────

/**
 * Parse a CSV/TSV string exported from Ozon Seller cabinet.
 * Ozon exports UTF-8 CSV with semicolons or commas as separators.
 */
export function parseOzonCsvReviews(csvText: string): OzonReview[] {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  // Detect separator
  const firstLine = lines[0];
  const sep = firstLine.includes(";") ? ";" : ",";

  // Parse header
  const headers = parseCsvLine(firstLine, sep).map((h) => h.trim().toLowerCase());

  // Column index helpers
  const findCol = (...candidates: string[]) => {
    for (const c of candidates) {
      const idx = headers.findIndex((h) => h.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const colId       = findCol("review_id", "id отзыва", "id");
  const colProduct  = findCol("product_id", "sku", "артикул", "product");
  const colName     = findCol("product_name", "название товара", "товар", "name");
  const colAuthor   = findCol("author", "автор", "покупатель", "buyer");
  const colRating   = findCol("rating", "оценка", "рейтинг", "stars");
  const colText     = findCol("text", "текст", "отзыв", "comment", "комментарий");
  const colDate     = findCol("date", "дата", "created", "время");

  const reviews: OzonReview[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = parseCsvLine(line, sep);

    const get = (idx: number) => (idx >= 0 ? (cells[idx] ?? "").trim() : "");

    const reviewId = get(colId) || `csv_${Date.now()}_${i}`;
    const rating = Math.min(5, Math.max(1, parseInt(get(colRating), 10) || 5));

    reviews.push({
      review_id: reviewId,
      sku: parseInt(get(colProduct), 10) || 0,
      product_id: parseInt(get(colProduct), 10) || 0,
      product_name: get(colName) || "Товар",
      author_name: get(colAuthor) || "Покупатель",
      created_at: parseDate(get(colDate)) || new Date().toISOString(),
      rating,
      text: get(colText) || "",
      status: "published",
      has_content: (get(colText) || "").length > 0,
    });
  }
  return reviews;
}

function parseCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseDate(s: string): string | null {
  if (!s) return null;
  // Try common Russian date formats: DD.MM.YYYY, YYYY-MM-DD
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m1) return new Date(`${m1[3]}-${m1[2].padStart(2,"0")}-${m1[1].padStart(2,"0")}`).toISOString();
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(s).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export type { OzonReview };

// ── Questions API ─────────────────────────────────────────────────────────────

export interface OzonQuestion {
  question_id: string;
  sku: number;
  product_id: string;
  product_name: string;
  product_url: string;
  author_name: string;
  created_at: string;
  question_text: string;
  is_answered: boolean;
}

interface OzonQuestionItem {
  // Ozon may use different field names across API versions
  question_id?: string;
  id?: string;
  uuid?: string;
  sku?: number;
  product_id?: number | string;
  product?: { id?: string | number; name?: string; sku?: number };
  author?: { name?: string };
  author_name?: string;
  created_at?: string;
  date?: string;
  text?: string;
  body?: string;
  content?: string;
  is_answered?: boolean;
  status?: string;
}

interface OzonQuestionsResponse {
  // POST /v1/question/list format — returns { questions, last_id }
  // Pagination: keep fetching while last_id changes and questions.length == limit
  questions?: OzonQuestionItem[];
  last_id?: string;
  has_next?: boolean; // may not be present
  total?: number;
  // Legacy/fallback formats
  result?: {
    questions?: OzonQuestionItem[];
    has_next?: boolean;
    last_id?: string;
    total?: number;
  };
  items?: OzonQuestionItem[];
}

/**
 * Fetch questions from Ozon: POST /v1/question/list
 * Returns up to `limit` questions (max 1000 per page).
 */
export async function fetchOzonQuestions(
  clientId: string,
  apiKey: string,
  lastId?: string
): Promise<{ questions: OzonQuestion[]; hasNext: boolean; lastId: string }> {
  const body: Record<string, unknown> = {
    limit: 100,
    sort_dir: "DESC",
  };
  // Ozon pagination: pass last_id from previous response to get next page
  if (lastId) body.last_id = lastId;

  const response = await fetch("https://api-seller.ozon.ru/v1/question/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let hint = "";
    if (response.status === 400 && text.includes("Invalid Api-Key")) {
      hint = " → Проверьте Question API Key в Настройках. Ключ должен иметь роль с доступом к /v1/question/list (не 'read only' для отзывов).";
    }
    throw new Error(`Ozon Questions API error ${response.status}: ${text}${hint}`);
  }

  const data = await response.json() as OzonQuestionsResponse;

  const rawItems = data.questions ?? data.result?.questions ?? data.items ?? [];
  const nextLastId = data.last_id ?? data.result?.last_id ?? "";
  // Ozon paginates via last_id — has_next may be absent, use last_id presence as signal
  const hasNext = rawItems.length > 0 && nextLastId !== "" && nextLastId !== lastId;
  console.log(`[ozon/questions] items=${rawItems.length} hasNext=${hasNext} last_id=${nextLastId}`);

  const normalized: OzonQuestion[] = rawItems.map((item) => {
    // Real Ozon API fields (confirmed from debug): id, text, author_name, sku, published_at, status
    const qId = item.id ?? item.question_id ?? item.uuid ?? "";
    const qText = item.text ?? item.body ?? item.content ?? "";
    const qDate = item.published_at ?? item.created_at ?? item.date ?? new Date().toISOString();
    const authorName = item.author_name ?? item.author?.name ?? "";
    const sku = item.sku ?? item.product?.sku ?? 0;
    const productId = String(item.product?.id ?? item.product_id ?? sku ?? "");
    // Extract readable name: prefer product.name, fallback to slug from URL
    let productName = item.product?.name ?? "";
    if (!productName && (item as any).product_url) {
      // Extract slug from URL: /product/SLUG-SKU/ -> "SLUG" humanized
      const match = String((item as any).product_url).match(/\/product\/([^/]+)/);
      if (match) {
        productName = match[1]
          .replace(/-\d+\/?$/, "")   // remove trailing SKU number
          .replace(/-/g, " ")          // dashes to spaces
          .replace(/\b\w/g, c => c.toUpperCase()); // capitalize
      }
    }
    const isAnswered = item.status === "ANSWERED" || item.is_answered === true
      || ((item as any).answers_count ?? 0) > 0;

    if (!qId) {
      console.warn("[ozon/questions] Item has no id, keys:", Object.keys(item));
    }

    const productUrl = (item as any).product_url ?? (item as any).question_link ?? "";

    return {
      question_id: qId,
      sku,
      product_id: productId,
      product_name: productName,
      product_url: productUrl,
      author_name: authorName,
      created_at: qDate,
      question_text: qText,
      is_answered: isAnswered,
    };
  }).filter(q => q.question_id); // skip items without ID

  return { questions: normalized, hasNext, lastId: nextLastId };
}

/**
 * Post an answer to a buyer question: POST /v1/question/answer/create
 */
export async function postOzonQuestionAnswer(
  clientId: string,
  apiKey: string,
  questionId: string,
  text: string
): Promise<boolean> {
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      let response: Response;
      try {
        response = await fetch("https://api-seller.ozon.ru/v1/question/answer/create", {
          method: "POST",
          headers: {
            "Client-Id": clientId,
            "Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ question_id: questionId, text }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 409 || errText.toLowerCase().includes("already") || errText.includes("существует")) {
          console.log(`Question ${questionId} already has an answer on Ozon — treating as success`);
          return true;
        }
        throw new Error(`Ozon Questions API ${response.status}: ${errText}`);
      }

      return true;
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"));
      const isNetwork = err instanceof Error && (err.message.includes("fetch failed") || err.message.includes("ECONNRESET") || err.message.includes("ETIMEDOUT"));

      if ((isTimeout || isNetwork) && attempt < MAX_RETRIES) {
        console.warn(`Question answer attempt ${attempt} failed, retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Не удалось опубликовать ответ на вопрос на Ozon");
}

// ── Product Info Cache ─────────────────────────────────────────────────────────

export interface OzonProductInfo {
  sku: string;
  productId: string;
  name: string;
  description: string;
  fullDescription: string; // rich description if available
  attributes: string; // JSON stringified key attributes
}

/**
 * Fetch product info from Ozon by SKU list: POST /v2/product/info/list
 * Returns name, description and key attributes for AI context.
 */
export async function fetchOzonProductInfo(
  clientId: string,
  apiKey: string,
  skus: number[]
): Promise<OzonProductInfo[]> {
  if (!skus.length) return [];

  // POST /v2/product/info/list accepts { sku: number[] }
  const response = await fetch("https://api-seller.ozon.ru/v2/product/info/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sku: skus }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[ozon/product-info] ${response.status}: ${text.slice(0, 200)}`);
    throw new Error(`Ozon Product Info API error ${response.status}: ${text}`);
  }

  const data = await response.json() as any;
  console.log(`[ozon/product-info] response keys:`, Object.keys(data));

  // v2 returns { result: { items: [...] } } or { items: [...] }
  const items = data.result?.items ?? data.items ?? [];
  console.log(`[ozon/product-info] items count:`, items.length);
  if (items.length > 0) {
    console.log(`[ozon/product-info] first item keys:`, Object.keys(items[0]).slice(0, 10));
  }

  return items.map((item: any) => {
    // Extract key attributes as readable text
    const attrs: string[] = [];
    for (const attr of item.attributes ?? []) {
      const val = attr.values?.[0]?.value ?? "";
      if (val) attrs.push(val);
    }

    return {
      sku: String(item.sku ?? ""),
      productId: String(item.id ?? item.product_id ?? ""),
      name: item.name ?? "",
      description: item.description ?? "",
      fullDescription: item.rich_content ?? item.description ?? "",
      attributes: attrs.slice(0, 20).join(", "),
    };
  });
}

// ── Question Answers ───────────────────────────────────────────────────────────

export interface OzonQuestionAnswer {
  questionId: string;
  answerText: string;
  createdAt: string;
}

/**
 * Fetch answers for a question: POST /v1/question/answer/list
 */
export async function fetchOzonQuestionAnswers(
  clientId: string,
  apiKey: string,
  questionId: string
): Promise<OzonQuestionAnswer[]> {
  const response = await fetch("https://api-seller.ozon.ru/v1/question/answer/list", {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question_id: questionId }),
  });

  if (!response.ok) {
    // Non-fatal — just return empty
    console.warn(`[ozon/question-answers] ${response.status} for ${questionId}`);
    return [];
  }

  const data = await response.json() as { answers?: any[]; result?: { answers?: any[] } };
  const answers = data.answers ?? data.result?.answers ?? [];

  return answers.map((a: any) => ({
    questionId,
    answerText: a.text ?? a.answer ?? "",
    createdAt: a.created_at ?? new Date().toISOString(),
  }));
}
