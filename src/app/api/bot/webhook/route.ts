import { NextResponse, type NextRequest } from "next/server";

import { parseTaskTextWithAi } from "@/lib/server/taskAiParser";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;
type DbSingleResult = Promise<{ data: unknown; error: DbError }>;
type LooseSelectBuilder = {
  eq: (column: string, value: string | number) => LooseSelectBuilder;
  is: (column: string, value: null) => LooseSelectBuilder;
  order: (column: string, options: { ascending: boolean }) => LooseSelectBuilder;
  limit: (count: number) => LooseSelectBuilder;
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
  photo?: Array<unknown>;
  video?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
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

function hasUrl(text: string) {
  return /(https?:\/\/|www\.)\S+/i.test(text);
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
      await telegramApiCall("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: "Обрабатываю...",
        show_alert: false,
      });

      const parsedScope = parseScopeCallbackData(callbackQuery.data);
      const parsedHouse = parseHouseCallbackData(callbackQuery.data);
      if (!parsedScope && !parsedHouse) {
        await telegramApiCall("sendMessage", {
          chat_id: callbackQuery.from.id,
          text: "Неверное действие. Попробуй еще раз.",
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
        await telegramApiCall("sendMessage", {
          chat_id: callbackQuery.from.id,
          text: "Эта задача уже обработана.",
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
          return NextResponse.json({ data: { ok: true, waiting_for_household_choice: true } });
        }
      } else {
        const selectedScope = String(draftRow.selected_scope ?? "");
        if (selectedScope !== "personal" && selectedScope !== "household") {
          await telegramApiCall("sendMessage", {
            chat_id: draftChatId,
            text: "Сначала выбери тип задачи.",
          });
          return NextResponse.json({ data: { ok: true, skipped: "scope_not_selected" } });
        }
        scope = selectedScope;
        const homes = await listHouseholdsByTelegramId(draftTelegramId);
        const targetHome = homes[parsedHouse!.houseIndex];
        if (!targetHome) {
          await telegramApiCall("sendMessage", {
            chat_id: draftChatId,
            text: "Дом не найден. Выбери снова.",
          });
          return NextResponse.json({ data: { ok: true, skipped: "household_not_found" } });
        }
        householdId = targetHome.household_id;
      }

      const rawText = String(draftRow.raw_text ?? "").trim();
      let taskTitle = String(draftRow.normalized_title ?? rawText).slice(0, 140);
      let taskPriority = String(draftRow.priority ?? "normal");
      let taskDueAt = draftRow.due_at ?? null;
      let taskType = draftRow.task_type ?? null;
      let assigneeHint = draftRow.assignee_hint ?? null;
      let parseSource = String(draftRow.parse_source ?? "manual");
      let aiParseStatus = String(draftRow.ai_parse_status ?? "not_requested");
      let aiConfidence = draftRow.ai_confidence ?? null;
      let aiParsedAt = draftRow.ai_parsed_at ?? null;
      let aiRawJson: unknown = draftRow.ai_raw_json ?? null;
      let needsReview = Boolean(draftRow.needs_review);

      // Fast first response: scope choice appears immediately. AI parsing happens later here.
      if (aiParseStatus === "not_requested" && rawText) {
        const ai = await parseTaskTextWithAi(rawText);
        if (ai.parsed) {
          taskTitle = ai.parsed.normalizedTitle.slice(0, 140);
          taskPriority = ai.parsed.priority;
          taskDueAt = ai.parsed.dueAt;
          taskType = ai.parsed.taskType;
          assigneeHint = ai.parsed.assigneeHint;
          parseSource = "ai";
          aiParseStatus = ai.parsed.status;
          aiConfidence = ai.parsed.confidence;
          aiParsedAt = new Date().toISOString();
          aiRawJson = ai.parsed.rawJson;
          needsReview = ai.parsed.needsReview;
        } else {
          parseSource = "manual";
          aiParseStatus = "failed";
          aiConfidence = null;
          aiParsedAt = null;
          aiRawJson = null;
          needsReview = false;
        }
        const { error: refreshDraftError } = await db
          .from("bot_task_drafts")
          .update({
            normalized_title: taskTitle,
            priority: taskPriority,
            due_at: taskDueAt,
            task_type: taskType,
            assignee_hint: assigneeHint,
            parse_source: parseSource,
            ai_parse_status: aiParseStatus,
            ai_confidence: aiConfidence,
            ai_parsed_at: aiParsedAt,
            ai_raw_json: aiRawJson,
            needs_review: needsReview,
          })
          .eq("id", draftId);
        if (refreshDraftError) {
          throw new Error(refreshDraftError.message);
        }
      }

      const { error: insertError } = await db.from("tasks").upsert(
        {
          household_id: householdId,
          created_by_profile_id: draftRow.created_by_profile_id,
          assignee_profile_id: scope === "personal" ? draftRow.created_by_profile_id : null,
          task_scope: scope,
          title: taskTitle,
          description: rawText,
          status: "open",
          priority: taskPriority,
          due_at: taskDueAt,
          source_platform: draftRow.source_platform,
          source_chat_id: draftRow.source_chat_id,
          source_message_id: draftRow.source_message_id,
          task_type: taskType,
          assignee_hint: assigneeHint,
          parse_source: parseSource,
          ai_parse_status: aiParseStatus,
          ai_confidence: aiConfidence,
          ai_parsed_at: aiParsedAt,
          ai_raw_json: aiRawJson,
          needs_review: needsReview,
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

      await telegramApiCall("sendMessage", {
        chat_id: draftChatId,
        text: scope === "household" ? "Создана общая задача для дома." : "Создана личная задача.",
      });
      return NextResponse.json({ data: { ok: true, created: true, task_scope: scope } });
    }

    const message = update.message ?? update.edited_message;
    if (!message) {
      return NextResponse.json({ data: { ok: true, skipped: "unsupported_update_type" } });
    }

    const explicitText = (message.text ?? message.caption ?? "").trim();
    const mediaFallbackText =
      Array.isArray(message.photo) && message.photo.length > 0
        ? "Задача из фото"
        : message.video
          ? "Задача из видео"
          : message.document
            ? "Задача из файла"
            : message.audio
              ? "Задача из аудио"
              : message.voice
                ? "Задача из голосового сообщения"
                : message.sticker
                  ? "Задача из стикера"
                  : "Задача из сообщения";
    const rawText = explicitText || mediaFallbackText;
    const chatId = message.chat?.id ?? null;
    const messageId = message.message_id ?? null;
    const fromTelegramId = message.from?.id ?? null;
    if (chatId == null || messageId == null || fromTelegramId == null) {
      return NextResponse.json({ data: { ok: true, skipped: "missing_message_fields" } });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: profileRow, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id,active_household_id,task_message_mode")
      .eq("telegram_id", fromTelegramId)
      .single();
    if (profileError) {
      return NextResponse.json({
        data: { ok: true, skipped: "profile_not_found", detail: profileError.message },
      });
    }
    const profile = profileRow as {
      id?: string;
      active_household_id?: string | null;
      task_message_mode?: string | null;
    };
    if (!profile.id || !profile.active_household_id) {
      return NextResponse.json({ data: { ok: true, skipped: "missing_active_household" } });
    }
    const taskMessageMode = profile.task_message_mode === "combine" ? "combine" : "single";

    const title = hasUrl(rawText) ? "Задача из ссылки" : rawText.slice(0, 140);

    const db = supabaseAdmin as unknown as LooseTableApi;
    if (taskMessageMode === "combine") {
      const { data: existingDraft, error: existingDraftError } = await db
        .from("bot_task_drafts")
        .select("id,raw_text")
        .eq("created_by_profile_id", profile.id)
        .eq("source_chat_id", chatId)
        .is("selected_scope", null)
        .is("consumed_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingDraftError) {
        throw new Error(existingDraftError.message);
      }
      if (existingDraft) {
        const draft = existingDraft as { id?: string | null; raw_text?: string | null };
        const existingRaw = String(draft.raw_text ?? "").trim();
        const mergedRaw = existingRaw ? `${existingRaw}\n\n${rawText}` : rawText;
        const { error: mergeError } = await db
          .from("bot_task_drafts")
          .update({
            raw_text: mergedRaw,
            normalized_title: hasUrl(mergedRaw) ? "Задача из ссылки" : mergedRaw.slice(0, 140),
          })
          .eq("id", String(draft.id ?? ""));
        if (mergeError) {
          throw new Error(mergeError.message);
        }
        await telegramApiCall("sendMessage", {
          chat_id: chatId,
          text: "Добавил сообщение в текущий черновик задачи.",
        });
        return NextResponse.json({
          data: {
            ok: true,
            created: false,
            merged_into_existing_draft: true,
            task_message_mode: "combine",
          },
        });
      }
    }

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
        priority: "normal",
        due_at: null,
        task_type: null,
        assignee_hint: null,
        parse_source: "manual",
        ai_parse_status: "not_requested",
        ai_confidence: null,
        ai_parsed_at: null,
        ai_raw_json: null,
        needs_review: false,
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
        task_message_mode: taskMessageMode,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
