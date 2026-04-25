"use client";

import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";

export default function SettingsPage() {
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
            <p className="text-sm text-[#6c7a71]">Settings will appear here in a later update.</p>
          </section>
        </div>
      </main>
    </MobileShell>
  );
}
