import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import type { Viewer } from "@/lib/auth";
import { Button } from "@/components/ui/Button";

const ROLE_LABEL: Record<Viewer["role"], string> = {
  head: "Руководитель центра",
  supervisor: "Руководитель проекта",
};

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          ИИ-куратор
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            Проекты
          </Link>
          {viewer.role === "head" && (
            <Link href="/admin" className="hover:text-foreground">
              Управление
            </Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-right text-xs leading-tight text-muted-foreground sm:block">
            {viewer.login}
            <br />
            {ROLE_LABEL[viewer.role]}
          </span>
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
  return <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>;
}
