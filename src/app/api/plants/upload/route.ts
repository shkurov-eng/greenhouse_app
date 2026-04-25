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
  | "skipped_manual"
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
): Promise<{ profile: PlantAiProfile | null; status: PlantAiStatus }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { profile: null, status: "disabled_missing_api_key" };
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
    return { profile: null, status: "request_failed" };
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
    return { profile: null, status: "invalid_response" };
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
    return { profile: null, status: "not_plant" };
  }
  if (confidence < 0.55) {
    return { profile: null, status: "low_confidence" };
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
    return { profile: null, status: "invalid_response" };
  }
  const { thirstyAfterMinutes: thirsty, overdueAfterMinutes: overdue } = normalizeWateringThresholds(
    thirstyRaw,
    overdueRaw,
  );
  const wateringAmount = wateringAmountRecommendation ?? "moderate";
  const wateringSummary =
    wateringSummaryRaw ||
    `Water when topsoil feels dry. Prefer ${wateringAmount} watering and avoid stagnant water. Keep bright indirect light and ensure good drainage to reduce root stress.`;

  return {
    profile: {
      plantName,
      thirstyAfterMinutes: thirsty,
      overdueAfterMinutes: overdue,
      wateringAmountRecommendation: wateringAmount,
      wateringSummary,
    },
    status: "ok",
  };
}

export async function POST(request: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const telegramId = getRequestTelegramId(request);
    const formData = await request.formData();
    const plantIdValue = formData.get("plantId");
    const fileValue = formData.get("file");
    const aiModeValue = formData.get("aiMode");

    if (typeof plantIdValue !== "string" || !plantIdValue.trim()) {
      return NextResponse.json({ error: "Missing plantId" }, { status: 400 });
    }
    if (!(fileValue instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    const plantId = plantIdValue.trim();
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("active_household_id")
      .eq("telegram_id", telegramId)
      .single();
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 400 });
    }

    const activeHouseholdId = (profile as { active_household_id?: string | null } | null)
      ?.active_household_id;
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

    const fileName = fileValue.name || "plant-photo.jpg";
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${activeHouseholdId}/${plant.room_id}/${plant.id}/plant-${Date.now()}-${safeName}`;
    const arrayBuffer = await fileValue.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from("rooms")
      .upload(filePath, arrayBuffer, {
        upsert: true,
        contentType: fileValue.type || "application/octet-stream",
      });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const shouldRunAi = aiModeValue !== "manual";
    if (shouldRunAi) {
      type RpcResponse = { data: unknown; error: { message: string } | null };
      const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
        rpcName: string,
        rpcParams?: Record<string, unknown>,
      ) => Promise<RpcResponse>;
      const { error: aiRateError } = await rpcAny("api_register_ai_photo_request", {
        p_telegram_id: String(telegramId),
      });
      if (aiRateError) {
        return NextResponse.json({ error: aiRateError.message }, { status: 429 });
      }
    }
    const { profile: aiProfile, status: aiStatus } = shouldRunAi
      ? await detectPlantProfileWithAiStudio(arrayBuffer, fileValue.type || "image/jpeg")
      : { profile: null, status: "skipped_manual" as const };

    const updatePayload: {
      photo_path: string;
      name?: string;
      thirsty_after_minutes?: number;
      overdue_after_minutes?: number;
      watering_amount_recommendation?: "light" | "moderate" | "abundant";
      watering_summary?: string;
      ai_inferred_at?: string;
    } = {
      photo_path: filePath,
    };
    if (aiProfile) {
      updatePayload.name = aiProfile.plantName;
      updatePayload.thirsty_after_minutes = aiProfile.thirstyAfterMinutes;
      updatePayload.overdue_after_minutes = aiProfile.overdueAfterMinutes;
      updatePayload.watering_amount_recommendation = aiProfile.wateringAmountRecommendation;
      updatePayload.watering_summary = aiProfile.wateringSummary;
      updatePayload.ai_inferred_at = new Date().toISOString();
    }

    const db = supabaseAdmin as unknown as LooseTableApi;
    const { error: updateError } = await db.from("plants").update(updatePayload).eq("id", plant.id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    const { data: signedData, error: signError } = await supabaseAdmin.storage
      .from("rooms")
      .createSignedUrl(filePath, 60 * 15);
    if (signError) {
      return NextResponse.json({ error: signError.message }, { status: 400 });
    }

    if (plant.photo_path && plant.photo_path !== filePath) {
      const { error: removeOldError } = await supabaseAdmin
        .storage
        .from("rooms")
        .remove([plant.photo_path]);
      if (removeOldError) {
        console.warn("[plants-upload] failed to remove previous photo", {
          plantId: plant.id,
          message: removeOldError.message,
        });
      }
    }

    return NextResponse.json({
      data: {
        id: plant.id,
        photo_path: filePath,
        signed_photo_url: signedData?.signedUrl ?? null,
        ai_inferred: Boolean(aiProfile),
        ai_status: aiStatus,
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
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
