import "server-only";
import { getDb } from "@/lib/db";
import {
  applyReconciliation,
  assignSupervisor,
  recordAnalysis,
  saveStudentResponse,
  setProjectStatus,
  upsertParticipant,
  upsertProject,
  upsertPullRequest,
  type ReconciledFinding,
} from "@/lib/curator/store";
import { createUser, findUserByLogin } from "@/lib/users";

// Demo data for poking at the panel in development. Uses the owner "demo-org" so
// it never collides with real projects, and is a no-op once already seeded.

const DEMO_OWNER = "demo-org";

function backdate(table: string, id: number, column: string, daysAgo: number): void {
  getDb()
    .prepare(`UPDATE ${table} SET ${column} = datetime('now', @delta) WHERE id = @id`)
    .run({ id, delta: `-${daysAgo} days` });
}

function backdateProjectActivity(prId: number, daysAgo: number): void {
  getDb()
    .prepare("UPDATE pull_requests SET updated_at = datetime('now', @d) WHERE id = @id")
    .run({ id: prId, d: `-${daysAgo} days` });
  getDb()
    .prepare(
      "UPDATE analyses SET created_at = datetime('now', @d) WHERE pull_request_id = @id",
    )
    .run({ id: prId, d: `-${daysAgo} days` });
}

function finding(f: Partial<ReconciledFinding> & { title: string }): ReconciledFinding {
  return {
    priorId: null,
    status: "open",
    severity: "medium",
    category: "methodology",
    ...f,
  };
}

async function ensureUser(login: string, password: string, role: "head" | "supervisor", name: string) {
  const existing = findUserByLogin(login);
  if (existing) return existing;
  return createUser({ login, password, role, name });
}

export async function seedDemo(): Promise<{ seeded: boolean; message: string }> {
  if (!findUserByLogin("head") && !process.env.HEAD_LOGIN) {
    await ensureUser("head", "head", "head", "Руководитель центра");
  }
  const sup1 = await ensureUser("supervisor1", "supervisor1", "supervisor", "Руководитель 1");
  const sup2 = await ensureUser("supervisor2", "supervisor2", "supervisor", "Руководитель 2");

  const solubilityId = upsertProject(DEMO_OWNER, "solubility", "Предсказание растворимости (ESOL)");
  const existing = getDb()
    .prepare("SELECT COUNT(*) AS n FROM pull_requests WHERE project_id = @id")
    .get({ id: solubilityId }) as { n: number };
  if (existing.n > 0) {
    return { seeded: false, message: "Демо-данные уже залиты." };
  }

  // RED: a serious finding open for 20 days.
  upsertParticipant(solubilityId, "student-anna");
  upsertParticipant(solubilityId, "student-boris");
  const pr1 = upsertPullRequest(solubilityId, 3, {
    author: "student-anna",
    title: "Добавил масштабирование признаков",
    state: "open",
  });
  const a1 = recordAnalysis({ prId: pr1, headSha: "aaa111", trigger: "commit", outcome: "ok" });
  const r1 = applyReconciliation(pr1, a1, {
    summary: "Разобрал добавление масштабирования признаков.",
    findings: [
      finding({
        severity: "high",
        category: "data-leakage",
        title: "Масштабирование признаков выполнено до разделения на train/test",
        file: "src/features.py",
        lines: "42-58",
        evidence:
          "StandardScaler().fit_transform(X) вызывается на всём наборе до train_test_split.",
        impact:
          "Статистики масштабирования вобрали в себя тестовую выборку — метрика на тесте завышена и невоспроизводима на новых данных.",
        recommendation:
          "Разделить данные сначала, fit только на train, transform применять к train и test отдельно (или через Pipeline).",
        reason: "Обнаружено при разборе коммита.",
      }),
      finding({
        severity: "medium",
        category: "reproducibility",
        title: "Не зафиксирован random_state при разделении выборки",
        file: "src/split.py",
        lines: "10",
        evidence: "train_test_split(X, y, test_size=0.2) без random_state.",
        impact: "Разбиение меняется между запусками — результаты невоспроизводимы.",
        recommendation: "Передать фиксированный random_state.",
        reason: "Обнаружено при разборе коммита.",
      }),
    ],
  });
  const seriousFinding = r1.statusChanges.find((s) => s.title.startsWith("Масштабирование"));
  if (seriousFinding) backdate("findings", seriousFinding.findingId, "created_at", 20);

  // YELLOW: a medium finding open, plus a dismissed one with a student response.
  const toxicityId = upsertProject(DEMO_OWNER, "toxicity", "Классификация токсичности молекул");
  upsertParticipant(toxicityId, "student-vera");
  const pr2 = upsertPullRequest(toxicityId, 5, {
    author: "student-vera",
    title: "Перешёл на accuracy как метрику",
    state: "open",
  });
  const a2 = recordAnalysis({ prId: pr2, headSha: "bbb222", trigger: "commit", outcome: "ok" });
  const r2 = applyReconciliation(toxicityId, a2, {
    summary: "Разобрал смену метрики качества.",
    findings: [
      finding({
        severity: "medium",
        category: "metric",
        title: "Accuracy на несбалансированных классах вводит в заблуждение",
        file: "notebooks/train.ipynb",
        evidence: "Доля положительного класса ≈ 8%, при этом выбрана accuracy.",
        impact: "Тривиальный классификатор даст ~92% accuracy, не обнаруживая токсичные молекулы.",
        recommendation: "Использовать ROC-AUC или PR-AUC, смотреть на recall для редкого класса.",
      }),
      finding({
        severity: "low",
        category: "style",
        title: "Закомментированный отладочный код в ячейках",
        file: "notebooks/train.ipynb",
        status: "dismissed",
        evidence: "Несколько print для отладки.",
        impact: "На результат не влияет.",
        recommendation: "Убрать перед слиянием.",
        reason: "Студент объяснил, что уберёт при финализации; на корректность не влияет.",
      }),
    ],
  });
  const dismissed = r2.statusChanges.find((s) => s.title.startsWith("Закомментированный"));
  if (dismissed) {
    saveStudentResponse({
      prId: pr2,
      commentId: 900001,
      login: "student-vera",
      body: "Это временный отладочный вывод, уберу перед слиянием. На метрику не влияет.",
      findingId: dismissed.findingId,
    });
  }

  // YELLOW (slowing): no open findings, no activity for 18 days.
  const yieldId = upsertProject(DEMO_OWNER, "reaction-yield", "Предсказание выхода реакции");
  upsertParticipant(yieldId, "student-grigory");
  const pr3 = upsertPullRequest(yieldId, 2, {
    author: "student-grigory",
    title: "Базовый бейзлайн",
    state: "merged",
  });
  recordAnalysis({
    prId: pr3,
    headSha: "ccc333",
    trigger: "commit",
    outcome: "ok",
    summary: "Существенных замечаний нет.",
  });
  backdateProjectActivity(pr3, 18);

  // GREEN: a serious finding that was fixed (open → closed).
  const bandgapId = upsertProject(DEMO_OWNER, "bandgap", "Предсказание ширины запрещённой зоны");
  upsertParticipant(bandgapId, "student-dmitry");
  const pr4 = upsertPullRequest(bandgapId, 7, {
    author: "student-dmitry",
    title: "Исправил разделение по структурам",
    state: "open",
  });
  const a4a = recordAnalysis({ prId: pr4, headSha: "ddd444", trigger: "commit", outcome: "ok" });
  const r4 = applyReconciliation(bandgapId, a4a, {
    summary: "Нашёл дубликаты структур между выборками.",
    findings: [
      finding({
        severity: "high",
        category: "data-leakage",
        title: "Одинаковые кристаллические структуры в train и test",
        file: "src/dataset.py",
        lines: "77-90",
        evidence: "Разбиение по строкам, а не по уникальным структурам.",
        impact: "Модель видит тестовые структуры при обучении — оценка завышена.",
        recommendation: "Группировать по структуре (GroupShuffleSplit).",
      }),
    ],
  });
  const fixed = r4.statusChanges[0];
  const a4b = recordAnalysis({ prId: pr4, headSha: "ddd555", trigger: "commit", outcome: "ok" });
  if (fixed) {
    applyReconciliation(bandgapId, a4b, {
      summary: "Повторная проверка: разделение исправлено.",
      findings: [
        finding({
          priorId: fixed.findingId,
          status: "closed",
          severity: "high",
          category: "data-leakage",
          title: "Одинаковые кристаллические структуры в train и test",
          file: "src/dataset.py",
          lines: "77-90",
          reason: "Внедрён GroupShuffleSplit — дубликаты между выборками устранены.",
        }),
      ],
    });
  }

  // Paused project.
  const pausedId = upsertProject(DEMO_OWNER, "legacy-qsar", "Старый QSAR-проект");
  upsertParticipant(pausedId, "student-elena");
  setProjectStatus(pausedId, "paused");

  assignSupervisor(solubilityId, sup1.id);
  assignSupervisor(toxicityId, sup1.id);
  assignSupervisor(bandgapId, sup2.id);

  return {
    seeded: true,
    message: "Демо-данные залиты: 5 проектов, руководители supervisor1/supervisor2.",
  };
}
