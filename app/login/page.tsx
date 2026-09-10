import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { authEnabled } from "@/lib/auth";
import { getViewer } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!authEnabled()) {
    if (process.env.NODE_ENV === "development") redirect("/");
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
          Вход не настроен: задайте переменную окружения AUTH_SECRET и перезапустите
          сервис.
        </p>
      </main>
    );
  }

  if (await getViewer()) redirect("/");

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-tight">ИИ-куратор</h1>
          <p className="mt-1 text-sm text-muted-foreground">Панель руководителя</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
