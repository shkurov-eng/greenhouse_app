import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

const DEFAULT_THIRSTY_AFTER_HOURS = 6;
const DEFAULT_OVERDUE_AFTER_HOURS = 12;
const MIN_THIRSTY_AFTER_HOURS = 6;
const MIN_OVERDUE_AFTER_HOURS = 12;
const MIN_GAP_BETWEEN_THRESHOLDS_HOURS = 6;

type PlantAiProfile = {
  plantName: string;
  thirstyAfterHours: number;
  overdueAfterHours: number;
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

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;
type LooseTableApi = {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string | number) => DbWriteResult;
    };
  };
};

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function normalizeWateringThresholds(thirstyRaw: number, overdueRaw: number) {
  const fallbackThirsty = Math.max(DEFAULT_THIRSTY_AFTER_HOURS, MIN_THIRSTY_AFTER_HOURS);
  const fallbackOverdue = Math.max(DEFAULT_OVERDUE_AFTER_HOURS, MIN_OVERDUE_AFTER_HOURS);
  const parsedThirsty =
    Number.isFinite(thirstyRaw) && thirstyRaw > 0 ? Number(thirstyRaw.toFixed(2)) : fallbackThirsty;
  const normalizedThirsty = Math.max(parsedThirsty, MIN_THIRSTY_AFTER_HOURS);

  const parsedOverdue =
    Number.isFinite(overdueRaw) && overdueRaw > 0 ? Number(overdueRaw.toFixed(2)) : fallbackOverdue;
  const normalizedOverdue = Math.max(
    parsedOverdue,
    MIN_OVERDUE_AFTER_HOURS,
    normalizedThirsty + MIN_GAP_BETWEEN_THRESHOLDS_HOURS,
  );

  return {
    thirstyAfterHours: normalizedThirsty,
    overdueAfterHours: normalizedOverdue,
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
    "From the plant photo, identify the likely common plant name and suggest watering urgency thresholds in hours.",
    "Assume standard indoor baseline conditions for all recommendations: typical living room, average household humidity, and temperature around 20-22C.",
    "Do NOT estimate pot size, pot volume, or exact microclimate from the photo.",
    "Do NOT vary thresholds based on guessed room humidity, heating, draft, or sunlight intensity from this specific image.",
    "Prioritize species-level guidance under these standard conditions; use the photo mainly to identify the plant type and obvious health state.",
    "First decide whether the main subject is a real plant in a pot/garden.",
    "If the image is not a plant (person, pet, car, text document, landscape, random object), mark it as not plant.",
    "For typical indoor potted plants, use realistic ranges measured in many hours or days, not minutes.",
    `Never return thirsty_after_hours below ${MIN_THIRSTY_AFTER_HOURS}.`,
    `Never return overdue_after_hours below ${MIN_OVERDUE_AFTER_HOURS}.`,
    `Keep overdue_after_hours at least ${MIN_GAP_BETWEEN_THRESHOLDS_HOURS} hours later than thirsty_after_hours.`,
    "Return ONLY JSON with keys:",
    "- is_plant (boolean)",
    "- confidence (number 0..1)",
    "- plant_name (string)",
    "- thirsty_after_hours (number > 0, in hours)",
    "- overdue_after_hours (number >= thirsty_after_hours, in hours)",
    "- watering_amount_recommendation (string: \"light\", \"moderate\", or \"abundant\")",
    "- watering_summary (string, 2-3 concise sentences: include watering guidance + 1-2 practical care tips such as light, drainage, humidity, or temperature)",
    "Use realistic conservative defaults if uncertain.",
    `Default baseline: thirsty_after_hours=${DEFAULT_THIRSTY_AFTER_HOURS}, overdue_after_hours=${DEFAULT_OVERDUE_AFTER_HOURS}.`,
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    return { profile: null, status: "request_failed", errorMessage: `HTTP ${response.status}` };
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
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
    thirsty_after_hours?: unknown;
    overdue_after_hours?: unknown;
    watering_amount_recommendation?: unknown;
    watering_summary?: unknown;
  };
  const isPlant = typeof row.is_plant === "boolean" ? row.is_plant : true;
  if (!isPlant) {
    return { profile: null, status: "not_plant", errorMessage: "Photo does not appear to contain a plant" };
  }
  const confidenceRaw = Number(row.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0.8;
  if (confidence < 0.55) {
    return { profile: null, status: "low_confidence", errorMessage: `Low confidence (${confidence.toFixed(2)})` };
  }

  const plantName = typeof row.plant_name === "string" ? row.plant_name.trim() : "";
  if (!plantName) {
    return { profile: null, status: "invalid_response", errorMessage: "Missing plant_name in AI response" };
  }
  const thirstyRaw = Number(row.thirsty_after_hours);
  const overdueRaw = Number(row.overdue_after_hours);
  const { thirstyAfterHours, overdueAfterHours } = normalizeWateringThresholds(thirstyRaw, overdueRaw);
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
        : "abundant";
  const wateringSummaryRaw =
    typeof row.watering_summary === "string" ? row.watering_summary.trim() : "";

  return {
    profile: {
      plantName,
      thirstyAfterHours,
      overdueAfterHours,
      wateringAmountRecommendation,
      wateringSummary:
        wateringSummaryRaw ||
        `Water when topsoil feels dry. Prefer ${wateringAmountRecommendation} watering and avoid stagnant water.`,
    },
    status: "ok",
  };
}

export async function POST(request: NextRequest) {
  try {
    const telegramId = getRequestTelegramId(request);
    const supabaseAdmin = getSupabaseAdmin();
    const body = (await request.json()) as { plantId?: unknown };
    const plantId = typeof body.plantId === "string" ? body.plantId.trim() : "";
    if (!plantId) {
      return NextResponse.json({ error: "Missing plantId" }, { status: 400 });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("active_household_id")
      .eq("telegram_id", telegramId)
      .single();
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 400 });
    }
    const activeHouseholdId = (profile as { active_household_id?: string | null } | null)?.active_household_id;
    if (!activeHouseholdId) {
      return NextResponse.json({ error: "No active household" }, { status: 400 });
    }

    const { data: plantRow, error: plantError } = await supabaseAdmin
      .from("plants")
      .select("id,room_id,household_id,photo_path")
      .eq("id", plantId)
      .single();
    if (plantError) {
      return NextResponse.json({ error: plantError.message }, { status: 400 });
    }
    const plant = plantRow as {
      id: string;
      room_id: string;
      household_id: string;
      photo_path: string | null;
    };
    if (plant.household_id !== activeHouseholdId) {
      return NextResponse.json({ error: "Plant not found in active household" }, { status: 403 });
    }
    if (!plant.photo_path) {
      return NextResponse.json({ error: "Plant has no photo" }, { status: 400 });
    }

    const { data: imageBlob, error: downloadError } = await supabaseAdmin
      .storage
      .from("rooms")
      .download(plant.photo_path);
    if (downloadError || !imageBlob) {
      return NextResponse.json({ error: downloadError?.message ?? "Could not load plant photo" }, { status: 400 });
    }
    const bytes = await imageBlob.arrayBuffer();
    const mimeType = imageBlob.type || "image/jpeg";
    const { profile: aiProfile, status: aiStatus, errorMessage } = await detectPlantProfileWithAiStudio(
      bytes,
      mimeType,
    );

    if (aiStatus === "ok" && aiProfile) {
      const db = supabaseAdmin as unknown as LooseTableApi;
      const { error: updateError } = await db
        .from("plants")
        .update({
          name: aiProfile.plantName,
          thirsty_after_hours: aiProfile.thirstyAfterHours,
          overdue_after_hours: aiProfile.overdueAfterHours,
          watering_amount_recommendation: aiProfile.wateringAmountRecommendation,
          watering_summary: aiProfile.wateringSummary,
          ai_inferred_at: new Date().toISOString(),
        })
        .eq("id", plant.id);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 400 });
      }
    }

    return NextResponse.json({
      data: {
        id: plant.id,
        ai_status: aiStatus,
        ai_error: errorMessage ?? null,
        ai_profile: aiProfile
          ? {
              plant_name: aiProfile.plantName,
              thirsty_after_hours: aiProfile.thirstyAfterHours,
              overdue_after_hours: aiProfile.overdueAfterHours,
              watering_amount_recommendation: aiProfile.wateringAmountRecommendation,
              watering_summary: aiProfile.wateringSummary,
            }
          : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reanalysis failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
