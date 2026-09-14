import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import type { Viewer } from "@/lib/auth";
import { roleLabel } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { NavLink } from "@/components/NavLink";

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            К
          </span>
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">
            ИИ-куратор
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink href="/">Проекты</NavLink>
          {viewer.role === "head" && <NavLink href="/admin">Управление</NavLink>}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-right leading-tight sm:block">
            <div className="text-xs font-medium">{viewer.login}</div>
            <div className="text-[0.7rem] text-muted-foreground">{roleLabel(viewer.role)}</div>
          </div>
          <form action={logoutAction}>
            <Button variant="outline" size="sm" type="submit">
              Выйти
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
  );
}
