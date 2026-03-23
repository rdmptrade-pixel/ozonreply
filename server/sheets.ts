// Google Sheets integration via external-tool CLI
import { execSync } from "child_process";
import type { ReviewWithResponse } from "@shared/schema";

function callTool(sourceId: string, toolName: string, args: Record<string, unknown>) {
  const params = JSON.stringify({ source_id: sourceId, tool_name: toolName, arguments: args });
  try {
    const result = execSync(`external-tool call '${params}'`, {
      timeout: 30000,
      env: { ...process.env },
    });
    const text = result.toString().trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e: unknown) {
    const errObj = e as { stderr?: Buffer; stdout?: Buffer };
    const stderr = errObj?.stderr?.toString() ?? "";
    const stdout = errObj?.stdout?.toString() ?? "";
    throw new Error(`Tool call failed: ${stderr || stdout}`);
  }
}

// Get all worksheets: returns [{properties: {sheetId, title}}]
function listWorksheets(spreadsheetId: string): Array<{ properties?: { sheetId?: number; title?: string } }> {
  const result = callTool("google_sheets__pipedream", "google_sheets-list-worksheets", {
    sheetId: spreadsheetId,
  });
  if (Array.isArray(result)) return result;
  if (result?.sheets && Array.isArray(result.sheets)) return result.sheets;
  return [];
}

// Get worksheet ID by title, creating it if it doesn't exist.
function getOrCreateWorksheet(spreadsheetId: string, title: string): number {
  const sheets = listWorksheets(spreadsheetId);
  const found = sheets.find((s) => s.properties?.title === title);
  if (found) return found.properties?.sheetId ?? 0;

  // Create new worksheet
  const created = callTool("google_sheets__pipedream", "google_sheets-create-worksheet", {
    sheetId: spreadsheetId,
    title,
  });
  // Re-fetch to get the new sheetId
  const updated = listWorksheets(spreadsheetId);
  const newSheet = updated.find((s) => s.properties?.title === title);
  return newSheet?.properties?.sheetId ?? (created?.properties?.sheetId ?? 0);
}

// get-values-in-range returns array-of-arrays directly (not wrapped in {values: ...})
function getSheetValues(spreadsheetId: string, worksheetId: number, range: string): string[][] {
  const result = callTool("google_sheets__pipedream", "google_sheets-get-values-in-range", {
    sheetId: spreadsheetId,
    worksheetId,
    range,
  });
  if (Array.isArray(result)) return result as string[][];
  if (result?.values && Array.isArray(result.values)) return result.values as string[][];
  return [];
}

// ─────────────────────────────────────────────
// Tab IDs (fixed — tabs already created in sheet)
// ─────────────────────────────────────────────

/** "Авто-публикации" tab — auto-published reviews (4-5★, no text) */
const AUTO_SHEET_ID = 1017985570;

/** "Ручные публикации" tab — reviews requiring manual approval */
const MANUAL_SHEET_ID = 274854200;

const TRAINING_SHEET_TITLE = "Обучение ИИ";

// ─────────────────────────────────────────────
// Column definitions
// ─────────────────────────────────────────────

/**
 * "Авто-публикации" — 10 columns
 * A=ID, B=SKU, C=Статус, D=Товар, E=Оценка, F=Фото, G=Текст отзыва,
 * H=Дата отзыва, I=Ответ AI, J=Дата публикации
 */
const AUTO_HEADERS = [
  "ID отзыва Ozon",       // A
  "SKU",                  // B
  "Статус Ozon",          // C
  "Товар",                // D
  "Оценка",               // E
  "Фото",                 // F
  "Текст отзыва",         // G
  "Дата отзыва",          // H
  "Ответ AI",             // I
  "Дата публикации",      // J
];

/**
 * "Ручные публикации" — 12 columns
 * A=ID, B=SKU, C=Статус, D=Товар, E=Оценка, F=Фото, G=Текст отзыва,
 * H=Дата отзыва, I=Ответ AI, J=Утверждено✓ (checkbox), K=Отред ответ, L=Дата публикации
 */
const MANUAL_HEADERS = [
  "ID отзыва Ozon",          // A
  "SKU",                     // B
  "Статус Ozon",             // C
  "Товар",                   // D
  "Оценка",                  // E
  "Фото",                    // F
  "Текст отзыва",            // G
  "Дата отзыва",             // H
  "Ответ AI",                // I
  "Опубликовано ✓",          // J — always TRUE when written (published)
  "Отредактированный ответ", // K
  "Дата публикации",         // L
];

const TRAINING_HEADERS = [
  "SKU",                      // A
  "Текст отзыва",             // B
  "Сгенерированный ответ",   // C
  "Отредактированный ответ", // D
  "Дата",                     // E
];

// ─────────────────────────────────────────────
// Header helpers
// ─────────────────────────────────────────────

/**
 * Ensure "Авто-публикации" tab has headers in row 1.
 * Returns the AUTO_SHEET_ID constant.
 */
export async function ensureSheetHeaders(spreadsheetId: string): Promise<number> {
  const rows = getSheetValues(spreadsheetId, AUTO_SHEET_ID, "A1:J1");
  const hasHeaders =
    rows.length > 0 && rows[0] && rows[0][0] === AUTO_HEADERS[0] && rows[0].length >= AUTO_HEADERS.length;

  if (!hasHeaders) {
    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId: AUTO_SHEET_ID,
      rows: JSON.stringify([AUTO_HEADERS]),
    });
  }

  return AUTO_SHEET_ID;
}

/**
 * Ensure "Ручные публикации" tab has headers in row 1.
 * Returns MANUAL_SHEET_ID.
 */
export async function ensureManualSheetHeaders(spreadsheetId: string): Promise<number> {
  const rows = getSheetValues(spreadsheetId, MANUAL_SHEET_ID, "A1:L1");
  const hasHeaders =
    rows.length > 0 && rows[0] && rows[0][0] === MANUAL_HEADERS[0] && rows[0].length >= MANUAL_HEADERS.length;

  if (!hasHeaders) {
    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId: MANUAL_SHEET_ID,
      rows: JSON.stringify([MANUAL_HEADERS]),
    });
  }

  return MANUAL_SHEET_ID;
}

// ─────────────────────────────────────────────
// Auto-publish tab ("Авто-публикации")
// ─────────────────────────────────────────────

/**
 * Write an auto-published review to "Авто-публикации" tab.
 * Called ONLY for reviews that are auto-published (4-5★, no review text).
 * Deduplicates by ozonReviewId — skips if already present.
 *
 * The `worksheetId` parameter is accepted for backwards-compatibility with
 * existing routes.ts call sites, but is ignored — we always write to AUTO_SHEET_ID.
 */
export async function addReviewToSheet(
  spreadsheetId: string,
  review: ReviewWithResponse,
  _worksheetId?: number,       // kept for call-site compatibility, ignored
  _isAutoPublished?: boolean   // kept for call-site compatibility, ignored
): Promise<void> {
  try {
    await ensureSheetHeaders(spreadsheetId);

    const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
    const responseText = review.response?.responseText ?? "";
    const now = new Date().toLocaleString("ru-RU");

    // Deduplicate: skip if ozonReviewId already in column A
    const existingRows = getSheetValues(spreadsheetId, AUTO_SHEET_ID, "A2:A2000");
    for (const r of existingRows) {
      if (String(r[0] ?? "").trim() === review.ozonReviewId) {
        console.log(`[addReviewToSheet] Skipped duplicate: ${review.ozonReviewId}`);
        return;
      }
    }

    const row = [
      review.ozonReviewId,                    // A
      review.ozonSku ?? "",                   // B
      review.ozonStatus ?? "UNPROCESSED",     // C
      review.productName ?? "",               // D
      `${stars} (${review.rating}/5)`,        // E
      review.hasPhotos ? "есть" : "нет",      // F
      review.reviewText ?? "",                // G
      review.reviewDate ?? "",                // H
      responseText,                           // I
      now,                                    // J — Дата публикации
    ];

    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId: AUTO_SHEET_ID,
      rows: JSON.stringify([row]),
    });

    console.log(`[addReviewToSheet] Auto tab ← ${review.ozonReviewId}`);
  } catch (e) {
    console.error("[addReviewToSheet] FAILED for", review.ozonReviewId, ":", e);
  }
}

// ─────────────────────────────────────────────
// Manual tab ("Ручные публикации")
// ─────────────────────────────────────────────

/**
 * Write a review to the "Ручные публикации" tab.
 *
 * Called at AI-response generation time with J=FALSE (pending approval).
 * The user sets J=TRUE in the sheet to approve, then presses "Опубликовать (Таблица)".
 *
 * Deduplication: if ozonReviewId already in column A, skip (one row per review).
 * If allowUpdate=true, always appends (used to record a new AI response after re-generate).
 */
export async function addRowToManualSheet(
  spreadsheetId: string,
  review: ReviewWithResponse,
  _published = false, // kept for call-site compat — ignored, always writes J=FALSE
  allowUpdate = false,
): Promise<void> {
  try {
    await ensureManualSheetHeaders(spreadsheetId);

    if (!allowUpdate) {
      // Deduplicate: skip if ozonReviewId already has a row in this tab
      const existingRows = getSheetValues(spreadsheetId, MANUAL_SHEET_ID, "A2:A2000");
      for (const r of existingRows) {
        if (String(r[0] ?? "").trim() === review.ozonReviewId) {
          console.log(`[addRowToManualSheet] Skipped duplicate: ${review.ozonReviewId}`);
          return;
        }
      }
    }

    const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
    const responseText = review.response?.responseText ?? "";
    const editedResponse = (review.response as unknown as { editedResponse?: string })?.editedResponse ?? "";

    const row = [
      review.ozonReviewId,                 // A
      review.ozonSku ?? "",               // B
      review.ozonStatus ?? "UNPROCESSED", // C
      review.productName ?? "",           // D
      `${stars} (${review.rating}/5)`,    // E
      review.hasPhotos ? "есть" : "нет",  // F
      review.reviewText ?? "",            // G
      review.reviewDate ?? "",            // H
      responseText,                       // I — ответ AI
      "FALSE",                            // J — ожидает утверждения (пользователь меняет на TRUE)
      editedResponse || responseText,     // K — можно отредактировать прямо в таблице
      "",                                 // L — дата публикации (заполняется при публикации если возможно)
    ];

    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId: MANUAL_SHEET_ID,
      rows: JSON.stringify([row]),
    });

    console.log(`[addRowToManualSheet] Manual tab ← ${review.ozonReviewId} (pending)`);
  } catch (e) {
    console.error("[addRowToManualSheet] FAILED for", review.ozonReviewId, ":", e);
  }
}

/**
 * Record a published result to the "Ручные публикации" tab after publishing via the interface.
 * Appends a new row with J=TRUE and L=date.
 * Skips if a J=TRUE row already exists for this ozonReviewId (published via table).
 */
export async function recordPublishedToSheet(
  spreadsheetId: string,
  review: ReviewWithResponse,
): Promise<void> {
  try {
    await ensureManualSheetHeaders(spreadsheetId);

    // Check if J=TRUE row already exists (user approved via table and sync published it)
    const existingRows = getSheetValues(spreadsheetId, MANUAL_SHEET_ID, "A2:J2000");
    for (const r of existingRows) {
      if (String(r[0] ?? "").trim() !== review.ozonReviewId) continue;
      const jVal = String(r[9] ?? "").toUpperCase().trim();
      if (jVal === "TRUE") {
        console.log(`[recordPublishedToSheet] J=TRUE already exists for ${review.ozonReviewId}, skipping`);
        return;
      }
    }

    const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
    const responseText = review.response?.responseText ?? "";
    const editedResponse = (review.response as unknown as { editedResponse?: string })?.editedResponse ?? "";
    const now = new Date().toLocaleString("ru-RU");

    const row = [
      review.ozonReviewId,                 // A
      review.ozonSku ?? "",               // B
      review.ozonStatus ?? "UNPROCESSED", // C
      review.productName ?? "",           // D
      `${stars} (${review.rating}/5)`,    // E
      review.hasPhotos ? "есть" : "нет",  // F
      review.reviewText ?? "",            // G
      review.reviewDate ?? "",            // H
      responseText,                       // I
      "TRUE",                             // J — опубликовано ✓
      editedResponse || responseText,     // K
      now,                                // L — дата публикации
    ];

    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId: MANUAL_SHEET_ID,
      rows: JSON.stringify([row]),
    });

    console.log(`[recordPublishedToSheet] Manual tab ← ${review.ozonReviewId} (published)`);
  } catch (e) {
    console.error("[recordPublishedToSheet] FAILED for", review.ozonReviewId, ":", e);
  }
}

// ─────────────────────────────────────────────
// Sync approvals from "Ручные публикации" tab
// ─────────────────────────────────────────────

/**
 * Read "Ручные публикации" and return reviews where J=TRUE but NOT yet published
 * in the database (determined by the caller — here we return all J=TRUE rows).
 *
 * Column mapping:
 *   A = ozonReviewId
 *   I = AI response
 *   J = Утверждено ✓ (TRUE/FALSE checkbox)
 *   K = Отредактированный ответ (if user filled it in, use this; otherwise use I)
 */
export async function syncApprovalsFromSheet(
  spreadsheetId: string
): Promise<Array<{ ozonReviewId: string; approvedText: string; status: string }>> {
  const rows = getSheetValues(spreadsheetId, MANUAL_SHEET_ID, "A2:L2000");
  const approvals: Array<{ ozonReviewId: string; approvedText: string; status: string }> = [];

  for (const row of rows) {
    if (!row[0]) continue;
    const ozonReviewId = String(row[0]).trim();
    const aiResponse = String(row[8] ?? "").trim();          // I
    const approvalStatus = String(row[9] ?? "").toLowerCase().trim();  // J — Утверждено
    const editedResponse = String(row[10] ?? "").trim();     // K — Отредактированный ответ

    // Accept checkbox TRUE or explicit approval strings
    if (
      approvalStatus === "true" ||
      approvalStatus === "утверждено" ||
      approvalStatus === "approved" ||
      approvalStatus === "✅" ||
      approvalStatus === "да" ||
      approvalStatus === "+"
    ) {
      approvals.push({
        ozonReviewId,
        approvedText: editedResponse || aiResponse,
        status: "approved",
      });
    } else if (
      approvalStatus === "отклонено" ||
      approvalStatus === "rejected" ||
      approvalStatus === "❌" ||
      approvalStatus === "нет" ||
      approvalStatus === "-"
    ) {
      approvals.push({
        ozonReviewId,
        approvedText: "",
        status: "rejected",
      });
    }
    // "false" = pending, skip
  }

  return approvals;
}

// ─────────────────────────────────────────────
// Export (bulk write from DB → manual tab)
// ─────────────────────────────────────────────

/**
 * Export all reviews with responses to the "Ручные публикации" tab.
 * Used by the "Export" button in the UI.
 * Skips auto-published reviews (they go to Авто-публикации via addReviewToSheet).
 * Skips already-present rows (deduplication by ozonReviewId).
 */
export async function exportAllToSheet(
  spreadsheetId: string,
  reviews: ReviewWithResponse[]
): Promise<number> {
  await ensureManualSheetHeaders(spreadsheetId);

  // Get existing IDs in the manual tab
  const existingRows = getSheetValues(spreadsheetId, MANUAL_SHEET_ID, "A2:A2000");
  const existingIds = new Set(existingRows.map((r) => String(r[0] ?? "").trim()).filter(Boolean));

  // Export reviews that have responses and aren't already in the sheet
  const toExport = reviews.filter(
    (r) =>
      r.response?.responseText &&
      (r.status === "pending_approval" || r.status === "approved" || r.status === "published") &&
      !existingIds.has(r.ozonReviewId)
  );

  if (toExport.length === 0) return 0;

  for (const review of toExport) {
    const published = review.status === "published";
    await addRowToManualSheet(spreadsheetId, review, published);
  }

  return toExport.length;
}

// ─────────────────────────────────────────────
// Stubs kept for call-site compatibility
// (routes.ts imports these — remove gradually)
// ─────────────────────────────────────────────

/** @deprecated No longer needed — addReviewToSheet is self-contained */
export async function updateSheetHeaders(_spreadsheetId: string): Promise<void> {
  // no-op — headers are managed by ensureSheetHeaders / ensureManualSheetHeaders
}

/** @deprecated update-cell connector is broken — this is a no-op */
export async function updateReviewInSheet(
  _spreadsheetId: string,
  _ozonReviewId: string,
  _approved: boolean,
  _responseText?: string
): Promise<void> {
  // update-cell does not actually update cells — confirmed connector bug.
  // Manual approvals flow through syncApprovalsFromSheet instead.
}

/** @deprecated Use addRowToManualSheet directly */
export async function upsertReviewInSheet(
  spreadsheetId: string,
  review: ReviewWithResponse,
): Promise<void> {
  return addRowToManualSheet(spreadsheetId, review, true);
}

// ─────────────────────────────────────────────
// Training sheet ("Обучение ИИ")
// ─────────────────────────────────────────────

export async function addToTrainingSheet(
  spreadsheetId: string,
  data: {
    sku: string;
    reviewText: string;
    aiResponse: string;
    editedResponse: string;
  }
): Promise<void> {
  try {
    // Skip if the response wasn't actually edited
    const aiNorm = data.aiResponse.trim();
    const editNorm = data.editedResponse.trim();
    if (!editNorm || aiNorm === editNorm) return;

    const worksheetId = getOrCreateWorksheet(spreadsheetId, TRAINING_SHEET_TITLE);

    // Ensure headers exist in row 1
    const existing = getSheetValues(spreadsheetId, worksheetId, "A1:E1");
    const hasHeaders =
      existing.length > 0 &&
      existing[0]?.[0] === TRAINING_HEADERS[0] &&
      existing[0]?.length >= TRAINING_HEADERS.length;

    if (!hasHeaders) {
      callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
        sheetId: spreadsheetId,
        worksheetId,
        rows: JSON.stringify([TRAINING_HEADERS]),
      });
    }

    const row = [
      data.sku,
      data.reviewText,
      data.aiResponse,
      data.editedResponse,
      new Date().toLocaleString("ru-RU"),
    ];

    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId,
      rows: JSON.stringify([row]),
    });
  } catch {
    // Non-critical — don't fail the main action
  }
}

export async function ensureTrainingSheet(spreadsheetId: string): Promise<number> {
  const worksheetId = getOrCreateWorksheet(spreadsheetId, TRAINING_SHEET_TITLE);
  const existing = getSheetValues(spreadsheetId, worksheetId, "A1:E1");
  const hasHeaders =
    existing.length > 0 &&
    existing[0]?.[0] === TRAINING_HEADERS[0] &&
    existing[0]?.length >= TRAINING_HEADERS.length;
  if (!hasHeaders) {
    callTool("google_sheets__pipedream", "google_sheets-add-multiple-rows", {
      sheetId: spreadsheetId,
      worksheetId,
      rows: JSON.stringify([TRAINING_HEADERS]),
    });
  }
  return worksheetId;
}

export async function createReviewsSpreadsheet(title: string): Promise<string> {
  const result = callTool("google_sheets__pipedream", "google_sheets-create-spreadsheet", {
    title,
  });
  return result?.spreadsheetId ?? result?.id ?? "";
}
