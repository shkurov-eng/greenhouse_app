"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Inbox, RefreshCw } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import { listTasks, updateTaskStatus, type Task } from "@/lib/api";

function resolveTelegramInitData() {
  if (typeof window === "undefined") {
    return null;
  }
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return telegram?.WebApp?.initData?.trim() || null;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const initData = useMemo(() => resolveTelegramInitData(), []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await listTasks(initData);
      setTasks(data);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load tasks";
      setMessage(text);
    } finally {
      setLoading(false);
    }
  }, [initData]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadTasks]);

  const toggleStatus = useCallback(
    async (task: Task) => {
      const nextStatus = task.status === "open" ? "done" : "open";
      setBusyTaskId(task.id);
      setMessage(null);
      try {
        await updateTaskStatus(initData, { taskId: task.id, status: nextStatus });
        setTasks((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  status: nextStatus,
                  updated_at: new Date().toISOString(),
                }
              : item,
          ),
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to update task";
        setMessage(text);
      } finally {
        setBusyTaskId(null);
      }
    },
    [initData],
  );

  return (
    <MobileShell>
      <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center gap-3">
            <Link href="/" className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm" aria-label="Back to rooms">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Inbox className="h-5 w-5 text-[#006c49]" />
              <h1 className="text-lg font-extrabold tracking-tight text-[#006c49]">Tasks</h1>
            </div>
          </header>
          <section className="rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm text-[#6c7a71]">Forward a message to bot to create a task.</p>
              <button
                type="button"
                onClick={() => void loadTasks()}
                className="inline-flex items-center gap-2 rounded-full bg-[#f1f6f3] px-3 py-1.5 text-xs font-semibold text-[#006c49]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
            {message ? (
              <p className="mb-3 rounded-xl bg-[#ffece6] px-3 py-2 text-sm text-[#8a3b1c]">{message}</p>
            ) : null}
            {loading ? (
              <p className="text-sm text-[#6c7a71]">Loading tasks...</p>
            ) : tasks.length === 0 ? (
              <p className="text-sm text-[#6c7a71]">No tasks yet.</p>
            ) : (
              <ul className="space-y-2">
                {tasks.map((task) => {
                  const isDone = task.status === "done";
                  const dueText = task.due_at ? new Date(task.due_at).toLocaleString() : null;
                  return (
                    <li
                      key={task.id}
                      className="flex items-start justify-between gap-3 rounded-2xl border border-[#ece6e1] px-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${isDone ? "text-[#8e8a86] line-through" : "text-[#1f1b17]"}`}>
                          {task.title}
                        </p>
                        {task.description ? (
                          <p className="mt-1 text-xs text-[#6c7a71]">{task.description}</p>
                        ) : null}
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-[#8e8a86]">
                          {task.priority}
                          {task.parse_source === "ai" ? " · AI parsed" : ""}
                          {task.needs_review ? " · needs review" : ""}
                          {dueText ? ` · due ${dueText}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busyTaskId === task.id}
                        onClick={() => void toggleStatus(task)}
                        className="rounded-full p-1 text-[#006c49] disabled:cursor-not-allowed disabled:opacity-60"
                        aria-label={isDone ? "Mark as open" : "Mark as done"}
                      >
                        {isDone ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>
    </MobileShell>
  );
}
