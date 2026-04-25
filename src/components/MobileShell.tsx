"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, LayoutGrid, Settings } from "lucide-react";

type TabId = "rooms" | "tasks" | "settings";

function tabFromPath(pathname: string | null): TabId {
  if (pathname === "/settings") {
    return "settings";
  }
  if (pathname === "/tasks") {
    return "tasks";
  }
  return "rooms";
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = tabFromPath(pathname);

  const tabClass = (id: TabId) => {
    const isOn = active === id;
    return `flex min-w-20 flex-col items-center rounded-2xl px-4 py-2 transition ${
      isOn
        ? "bg-[#e6f5ef] text-[#006c49] shadow-sm"
        : "text-[#6c7a71] hover:bg-[#f4f7f4] hover:text-[#31433a]"
    }`;
  };

  return (
    <>
      {children}
      <nav
        className="fixed bottom-0 left-0 z-40 flex w-full items-center justify-around rounded-t-[28px] border-t border-white/80 bg-white/88 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_36px_rgba(27,67,50,0.10)] backdrop-blur-xl"
        aria-label="Primary navigation"
      >
        <Link href="/" className={tabClass("rooms")} aria-current={active === "rooms" ? "page" : undefined}>
          <LayoutGrid className="h-6 w-6" strokeWidth={active === "rooms" ? 2.4 : 2} />
          <span className="mt-1 text-[11px] font-bold uppercase tracking-wider">Rooms</span>
        </Link>
        <Link href="/tasks" className={tabClass("tasks")} aria-current={active === "tasks" ? "page" : undefined}>
          <Inbox className="h-6 w-6" strokeWidth={active === "tasks" ? 2.4 : 2} />
          <span className="mt-1 text-[11px] font-bold uppercase tracking-wider">Inbox</span>
        </Link>
        <Link
          href="/settings"
          className={tabClass("settings")}
          aria-current={active === "settings" ? "page" : undefined}
        >
          <Settings className="h-6 w-6" strokeWidth={active === "settings" ? 2.4 : 2} />
          <span className="mt-1 text-[11px] font-bold uppercase tracking-wider">Settings</span>
        </Link>
      </nav>
    </>
  );
}
