import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

const DEFAULT_THIRSTY_AFTER_MINUTES = 5;
const DEFAULT_OVERDUE_AFTER_MINUTES = 60;
const MIN_THIRSTY_AFTER_MINUTES = 6 * 60;
const MIN_OVERDUE_AFTER_MINUTES = 12 * 60;
const MIN_GAP_BETWEEN_THRESHOLDS_MINUTES = 6 * 60;

type PlantAiProfile = {
  plantName: string;
  thirstyAfterMinutes: number;
  overdueAfterMinutes: number;
  wateringAmountRecommendation: "light" | "moderate" | "abundant";
  wateringSummary: string;
};

type PlantAiStatus =
  | "ok"
  | "not_plant"
  | "low_confidence"
  | "disabled_missing_api_key"
  | "request_failed"
  | "invalid_response";

function isMissingAiRateLimitRpc(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("could not find the function public.api_register_ai_photo_request") ||
    normalized.includes("function public.api_register_ai_photo_request")
  );
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function normalizeWateringThresholds(thirstyRaw: number, overdueRaw: number) {
  const fallbackThirsty = Math.max(DEFAULT_THIRSTY_AFTER_MINUTES, MIN_THIRSTY_AFTER_MINUTES);
  const fallbackOverdue = Math.max(DEFAULT_OVERDUE_AFTER_MINUTES, MIN_OVERDUE_AFTER_MINUTES);
  const parsedThirsty =
    Number.isFinite(thirstyRaw) && thirstyRaw > 0 ? Math.round(thirstyRaw) : fallbackThirsty;
  const normalizedThirsty = Math.max(parsedThirsty, MIN_THIRSTY_AFTER_MINUTES);

  const parsedOverdue =
    Number.isFinite(overdueRaw) && overdueRaw > 0 ? Math.round(overdueRaw) : fallbackOverdue;
  const normalizedOverdue = Math.max(
    parsedOverdue,
    MIN_OVERDUE_AFTER_MINUTES,
    normalizedThirsty + MIN_GAP_BETWEEN_THRESHOLDS_MINUTES,
  );

  return {
    thirstyAfterMinutes: normalizedThirsty,
    overdueAfterMinutes: normalizedOverdue,
  };
}

async function detectPlantProfileWithAiStudio(
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<{ profile: PlantAiProfile | null; status: PlantAiStatus; errorMessage?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { profile: null, status: "disabled_missing_api_key", errorMessage: "Missing GEMINI_API_KEY" };
  }

  const base64Image = Buffer.from(imageBytes).toString("base64");
  const prompt = [
    "You are a houseplant assistant.",
    "From the plant photo, identify the likely common plant name and suggest watering urgency thresholds in minutes.",
    "Assume standard indoor baseline conditions for all recommendations: typical living room, average household humidity, and temperature around 20-22C.",
    "Do NOT estimate pot size, pot volume, or exact microclimate from the photo.",
    "Do NOT vary thresholds based on guessed room humidity, heating, draft, or sunlight intensity from this specific image.",
    "Prioritize species-level guidance under these standard conditions; use the photo mainly to identify the plant type and obvious health state.",
    "First decide whether the main subject is a real plant in a pot/garden.",
    "If the image is not a plant (person, pet, car, text document, landscape, random object), mark it as not plant.",
    "For typical indoor potted plants, use realistic ranges measured in many hours or days, not minutes.",
    `Never return thirsty_after_minutes below ${MIN_THIRSTY_AFTER_MINUTES}.`,
    `Never return overdue_after_minutes below ${MIN_OVERDUE_AFTER_MINUTES}.`,
    `Keep overdue_after_minutes at least ${MIN_GAP_BETWEEN_THRESHOLDS_MINUTES} minutes later than thirsty_after_minutes.`,
    "Return ONLY JSON with keys:",
    "- is_plant (boolean)",
    "- confidence (number 0..1)",
    "- plant_name (string)",
    "- thirsty_after_minutes (integer > 0)",
    "- overdue_after_minutes (integer >= thirsty_after_minutes)",
    "- watering_amount_recommendation (string: \"light\", \"moderate\", or \"abundant\")",
    "- watering_summary (string, 2-3 concise sentences: include watering guidance + 1-2 practical care tips such as light, drainage, humidity, or temperature)",
    "Use realistic conservative defaults if uncertain.",
    `Default baseline: thirsty_after_minutes=${DEFAULT_THIRSTY_AFTER_MINUTES}, overdue_after_minutes=${DEFAULT_OVERDUE_AFTER_MINUTES}.`,
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType || "image/jpeg",
                  data: base64Image,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    let errorMessage = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      const detail = parsed.error?.message?.trim();
      if (detail) {
        errorMessage = detail;
      }
    } catch {
      const compact = body.replace(/\s+/g, " ").trim().slice(0, 220);
      if (compact) {
        errorMessage = compact;
      }
    }
    return { profile: null, status: "request_failed", errorMessage };
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const rawText = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  const jsonText = extractJsonObject(rawText) ?? rawText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { profile: null, status: "invalid_response", errorMessage: "Model returned non-JSON payload" };
  }

  const row = parsed as {
    is_plant?: unknown;
    confidence?: unknown;
    plant_name?: unknown;
    thirsty_after_minutes?: unknown;
    overdue_after_minutes?: unknown;
    watering_amount_recommendation?: unknown;
    watering_summary?: unknown;
  };
  const isPlant = typeof row.is_plant === "boolean" ? row.is_plant : true;
  const confidenceRaw = Number(row.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0.8;
  if (!isPlant) {
    return { profile: null, status: "not_plant", errorMessage: "Photo does not appear to contain a plant" };
  }
  const plantName = typeof row.plant_name === "string" ? row.plant_name.trim() : "";
  const thirstyRaw = Number(row.thirsty_after_minutes);
  const overdueRaw = Number(row.overdue_after_minutes);
  const rawWateringAmount =
    typeof row.watering_amount_recommendation === "string"
      ? row.watering_amount_recommendation.trim().toLowerCase()
      : "";
  const wateringAmountRecommendation =
    rawWateringAmount === "light" ||
    rawWateringAmount === "little" ||
    rawWateringAmount === "small" ||
    rawWateringAmount === "a little"
      ? "light"
      : rawWateringAmount === "moderate" ||
          rawWateringAmount === "medium" ||
          rawWateringAmount === "normal"
        ? "moderate"
        : rawWateringAmount === "abundant" ||
            rawWateringAmount === "a_lot" ||
            rawWateringAmount === "a lot" ||
            rawWateringAmount === "lot" ||
            rawWateringAmount === "much" ||
            rawWateringAmount === "large"
          ? "abundant"
          : null;
  const wateringSummaryRaw =
    typeof row.watering_summary === "string" ? row.watering_summary.trim() : "";

  if (!plantName) {
    return { profile: null, status: "invalid_response", errorMessage: "Missing plant_name in AI response" };
  }

  const { thirstyAfterMinutes: thirsty, overdueAfterMinutes: overdue } = normalizeWateringThresholds(
    thirstyRaw,
    overdueRaw,
  );
  const wateringAmount = wateringAmountRecommendation ?? "moderate";
  const wateringSummary =
    wateringSummaryRaw ||
    `Water when topsoil feels dry. Prefer ${wateringAmount} watering and avoid stagnant water. Keep bright indirect light and ensure good drainage to reduce root stress.`;

  const profile: PlantAiProfile = {
    plantName,
    thirstyAfterMinutes: thirsty,
    overdueAfterMinutes: overdue,
    wateringAmountRecommendation: wateringAmount,
    wateringSummary,
  };

  if (confidence < 0.55) {
    return {
      profile,
      status: "low_confidence",
      errorMessage: `Low confidence (${confidence.toFixed(2)}).`,
    };
  }

  return {
    profile,
    status: "ok",
  };
}

export async function POST(request: NextRequest) {
  try {
    // Validates Telegram init data the same way as other secure routes.
    const telegramId = getRequestTelegramId(request);
    const supabaseAdmin = getSupabaseAdmin();
    type RpcResponse = { data: unknown; error: { message: string } | null };
    const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
      rpcName: string,
      rpcParams?: Record<string, unknown>,
    ) => Promise<RpcResponse>;
    const { error: aiRateError } = await rpcAny("api_register_ai_photo_request", {
      p_telegram_id: String(telegramId),
    });
    if (aiRateError) {
      if (isMissingAiRateLimitRpc(aiRateError.message)) {
        console.warn("[plants-analyze] missing ai rate limit RPC, continuing without limit", {
          message: aiRateError.message,
        });
      } else {
        return NextResponse.json({ error: aiRateError.message }, { status: 429 });
      }
    }
    const formData = await request.formData();
    const fileValue = formData.get("file");
    if (!(fileValue instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    const arrayBuffer = await fileValue.arrayBuffer();
    const { profile: aiProfile, status: aiStatus, errorMessage } = await detectPlantProfileWithAiStudio(
      arrayBuffer,
      fileValue.type || "image/jpeg",
    );

    return NextResponse.json({
      data: {
        ai_status: aiStatus,
        ai_error: errorMessage ?? null,
        ai_profile: aiProfile
          ? {
              plant_name: aiProfile.plantName,
              thirsty_after_minutes: aiProfile.thirstyAfterMinutes,
              overdue_after_minutes: aiProfile.overdueAfterMinutes,
              watering_amount_recommendation: aiProfile.wateringAmountRecommendation,
              watering_summary: aiProfile.wateringSummary,
            }
          : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analyze failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
