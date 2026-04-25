type ParsedTask = {
  normalizedTitle: string;
  taskType: string | null;
  priority: "low" | "normal" | "high";
  dueAt: string | null;
  assigneeHint: string | null;
  confidence: number;
  needsReview: boolean;
  rawJson: unknown;
  status: "ok" | "low_confidence" | "failed";
};

type ParseTaskResult = {
  parsed: ParsedTask | null;
  errorMessage: string | null;
};

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function normalizePriority(value: unknown): "low" | "normal" | "high" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "low" || raw === "high") {
    return raw;
  }
  return "normal";
}

function normalizeDueAt(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

export async function parseTaskTextWithAi(rawText: string): Promise<ParseTaskResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { parsed: null, errorMessage: "Missing GEMINI_API_KEY" };
  }
  const text = rawText.trim();
  if (!text) {
    return { parsed: null, errorMessage: "Empty source text" };
  }

  const prompt = [
    "You are a task parser for a Telegram greenhouse app inbox.",
    "Extract structured task fields from plain user text.",
    "Return ONLY JSON with keys:",
    "- normalized_title (string, short imperative title)",
    "- task_type (string or null)",
    '- priority (string: "low" | "normal" | "high")',
    "- due_at (ISO datetime string or null)",
    "- assignee_hint (string or null)",
    "- confidence (number 0..1)",
    "- notes (string, short explanation)",
    "Do not hallucinate deadlines. If unclear, due_at must be null.",
    "Input:",
    text,
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      const compact = body.replace(/\s+/g, " ").trim().slice(0, 220);
      return { parsed: null, errorMessage: compact || `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw =
      data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
    const jsonText = extractJsonObject(raw) ?? raw;
    const parsedRaw = JSON.parse(jsonText) as {
      normalized_title?: unknown;
      task_type?: unknown;
      priority?: unknown;
      due_at?: unknown;
      assignee_hint?: unknown;
      confidence?: unknown;
    };

    const normalizedTitle =
      typeof parsedRaw.normalized_title === "string" && parsedRaw.normalized_title.trim()
        ? parsedRaw.normalized_title.trim()
        : text.slice(0, 140);
    const confidenceRaw = Number(parsedRaw.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.min(Math.max(confidenceRaw, 0), 1) : 0.5;
    const needsReview = confidence < 0.6;

    return {
      parsed: {
        normalizedTitle,
        taskType:
          typeof parsedRaw.task_type === "string" && parsedRaw.task_type.trim()
            ? parsedRaw.task_type.trim()
            : null,
        priority: normalizePriority(parsedRaw.priority),
        dueAt: normalizeDueAt(parsedRaw.due_at),
        assigneeHint:
          typeof parsedRaw.assignee_hint === "string" && parsedRaw.assignee_hint.trim()
            ? parsedRaw.assignee_hint.trim()
            : null,
        confidence,
        needsReview,
        rawJson: parsedRaw,
        status: needsReview ? "low_confidence" : "ok",
      },
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task parsing failed";
    return { parsed: null, errorMessage: message };
  }
}
