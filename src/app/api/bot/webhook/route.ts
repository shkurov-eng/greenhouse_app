import { NextResponse, type NextRequest } from "next/server";

import { parseTaskTextWithAi } from "@/lib/server/taskAiParser";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type TelegramMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number };
  from?: { id?: number };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export async function POST(request: NextRequest) {
  try {
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
    const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (configuredSecret && suppliedSecret !== configuredSecret) {
      return NextResponse.json({ error: "Unauthorized webhook request" }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message ?? update.edited_message;
    if (!message) {
      return NextResponse.json({ data: { ok: true, skipped: "unsupported_update_type" } });
    }

    const rawText = (message.text ?? message.caption ?? "").trim();
    const chatId = message.chat?.id ?? null;
    const messageId = message.message_id ?? null;
    const fromTelegramId = message.from?.id ?? null;
    if (!rawText || chatId == null || messageId == null || fromTelegramId == null) {
      return NextResponse.json({ data: { ok: true, skipped: "missing_message_fields" } });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: profileRow, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id,active_household_id")
      .eq("telegram_id", fromTelegramId)
      .single();
    if (profileError) {
      return NextResponse.json({
        data: { ok: true, skipped: "profile_not_found", detail: profileError.message },
      });
    }
    const profile = profileRow as { id?: string; active_household_id?: string | null };
    if (!profile.id || !profile.active_household_id) {
      return NextResponse.json({ data: { ok: true, skipped: "missing_active_household" } });
    }

    const ai = await parseTaskTextWithAi(rawText);
    const aiParsed = ai.parsed;
    const title = (aiParsed?.normalizedTitle || rawText).slice(0, 140);

    const { error: insertError } = await supabaseAdmin.from("tasks").upsert(
      {
        household_id: profile.active_household_id,
        created_by_profile_id: profile.id,
        title,
        description: rawText,
        status: "open",
        priority: aiParsed?.priority ?? "normal",
        due_at: aiParsed?.dueAt ?? null,
        source_platform: "telegram",
        source_chat_id: chatId,
        source_message_id: messageId,
        task_type: aiParsed?.taskType ?? null,
        assignee_hint: aiParsed?.assigneeHint ?? null,
        parse_source: aiParsed ? "ai" : "manual",
        ai_parse_status: aiParsed?.status ?? "failed",
        ai_confidence: aiParsed?.confidence ?? null,
        ai_parsed_at: aiParsed ? new Date().toISOString() : null,
        ai_raw_json: aiParsed?.rawJson ?? null,
        needs_review: aiParsed?.needsReview ?? false,
      },
      {
        onConflict: "source_platform,source_chat_id,source_message_id",
        ignoreDuplicates: true,
      },
    );
    if (insertError) {
      throw new Error(insertError.message);
    }

    return NextResponse.json({
      data: {
        ok: true,
        created: true,
        ai_status: aiParsed?.status ?? "failed",
        ai_error: ai.errorMessage,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
