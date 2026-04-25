import { NextResponse, type NextRequest } from "next/server";

import { parseTaskTextWithAi } from "@/lib/server/taskAiParser";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;
type DbSingleResult = Promise<{ data: unknown; error: DbError }>;
type LooseSelectBuilder = {
  eq: (column: string, value: string | number) => LooseSelectBuilder;
  is: (column: string, value: null) => LooseSelectBuilder;
  maybeSingle: () => DbSingleResult;
};
type LooseTableApi = {
  from: (table: string) => {
    upsert: (
      values: Record<string, unknown>,
      options?: { onConflict?: string; ignoreDuplicates?: boolean },
    ) => DbWriteResult;
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string | number) => DbWriteResult;
    };
    select: (columns: string) => LooseSelectBuilder;
  };
};

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
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
  };
};

async function telegramApiCall(method: string, payload: Record<string, unknown>) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim().slice(0, 220);
    throw new Error(`Telegram API ${method} failed: ${compact || response.statusText}`);
  }
}

function parseScopeCallbackData(value: string) {
  const match = /^task_scope:(personal|household):([0-9a-f-]{36})$/i.exec(value);
  if (!match) {
    return null;
  }
  return {
    scope: match[1] as "personal" | "household",
    draftId: match[2],
  };
}

function parseHouseCallbackData(value: string) {
  const match = /^task_house:(\d+):([0-9a-f-]{36})$/i.exec(value);
  if (!match) {
    return null;
  }
  return {
    houseIndex: Number(match[1]),
    draftId: match[2],
  };
}

async function listHouseholdsByTelegramId(telegramId: number) {
  const supabaseAdmin = getSupabaseAdmin();
  type RpcResponse = { data: unknown; error: { message: string } | null };
  const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    rpcName: string,
    rpcParams?: Record<string, unknown>,
  ) => Promise<RpcResponse>;
  const { data, error } = await rpcAny("api_list_households", {
    p_telegram_id: String(telegramId),
  });
  if (error) {
    throw new Error(error.message);
  }
  const rows = (data as Array<Record<string, unknown>> | null) ?? [];
  return rows
    .map((row) => ({
      household_id: String(row.household_id ?? ""),
      household_name: String(row.household_name ?? ""),
    }))
    .filter((row) => row.household_id.length > 0);
}

export async function POST(request: NextRequest) {
  try {
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
    const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (configuredSecret && suppliedSecret !== configuredSecret) {
      return NextResponse.json({ error: "Unauthorized webhook request" }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const callbackQuery = update.callback_query;
    if (callbackQuery?.id && callbackQuery.data && callbackQuery.from?.id) {
      const parsedScope = parseScopeCallbackData(callbackQuery.data);
      const parsedHouse = parseHouseCallbackData(callbackQuery.data);
      if (!parsedScope && !parsedHouse) {
        await telegramApiCall("answerCallbackQuery", {
          callback_query_id: callbackQuery.id,
          text: "Неверное действие",
          show_alert: false,
        });
        return NextResponse.json({ data: { ok: true, skipped: "unsupported_callback_data" } });
      }

      const supabaseAdmin = getSupabaseAdmin();
      const db = supabaseAdmin as unknown as LooseTableApi;
      const draftId = parsedScope ? parsedScope.draftId : parsedHouse?.draftId ?? "";
      const { data: draft, error: draftError } = await db
        .from("bot_task_drafts")
        .select(
          "id,household_id,created_by_telegram_id,created_by_profile_id,source_platform,source_chat_id,source_message_id,raw_text,normalized_title,priority,due_at,task_type,assignee_hint,parse_source,ai_parse_status,ai_confidence,ai_parsed_at,ai_raw_json,needs_review,selected_scope",
        )
        .eq("id", draftId)
        .is("consumed_at", null)
        .maybeSingle();
      if (draftError) {
        throw new Error(draftError.message);
      }
      if (!draft) {
        await telegramApiCall("answerCallbackQuery", {
          callback_query_id: callbackQuery.id,
          text: "Эта задача уже обработана",
          show_alert: false,
        });
        return NextResponse.json({ data: { ok: true, skipped: "draft_not_found_or_consumed" } });
      }
      const draftRow = draft as Record<string, unknown>;
      const draftChatId = Number(draftRow.source_chat_id ?? 0);
      const draftTelegramId = Number(draftRow.created_by_telegram_id ?? 0);
      if (!Number.isFinite(draftChatId) || !Number.isFinite(draftTelegramId)) {
        throw new Error("Invalid draft payload");
      }

      let scope: "personal" | "household";
      let householdId: string;
      if (parsedScope) {
        scope = parsedScope.scope;
        const homes = await listHouseholdsByTelegramId(draftTelegramId);
        if (homes.length <= 1) {
          householdId = homes[0]?.household_id || String(draftRow.household_id ?? "");
        } else {
          const { error: rememberScopeError } = await db
            .from("bot_task_drafts")
            .update({ selected_scope: scope })
            .eq("id", draftId);
          if (rememberScopeError) {
            throw new Error(rememberScopeError.message);
          }
          await telegramApiCall("sendMessage", {
            chat_id: draftChatId,
            text: "Выбери дом для этой задачи:",
            reply_markup: {
              inline_keyboard: homes.map((home, index) => [
                {
                  text: home.household_name || `Дом ${index + 1}`,
                  callback_data: `task_house:${index}:${draftId}`,
                },
              ]),
            },
          });
          await telegramApiCall("answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: "Выбери дом",
            show_alert: false,
          });
          return NextResponse.json({ data: { ok: true, waiting_for_household_choice: true } });
        }
      } else {
        const selectedScope = String(draftRow.selected_scope ?? "");
        if (selectedScope !== "personal" && selectedScope !== "household") {
          await telegramApiCall("answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: "Сначала выбери тип задачи",
            show_alert: false,
          });
          return NextResponse.json({ data: { ok: true, skipped: "scope_not_selected" } });
        }
        scope = selectedScope;
        const homes = await listHouseholdsByTelegramId(draftTelegramId);
        const targetHome = homes[parsedHouse!.houseIndex];
        if (!targetHome) {
          await telegramApiCall("answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: "Дом не найден",
            show_alert: false,
          });
          return NextResponse.json({ data: { ok: true, skipped: "household_not_found" } });
        }
        householdId = targetHome.household_id;
      }

      const { error: insertError } = await db.from("tasks").upsert(
        {
          household_id: householdId,
          created_by_profile_id: draftRow.created_by_profile_id,
          assignee_profile_id: scope === "personal" ? draftRow.created_by_profile_id : null,
          task_scope: scope,
          title: draftRow.normalized_title,
          description: draftRow.raw_text,
          status: "open",
          priority: draftRow.priority,
          due_at: draftRow.due_at,
          source_platform: draftRow.source_platform,
          source_chat_id: draftRow.source_chat_id,
          source_message_id: draftRow.source_message_id,
          task_type: draftRow.task_type,
          assignee_hint: draftRow.assignee_hint,
          parse_source: draftRow.parse_source,
          ai_parse_status: draftRow.ai_parse_status,
          ai_confidence: draftRow.ai_confidence,
          ai_parsed_at: draftRow.ai_parsed_at,
          ai_raw_json: draftRow.ai_raw_json,
          needs_review: draftRow.needs_review,
        },
        {
          onConflict: "source_platform,source_chat_id,source_message_id",
          ignoreDuplicates: true,
        },
      );
      if (insertError) {
        throw new Error(insertError.message);
      }

      const draftRowId = String(draftRow.id ?? "");
      if (draftRowId) {
        const { error: consumeError } = await db
          .from("bot_task_drafts")
          .update({ consumed_at: new Date().toISOString() })
          .eq("id", draftRowId);
        if (consumeError) {
          throw new Error(consumeError.message);
        }
      }

      await telegramApiCall("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: scope === "household" ? "Создана общая задача для дома" : "Создана личная задача",
        show_alert: false,
      });
      return NextResponse.json({ data: { ok: true, created: true, task_scope: scope } });
    }

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

    const db = supabaseAdmin as unknown as LooseTableApi;
    const { error: draftUpsertError } = await db.from("bot_task_drafts").upsert(
      {
        source_platform: "telegram",
        source_chat_id: chatId,
        source_message_id: messageId,
        created_by_telegram_id: fromTelegramId,
        created_by_profile_id: profile.id,
        household_id: profile.active_household_id,
        raw_text: rawText,
        normalized_title: title,
        priority: aiParsed?.priority ?? "normal",
        due_at: aiParsed?.dueAt ?? null,
        task_type: aiParsed?.taskType ?? null,
        assignee_hint: aiParsed?.assigneeHint ?? null,
        parse_source: aiParsed ? "ai" : "manual",
        ai_parse_status: aiParsed?.status ?? "failed",
        ai_confidence: aiParsed?.confidence ?? null,
        ai_parsed_at: aiParsed ? new Date().toISOString() : null,
        ai_raw_json: aiParsed?.rawJson ?? null,
        needs_review: aiParsed?.needsReview ?? false,
        selected_scope: null,
        consumed_at: null,
      },
      {
        onConflict: "source_platform,source_chat_id,source_message_id",
      },
    );
    if (draftUpsertError) {
      throw new Error(draftUpsertError.message);
    }
    const { data: createdDraft, error: createdDraftError } = await supabaseAdmin
      .from("bot_task_drafts")
      .select("id")
      .eq("source_chat_id", chatId)
      .eq("source_message_id", messageId)
      .maybeSingle();
    if (createdDraftError) {
      throw new Error(createdDraftError.message);
    }
    const createdDraftId = String((createdDraft as { id?: string } | null)?.id ?? "");
    if (!createdDraftId) {
      throw new Error("Failed to resolve draft id");
    }
    await telegramApiCall("sendMessage", {
      chat_id: chatId,
      text: "Создать задачу как личную или общую для дома?",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Личная",
              callback_data: `task_scope:personal:${createdDraftId}`,
            },
            {
              text: "Общая на дом",
              callback_data: `task_scope:household:${createdDraftId}`,
            },
          ],
        ],
      },
    });

    return NextResponse.json({
      data: {
        ok: true,
        created: false,
        waiting_for_scope_choice: true,
        ai_status: aiParsed?.status ?? "failed",
        ai_error: ai.errorMessage,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
