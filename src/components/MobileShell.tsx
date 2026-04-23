"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
    return `flex flex-col items-center rounded-xl px-4 py-1 ${
      isOn ? "bg-[#e6f5ef] text-[#006c49]" : "text-[#6c7a71]"
    }`;
  };

  return (
    <>
      {children}
      <nav className="fixed bottom-0 left-0 z-40 flex w-full items-center justify-around rounded-t-2xl bg-white/90 px-4 pb-6 pt-3 shadow-[0_-4px_20px_rgba(27,67,50,0.05)] backdrop-blur-lg">
        <Link href="/" className={tabClass("rooms")} aria-current={active === "rooms" ? "page" : undefined}>
          <span
            className="material-symbols-outlined"
            style={
              active === "rooms"
                ? { fontVariationSettings: '"FILL" 1, "wght" 400, "GRAD" 0, "opsz" 24' }
                : undefined
            }
          >
            grid_view
          </span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">Rooms</span>
        </Link>
        <Link href="/tasks" className={tabClass("tasks")} aria-current={active === "tasks" ? "page" : undefined}>
          <span className="material-symbols-outlined">all_inbox</span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">Inbox</span>
        </Link>
        <Link
          href="/settings"
          className={tabClass("settings")}
          aria-current={active === "settings" ? "page" : undefined}
        >
          <span className="material-symbols-outlined">settings</span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">Settings</span>
        </Link>
      </nav>
    </>
  );
}
