import { NextResponse, type NextRequest } from "next/server";

import { getRequestTelegramId } from "@/lib/server/telegramAuth";

const DEFAULT_THIRSTY_AFTER_MINUTES = 5;
const DEFAULT_OVERDUE_AFTER_MINUTES = 60;

type PlantAiProfile = {
  plantName: string;
  thirstyAfterMinutes: number;
  overdueAfterMinutes: number;
  wateringAmountRecommendation: "light" | "moderate" | "abundant";
  wateringSummary: string;
};

type PlantAiStatus =
  | "ok"
  | "disabled_missing_api_key"
  | "request_failed"
  | "invalid_response";

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
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
    "Return ONLY JSON with keys:",
    "- plant_name (string)",
    "- thirsty_after_minutes (integer > 0)",
    "- overdue_after_minutes (integer >= thirsty_after_minutes)",
    "- watering_amount_recommendation (string: \"light\", \"moderate\", or \"abundant\")",
    "- watering_summary (string, 2-3 concise sentences with practical watering guidance)",
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
    plant_name?: unknown;
    thirsty_after_minutes?: unknown;
    overdue_after_minutes?: unknown;
    watering_amount_recommendation?: unknown;
    watering_summary?: unknown;
  };
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

  const thirsty = Number.isFinite(thirstyRaw) && thirstyRaw > 0
    ? Math.round(thirstyRaw)
    : DEFAULT_THIRSTY_AFTER_MINUTES;
  const overdueCandidate = Number.isFinite(overdueRaw) && overdueRaw > 0
    ? Math.round(overdueRaw)
    : DEFAULT_OVERDUE_AFTER_MINUTES;
  const overdue = Math.max(overdueCandidate, thirsty);
  const wateringAmount = wateringAmountRecommendation ?? "moderate";
  const wateringSummary =
    wateringSummaryRaw ||
    `Water when topsoil feels dry. Prefer ${wateringAmount} watering and avoid stagnant water. Recheck moisture before the next cycle.`;

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
    // Validates Telegram init data the same way as other secure routes.
    getRequestTelegramId(request);
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
