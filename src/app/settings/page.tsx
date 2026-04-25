"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import { getTaskSettings, setTaskSettings } from "@/lib/api";

function resolveTelegramInitData() {
  if (typeof window === "undefined") {
    return null;
  }
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return telegram?.WebApp?.initData?.trim() || null;
}

export default function SettingsPage() {
  const initData = useMemo(() => resolveTelegramInitData(), []);
  const [mode, setMode] = useState<"single" | "combine">("single");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        const data = await getTaskSettings(initData);
        setMode(data.taskMessageMode);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to load settings";
        setMessage(text);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [initData]);

  const onChangeMode = async (nextMode: "single" | "combine") => {
    setMode(nextMode);
    setSaving(true);
    setMessage(null);
    try {
      const saved = await setTaskSettings(initData, { taskMessageMode: nextMode });
      setMode(saved.taskMessageMode);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to save settings";
      setMessage(text);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MobileShell>
      <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center gap-3">
            <Link href="/" className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm" aria-label="Back to rooms">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-[#006c49]" />
              <h1 className="text-lg font-extrabold tracking-tight text-[#006c49]">Settings</h1>
            </div>
          </header>
          <section className="rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <h2 className="text-sm font-bold text-[#1f1b17]">Bot task mode</h2>
            <p className="mt-1 text-xs text-[#6c7a71]">
              Choose how forwarded bot messages are turned into tasks.
            </p>
            <div className="mt-4 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#e7ddd6] p-3">
                <input
                  type="radio"
                  name="task-mode"
                  checked={mode === "single"}
                  disabled={loading || saving}
                  onChange={() => void onChangeMode("single")}
                />
                <span>
                  <span className="block text-sm font-semibold text-[#1f1b17]">Single message = single task</span>
                  <span className="block text-xs text-[#6c7a71]">
                    Every forwarded message is processed as a separate task.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#e7ddd6] p-3">
                <input
                  type="radio"
                  name="task-mode"
                  checked={mode === "combine"}
                  disabled={loading || saving}
                  onChange={() => void onChangeMode("combine")}
                />
                <span>
                  <span className="block text-sm font-semibold text-[#1f1b17]">Combine messages into one task</span>
                  <span className="block text-xs text-[#6c7a71]">
                    New forwarded messages are appended to one draft until task type/home is selected.
                  </span>
                </span>
              </label>
            </div>
            {saving ? <p className="mt-3 text-xs text-[#6c7a71]">Saving...</p> : null}
            {message ? <p className="mt-3 text-xs text-[#8a3b1c]">{message}</p> : null}
          </section>
        </div>
      </main>
    </MobileShell>
  );
}
