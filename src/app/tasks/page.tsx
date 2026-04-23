"use client";

import Link from "next/link";

import { MobileShell } from "@/components/MobileShell";

export default function TasksPage() {
  return (
    <MobileShell>
      <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center gap-3">
            <Link href="/" className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm" aria-label="Back to rooms">
              <span className="material-symbols-outlined">arrow_back</span>
            </Link>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#006c49]">all_inbox</span>
              <h1 className="text-lg font-extrabold tracking-tight text-[#006c49]">Tasks</h1>
            </div>
          </header>
          <section className="rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <p className="text-sm text-[#6c7a71]">Task inbox will appear here in a later update.</p>
          </section>
        </div>
      </main>
    </MobileShell>
  );
}
