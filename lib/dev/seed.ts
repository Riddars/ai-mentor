import "server-only";
import { getDb } from "@/lib/db";
import {
  applyReconciliation,
  assignSupervisor,
  deleteProjectCascade,
  recordAnalysis,
  saveStudentResponse,
  setProjectStatus,
  upsertParticipant,
  upsertProject,
  upsertPullRequest,
  type AnalysisOutcome,
  type PullRequestState,
  type ReconciledFinding,
} from "@/lib/curator/store";
import { countUsersByRole, createUser, findUserByLogin, type User } from "@/lib/users";

// Demo data for exercising the panel in development. Uses the owner "demo-org" so
// it never collides with real projects. Reseeding is clean: previous demo-org
// projects are deleted first, so the demo always reflects the latest scenarios and
// dates stay anchored to "today". Every scenario mirrors a real write path of the
// curator (webhook / review.ts): new findings are born "open" and change status
// only through a later reconciliation, categories are free Russian text.

const DEMO_OWNER = "demo-org";

function db() {
  return getDb();
}

function backdate(table: string, id: number, daysAgo: number): void {
  db()
    .prepare(`UPDATE ${table} SET created_at = datetime('now', @d) WHERE id = @id`)
    .run({ id, d: `-${daysAgo} days` });
}

function setPrActivity(prId: number, daysAgo: number): void {
  db()
    .prepare("UPDATE pull_requests SET updated_at = datetime('now', @d) WHERE id = @id")
    .run({ id: prId, d: `-${daysAgo} days` });
}

/** Demo findings and history inherit the dates of the analyses that produced them. */
function alignDatesToAnalyses(): void {
  const demoPrs = `SELECT pr.id FROM pull_requests pr
    JOIN projects p ON p.id = pr.project_id WHERE p.owner = '${DEMO_OWNER}'`;
  db().exec(`
    UPDATE findings SET
      created_at = (SELECT created_at FROM analyses WHERE id = findings.first_analysis_id),
      updated_at = (SELECT created_at FROM analyses WHERE id = findings.last_analysis_id)
    WHERE first_analysis_id IS NOT NULL AND pull_request_id IN (${demoPrs});
    UPDATE finding_status_history SET
      created_at = (SELECT created_at FROM analyses WHERE id = finding_status_history.analysis_id)
    WHERE analysis_id IS NOT NULL
      AND finding_id IN (SELECT id FROM findings WHERE pull_request_id IN (${demoPrs}));
  `);
}

let shaCounter = 0;
function mkAnalysis(
  prId: number,
  daysAgo: number,
  summary: string | null,
  outcome: AnalysisOutcome = "ok",
  trigger: "commit" | "comment" = "commit",
): number {
  const id = recordAnalysis({
    prId,
    headSha: `demo${(shaCounter += 1).toString(16).padStart(6, "0")}`,
    trigger,
    outcome,
    summary,
  });
  backdate("analyses", id, daysAgo);
  return id;
}

/** Filler analyses spread over the 12-week window so the sparkline has shape. */
function fillActivity(prId: number, daysAgoList: number[]): void {
  for (const d of daysAgoList) mkAnalysis(prId, d, "Разбор изменений: существенных замечаний нет.");
}

function pr(projectId: number, number: number, author: string, title: string, state: PullRequestState): number {
  return upsertPullRequest(projectId, number, { author, title, state });
}

function reply(prId: number, commentId: number, login: string, body: string, daysAgo: number): void {
  saveStudentResponse({ prId, commentId, login, body });
  db()
    .prepare("UPDATE student_responses SET created_at = datetime('now', @d) WHERE comment_id = @c")
    .run({ c: commentId, d: `-${daysAgo} days` });
}

function finding(f: Partial<ReconciledFinding> & { title: string }): ReconciledFinding {
  return { priorId: null, status: "open", severity: "medium", category: "Методика", ...f };
}

async function ensureUser(
  login: string,
  password: string,
  role: "head" | "supervisor",
  name: string,
): Promise<User> {
  const existing = findUserByLogin(login);
  if (existing) return existing;
  return createUser({ login, password, role, name });
}

function resetDemo(): void {
  const ids = (
    db().prepare("SELECT id FROM projects WHERE owner = @o").all({ o: DEMO_OWNER }) as Array<{
      id: number;
    }>
  ).map((r) => r.id);
  for (const id of ids) deleteProjectCascade(id);
}

export async function seedDemo(): Promise<{ seeded: boolean; message: string }> {
  if (countUsersByRole("head") === 0 && !process.env.HEAD_LOGIN) {
    await ensureUser("head", "head", "head", "Руководитель центра");
  }
  const sup1 = await ensureUser("supervisor1", "supervisor1", "supervisor", "Ирина Петрова");
  const sup2 = await ensureUser("supervisor2", "supervisor2", "supervisor", "Сергей Иванов");
  const sup3 = await ensureUser("supervisor3", "supervisor3", "supervisor", "Мария Кузнецова");

  resetDemo();

  // 1. Serious data-leakage finding open 20 days despite fresh commits; plus an
  //    earlier PR that was MERGED with a serious finding still open (раздел 6).
  const solubility = upsertProject(DEMO_OWNER, "solubility", "Предсказание растворимости (ESOL)");
  upsertParticipant(solubility, "student-anna");
  upsertParticipant(solubility, "student-boris");

  const s0 = pr(solubility, 1, "student-boris", "Загрузка и очистка датасета", "merged");
  const s0a = mkAnalysis(s0, 34, "Разобрал загрузку данных.");
  applyReconciliation(s0, s0a, {
    summary: "Разобрал загрузку данных.",
    findings: [
      finding({
        severity: "high",
        category: "Качество данных",
        title: "Дубликаты SMILES в датасете не удалены",
        file: "src/data.py",
        lines: "18-27",
        evidence: "drop_duplicates() не вызывается; в ESOL ≈ 3% повторов с разными метками.",
        impact: "Одни и те же молекулы попадают и в train, и в test — оценка завышена.",
        recommendation: "Канонизировать SMILES и удалить дубликаты до разбиения.",
      }),
    ],
  });
  setPrActivity(s0, 30);

  const s1 = pr(solubility, 3, "student-anna", "Добавил масштабирование признаков", "open");
  fillActivity(s1, [72, 58, 40, 26]);
  const s1a = mkAnalysis(s1, 20, "Разобрал добавление масштабирования признаков.");
  applyReconciliation(s1, s1a, {
    summary: "Разобрал добавление масштабирования признаков.",
    findings: [
      finding({
        severity: "high",
        category: "Утечка данных",
        title: "Масштабирование признаков выполнено до разделения на train/test",
        file: "src/features.py",
        lines: "42-58",
        evidence: "StandardScaler().fit_transform(X) вызывается на всём наборе до train_test_split.",
        impact:
          "Статистики масштабирования вобрали в себя тестовую выборку — метрика на тесте завышена и невоспроизводима на новых данных.",
        recommendation:
          "Разделить данные сначала, fit только на train, transform применять к train и test отдельно (через Pipeline).",
        reason: "Обнаружено при разборе коммита.",
      }),
      finding({
        severity: "medium",
        category: "Воспроизводимость",
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
  mkAnalysis(s1, 2, "Новый коммит: правок по утечке нет, замечания остаются открытыми.");
  reply(s1, 900010, "student-anna", "random_state добавлю в следующем коммите, масштабирование обсуждаю с руководителем.", 2);
  setPrActivity(s1, 2);

  // 2. Medium metric finding open; a style note dismissed after the student's reply
  //    (open at the commit analysis, dismissed by the comment reconciliation).
  const toxicity = upsertProject(DEMO_OWNER, "toxicity", "Классификация токсичности молекул");
  upsertParticipant(toxicity, "student-vera");
  const t1 = pr(toxicity, 5, "student-vera", "Перешёл на accuracy как метрику", "open");
  fillActivity(t1, [50, 33, 19, 8]);
  const t1a = mkAnalysis(t1, 4, "Разобрал смену метрики качества.");
  const t1r = applyReconciliation(t1, t1a, {
    summary: "Разобрал смену метрики качества.",
    findings: [
      finding({
        severity: "medium",
        category: "Метрика",
        title: "Accuracy на несбалансированных классах вводит в заблуждение",
        file: "notebooks/train.ipynb",
        evidence: "Доля положительного класса ≈ 8%, при этом выбрана accuracy.",
        impact: "Тривиальный классификатор даст ~92% accuracy, не обнаруживая токсичные молекулы.",
        recommendation: "Использовать ROC-AUC или PR-AUC, смотреть на recall для редкого класса.",
      }),
      finding({
        severity: "low",
        category: "Стиль",
        title: "Закомментированный отладочный код в ячейках",
        file: "notebooks/train.ipynb",
        evidence: "Несколько print для отладки.",
        impact: "На результат не влияет.",
        recommendation: "Убрать перед слиянием.",
      }),
    ],
  });
  reply(t1, 900001, "student-vera", "Это временный отладочный вывод, уберу перед слиянием. На метрику не влияет.", 3);
  const style = t1r.statusChanges.find((c) => c.title.startsWith("Закомментированный"));
  const t1b = mkAnalysis(t1, 3, "Учёл ответ студента.", "ok", "comment");
  if (style) {
    applyReconciliation(t1, t1b, {
      summary: "Учёл ответ студента.",
      findings: [
        finding({
          priorId: style.findingId,
          status: "dismissed",
          severity: "low",
          category: "Стиль",
          title: "Закомментированный отладочный код в ячейках",
          file: "notebooks/train.ipynb",
          reason: "Студент объяснил, что уберёт при финализации; на корректность не влияет.",
        }),
      ],
    });
  }
  setPrActivity(t1, 3);

  // 3. Quiet: merged baseline, no findings, nothing for 18 days.
  const yieldP = upsertProject(DEMO_OWNER, "reaction-yield", "Предсказание выхода реакции");
  upsertParticipant(yieldP, "student-grigory");
  const y1 = pr(yieldP, 2, "student-grigory", "Базовый бейзлайн", "merged");
  fillActivity(y1, [40, 28]);
  mkAnalysis(y1, 18, "Существенных замечаний нет.");
  setPrActivity(y1, 18);

  // 4. A serious finding found and fixed (open → closed), and one that came back
  //    (open → closed → reopened).
  const bandgap = upsertProject(DEMO_OWNER, "bandgap", "Ширина запрещённой зоны");
  upsertParticipant(bandgap, "student-dmitry");
  const b1 = pr(bandgap, 7, "student-dmitry", "Исправил разделение по структурам", "open");
  fillActivity(b1, [60, 46, 30]);
  const b1a = mkAnalysis(b1, 12, "Нашёл дубликаты структур между выборками.");
  const b1r = applyReconciliation(b1, b1a, {
    summary: "Нашёл дубликаты структур между выборками.",
    findings: [
      finding({
        severity: "high",
        category: "Утечка данных",
        title: "Одинаковые кристаллические структуры в train и test",
        file: "src/dataset.py",
        lines: "77-90",
        evidence: "Разбиение по строкам, а не по уникальным структурам.",
        impact: "Модель видит тестовые структуры при обучении — оценка завышена.",
        recommendation: "Группировать по структуре (GroupShuffleSplit).",
      }),
      finding({
        severity: "medium",
        category: "Оценка качества",
        title: "Метрика считается на train, а не на hold-out",
        file: "src/eval.py",
        lines: "12",
        evidence: "r2_score(y_train, model.predict(X_train)).",
        impact: "Отчётный R² не говорит об обобщающей способности.",
        recommendation: "Считать метрику на отложенной выборке.",
      }),
    ],
  });
  const dup = b1r.statusChanges.find((c) => c.title.startsWith("Одинаковые"));
  const evalF = b1r.statusChanges.find((c) => c.title.startsWith("Метрика"));
  if (dup && evalF) {
    const b1b = mkAnalysis(b1, 6, "Повторная проверка: разделение исправлено, метрика на hold-out.");
    applyReconciliation(b1, b1b, {
      summary: "Повторная проверка.",
      findings: [
        finding({ priorId: dup.findingId, status: "closed", severity: "high", category: "Утечка данных",
          title: "Одинаковые кристаллические структуры в train и test", file: "src/dataset.py", lines: "77-90",
          reason: "Внедрён GroupShuffleSplit — дубликаты между выборками устранены." }),
        finding({ priorId: evalF.findingId, status: "closed", severity: "medium", category: "Оценка качества",
          title: "Метрика считается на train, а не на hold-out", file: "src/eval.py", lines: "12",
          reason: "Метрика переведена на отложенную выборку." }),
      ],
    });
    const b1c = mkAnalysis(b1, 1, "Рефакторинг вернул старую оценку на train.");
    applyReconciliation(b1, b1c, {
      summary: "Рефакторинг вернул старую оценку на train.",
      findings: [
        finding({ priorId: evalF.findingId, status: "reopened", severity: "medium", category: "Оценка качества",
          title: "Метрика считается на train, а не на hold-out", file: "src/eval.py", lines: "14",
          reason: "После рефакторинга eval.py снова считает R² на обучающей выборке." }),
      ],
    });
  }
  setPrActivity(b1, 1);

  // 5. Stale: nothing for 40 days, one medium finding still open.
  const retro = upsertProject(DEMO_OWNER, "retrosynthesis", "Планирование ретросинтеза");
  upsertParticipant(retro, "student-elena");
  const r1 = pr(retro, 4, "student-elena", "Добавил перебор путей синтеза", "open");
  mkAnalysis(r1, 68, "Разбор перебора путей синтеза.");
  const r1a = mkAnalysis(r1, 42, "Повторный разбор.");
  applyReconciliation(r1, r1a, {
    summary: "Разобрал перебор путей синтеза.",
    findings: [
      finding({
        severity: "medium",
        category: "Оценка качества",
        title: "Оценка только по top-1, без top-k",
        file: "src/search.py",
        lines: "120-140",
        evidence: "Считается доля точных совпадений top-1; top-k accuracy не измеряется.",
        impact: "Занижает практическую полезность — верный путь часто в top-5.",
        recommendation: "Добавить top-3 и top-5 accuracy к отчёту.",
      }),
    ],
  });
  setPrActivity(r1, 40);

  // 6. Healthy and busy: a serious leak found earlier and fixed, a low finding open,
  //    a PR closed without merge (its finding is listed apart), latest answer unparsed.
  const proteinLigand = upsertProject(DEMO_OWNER, "protein-ligand", "Аффинность белок–лиганд");
  upsertParticipant(proteinLigand, "student-fedor");
  upsertParticipant(proteinLigand, "student-galina");
  const p0 = pr(proteinLigand, 9, "student-galina", "Эксперимент с GNN (отложен)", "closed");
  const p0a = mkAnalysis(p0, 25, "Разбор экспериментальной ветки.");
  applyReconciliation(p0, p0a, {
    summary: "Разбор экспериментальной ветки.",
    findings: [
      finding({
        severity: "medium",
        category: "Переобучение",
        title: "Подбор гиперпараметров по тестовой выборке",
        file: "experiments/gnn.py",
        lines: "60-75",
        evidence: "GridSearch оценивает кандидатов на X_test.",
        impact: "Тест перестаёт быть независимой оценкой.",
        recommendation: "Подбирать на валидации или через вложенную CV.",
      }),
    ],
  });
  setPrActivity(p0, 24);

  const p1 = pr(proteinLigand, 11, "student-fedor", "Кросс-валидация по белковым семействам", "open");
  fillActivity(p1, [78, 64, 50, 36]);
  const p1a = mkAnalysis(p1, 22, "Разбор первой версии кросс-валидации.");
  const p1r = applyReconciliation(p1, p1a, {
    summary: "Разбор первой версии кросс-валидации.",
    findings: [
      finding({
        severity: "high",
        category: "Утечка данных",
        title: "Схожие лиганды попадали в train и test",
        file: "src/cv.py",
        lines: "30-52",
        evidence: "Разбиение случайное по строкам; близкие по скелету лиганды оказываются по обе стороны.",
        impact: "Оценка завышена.",
        recommendation: "Кластеризация по скелету и разбиение по кластерам.",
      }),
    ],
  });
  fillActivity(p1, [15, 9]);
  const leak = p1r.statusChanges[0];
  const p1b = mkAnalysis(p1, 5, "Разбор схемы кросс-валидации по семействам.");
  applyReconciliation(p1, p1b, {
    summary: "Разбор схемы кросс-валидации по семействам.",
    findings: [
      ...(leak
        ? [
            finding({ priorId: leak.findingId, status: "closed", severity: "high", category: "Утечка данных",
              title: "Схожие лиганды попадали в train и test", file: "src/cv.py", lines: "30-52",
              reason: "Исправлено в этом PR — разбиение по семействам." }),
          ]
        : []),
      finding({
        severity: "low",
        category: "Воспроизводимость",
        title: "Версии зависимостей не зафиксированы",
        file: "requirements.txt",
        evidence: "Пакеты указаны без версий.",
        impact: "Окружение может не воспроизвестись.",
        recommendation: "Зафиксировать версии (pip freeze).",
      }),
    ],
  });
  mkAnalysis(p1, 2, null, "parse_error");
  setPrActivity(p1, 2);

  // 7. Unassigned and active: high finding open 5 days, and the latest commit
  //    analysis FAILED — the PR's merge stays blocked. Visible to the head only.
  const spectra = upsertProject(DEMO_OWNER, "spectra", "Предсказание ИК-спектров");
  upsertParticipant(spectra, "student-igor");
  const sp1 = pr(spectra, 1, "student-igor", "Первая версия модели спектров", "open");
  fillActivity(sp1, [16, 7]);
  const sp1a = mkAnalysis(sp1, 5, "Разбор первой версии модели.");
  applyReconciliation(sp1, sp1a, {
    summary: "Разбор первой версии модели.",
    findings: [
      finding({
        severity: "high",
        category: "Оценка качества",
        title: "Тестовая выборка использована для ранней остановки",
        file: "src/train.py",
        lines: "88-95",
        evidence: "EarlyStopping отслеживает val_loss, посчитанный на тестовом наборе.",
        impact: "Модель косвенно подгоняется под тест — итоговая оценка оптимистична.",
        recommendation: "Выделить отдельный валидационный набор для ранней остановки.",
      }),
    ],
  });
  mkAnalysis(sp1, 1, null, "error");
  setPrActivity(sp1, 1);

  // 8. Paused project.
  const paused = upsertProject(DEMO_OWNER, "legacy-qsar", "Старый QSAR-проект");
  upsertParticipant(paused, "student-klim");
  setProjectStatus(paused, "paused");

  assignSupervisor(solubility, sup1.id);
  assignSupervisor(toxicity, sup1.id);
  assignSupervisor(yieldP, sup2.id);
  assignSupervisor(bandgap, sup2.id);
  assignSupervisor(retro, sup3.id);
  assignSupervisor(proteinLigand, sup3.id);
  // spectra intentionally left unassigned.

  alignDatesToAnalyses();

  return {
    seeded: true,
    message:
      "Демо-данные залиты: 8 проектов, руководители supervisor1/supervisor2/supervisor3 (пароли совпадают с логинами).",
  };
}
