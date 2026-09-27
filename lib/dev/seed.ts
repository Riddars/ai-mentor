import "server-only";
import { getDb } from "@/lib/db";
import {
  applyReconciliation,
  assignSupervisor,
  deleteProjectCascade,
  loadOpenFindings,
  recordAnalysis,
  resolvePendingOnClose,
  setFindingStatusByPerson,
  saveStudentResponse,
  setAnalysisComment,
  setProjectStatus,
  upsertParticipant,
  upsertProject,
  upsertPullRequest,
  type AnalysisOutcome,
  type PullRequestState,
  type ReconcileResult,
  type ReconciledFinding,
  type StatusChange,
} from "@/lib/curator/store";
import { renderComment, renderReplyComment } from "@/lib/curator/review";
import { countUsersByRole, createUser, findUserByLogin, type User } from "@/lib/users";

// Demo data for exercising the panel in development. Uses the owner "demo-org" so
// it never collides with real projects. Reseeding is clean: previous demo-org
// projects are deleted first, so the demo always reflects the latest scenarios and
// dates stay anchored to "today". Every scenario mirrors a real write path of the
// curator (webhook / review.ts): new findings are born "open" and change status
// only through a later reconciliation; each analysis keeps its materials and the
// comment the curator would have published.

const DEMO_OWNER = "demo-org";

function db() {
  return getDb();
}

function backdate(table: string, id: number, daysAgo: number): void {
  db()
    .prepare(`UPDATE ${table} SET created_at = datetime('now', @d) WHERE id = @id`)
    .run({ id, d: `-${daysAgo} days` });
}

/** Status changes made outside an analysis (merge, a person) get their own date. */
function backdateLastChange(findingId: number, daysAgo: number): void {
  db()
    .prepare(
      `UPDATE finding_status_history SET created_at = datetime('now', @d)
       WHERE id = (SELECT MAX(id) FROM finding_status_history WHERE finding_id = @findingId)`,
    )
    .run({ findingId, d: `-${daysAgo} days` });
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

interface ReviewOptions {
  files: string[];
  trigger?: "commit" | "comment";
  outcome?: AnalysisOutcome;
  researchDoc?: boolean;
}

/**
 * One analysis of a PR as review.ts records it: the analysis with its materials,
 * the reconciliation, and the comment published to the pull request.
 */
function review(
  prId: number,
  daysAgo: number,
  result: ReconcileResult | null,
  opts: ReviewOptions,
): StatusChange[] {
  const trigger = opts.trigger ?? "commit";
  const outcome = opts.outcome ?? "ok";
  const prior = loadOpenFindings(prId);
  const responses = db()
    .prepare("SELECT COUNT(*) AS n FROM student_responses WHERE pull_request_id = @prId")
    .get({ prId }) as { n: number };

  const id = recordAnalysis({
    prId,
    headSha: `demo${(shaCounter += 1).toString(16).padStart(6, "0")}`,
    trigger,
    outcome,
    summary: result?.summary || null,
    provider: outcome === "error" ? null : "provod",
    model: outcome === "error" ? null : "deepseek/deepseek-v4-pro",
    materials:
      outcome === "error"
        ? null
        : {
            files: opts.files,
            researchDoc: opts.researchDoc ?? true,
            truncated: false,
            priorFindings: prior.length,
            studentResponses: responses.n,
          },
  });
  backdate("analyses", id, daysAgo);
  if (!result || outcome !== "ok") return [];

  const { statusChanges, kept } = applyReconciliation(prId, id, result, {
    allowedPriorIds: new Set(prior.map((f) => f.id)),
    allowNew: trigger === "commit",
  });
  const comment =
    trigger === "commit"
      ? renderComment(result, statusChanges)
      : renderReplyComment(statusChanges, kept);
  if (comment) setAnalysisComment(id, comment);
  return statusChanges;
}

/** A clean analysis: nothing found, nothing changed. */
function quiet(prId: number, daysAgo: number, files: string[]): void {
  review(prId, daysAgo, { summary: "Разбор изменений: существенных проблем нет.", findings: [] }, { files });
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
  return { priorId: null, status: "open", severity: "important", area: "methodology", ...f };
}

/** The same finding carried to a later reconciliation with a new status. */
function carry(
  original: ReconciledFinding,
  change: StatusChange,
  status: ReconciledFinding["status"],
  reason: string,
  patch: Partial<ReconciledFinding> = {},
): ReconciledFinding {
  return { ...original, ...patch, priorId: change.findingId, status, reason };
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

  // 1. A critical leak spread over two files, open 20 days despite fresh commits; a
  //    reasoning finding with no single place in code; an earlier PR MERGED with a
  //    critical data finding still open (раздел 6).
  const solubility = upsertProject(DEMO_OWNER, "solubility", "Предсказание растворимости (ESOL)");
  upsertParticipant(solubility, "student-anna");
  upsertParticipant(solubility, "student-boris");

  const s0 = pr(solubility, 1, "student-boris", "Загрузка и очистка датасета", "merged");
  review(
    s0,
    34,
    {
      summary: "Добавлены загрузка ESOL и первичная очистка данных.",
      findings: [
        finding({
          area: "data",
          severity: "critical",
          title: "Дубликаты молекул в датасете не удалены",
          description:
            "Одни и те же молекулы записаны разными строками SMILES, а часть повторов имеет разные значения растворимости. Очистка их не находит.",
          locations: [
            { kind: "file", target: "src/data.py", detail: "18-27" },
            { kind: "data", target: "data/esol.csv" },
          ],
          evidence: "drop_duplicates() не вызывается; SMILES не канонизируются перед сравнением.",
          impact: "Одни и те же молекулы попадают и в обучающую, и в тестовую выборку — качество модели завышено.",
          recommendation: "Канонизировать SMILES (RDKit), удалить дубликаты до разбиения, противоречивые метки усреднить или исключить.",
        }),
      ],
    },
    { files: ["src/data.py", "data/esol.csv"] },
  );
  setPrActivity(s0, 30);

  const s1 = pr(solubility, 3, "student-anna", "Добавил масштабирование признаков", "open");
  quiet(s1, 40, ["src/features.py"]);
  quiet(s1, 26, ["src/features.py", "tests/test_features.py"]);
  const leak = finding({
    area: "methodology",
    severity: "critical",
    title: "Тестовая выборка участвует в масштабировании признаков",
    description:
      "Параметры масштабирования считаются по всему набору данных до разделения на обучающую и тестовую части, а разделение выполняется в другом модуле уже после.",
    locations: [
      { kind: "file", target: "src/features.py", detail: "42-58" },
      { kind: "file", target: "src/train.py", detail: "10-15" },
    ],
    evidence: "features.py: StandardScaler().fit_transform(X)\ntrain.py: train_test_split(X_scaled, y, test_size=0.2)",
    impact: "Статистики тестовой выборки просачиваются в обучение — метрика на тесте завышена и не повторится на новых данных.",
    recommendation: "Сначала разделить данные, затем обучать масштабирование только на обучающей части (sklearn Pipeline).",
  });
  const seed = finding({
    area: "reproducibility",
    severity: "important",
    title: "Разбиение выборки меняется от запуска к запуску",
    description: "При разделении данных не зафиксирован random_state.",
    locations: [{ kind: "file", target: "src/train.py", detail: "12" }],
    evidence: "train_test_split(X, y, test_size=0.2) без random_state.",
    impact: "Результаты нельзя повторить, а сравнение моделей между запусками некорректно.",
    recommendation: "Передать фиксированный random_state и записать его в описание эксперимента.",
  });
  const claim = finding({
    area: "reasoning",
    severity: "important",
    title: "Вывод о превосходстве над бейзлайном сделан по одному разбиению",
    description:
      "В описании исследования утверждается, что модель лучше линейной регрессии, но сравнение проведено на одном случайном разбиении без оценки разброса.",
    locations: [
      { kind: "document", target: "RESEARCH.md", detail: "раздел «Результаты»" },
      { kind: "file", target: "notebooks/compare.ipynb" },
    ],
    evidence: "«Модель превосходит линейную регрессию (RMSE 0.61 против 0.68)» — одно значение без интервала.",
    impact: "Разница может объясняться случайностью разбиения; вывод не обоснован.",
    recommendation: "Повторить сравнение на кросс-валидации (5×5) и указать разброс метрики.",
  });
  review(
    s1,
    20,
    { summary: "Добавлено масштабирование признаков и сравнение с бейзлайном.", findings: [leak, seed, claim] },
    { files: ["src/features.py", "src/train.py", "notebooks/compare.ipynb", "RESEARCH.md"] },
  );
  quiet(s1, 2, ["src/features.py"]);
  reply(s1, 900010, "student-anna", "random_state добавлю в следующем коммите, масштабирование обсуждаю с руководителем.", 2);
  setPrActivity(s1, 2);

  // 2. A metric finding and a plan divergence open; a style note dismissed after the
  //    student's reply (open at the commit analysis, dismissed by the comment one).
  const toxicity = upsertProject(DEMO_OWNER, "toxicity", "Классификация токсичности молекул");
  upsertParticipant(toxicity, "student-vera");
  const t1 = pr(toxicity, 5, "student-vera", "Перешёл на accuracy как метрику", "open");
  quiet(t1, 33, ["notebooks/train.ipynb"]);
  quiet(t1, 19, ["notebooks/train.ipynb", "src/model.py"]);
  const style = finding({
    area: "code",
    severity: "info",
    title: "В ноутбуке остался отладочный вывод",
    description: "В ячейках обучения остались print для отладки.",
    locations: [{ kind: "file", target: "notebooks/train.ipynb" }],
    evidence: "print(X.shape), print(y[:10]) в ячейках 4 и 7.",
    impact: "На результат не влияет, затрудняет чтение.",
    recommendation: "Убрать перед слиянием.",
  });
  const t1changes = review(
    t1,
    4,
    {
      summary: "Метрика качества заменена на accuracy.",
      findings: [
        finding({
          area: "methodology",
          severity: "important",
          title: "Accuracy на несбалансированных классах вводит в заблуждение",
          description: "Токсичных молекул около 8%, а качество оценивается долей верных ответов.",
          locations: [{ kind: "file", target: "notebooks/train.ipynb" }],
          evidence: "Доля положительного класса ≈ 8%, при этом выбрана accuracy.",
          impact: "Модель, которая всегда отвечает «нетоксично», получит ~92% и не найдёт ни одной токсичной молекулы.",
          recommendation: "Использовать ROC-AUC или PR-AUC и отдельно смотреть recall для редкого класса.",
        }),
        finding({
          area: "plan",
          severity: "important",
          title: "Реализована бинарная классификация вместо заявленной регрессии LD50",
          description:
            "В описании исследования целью указано предсказание значения LD50, а в коде целевая переменная бинаризована по порогу.",
          locations: [
            { kind: "document", target: "RESEARCH.md", detail: "раздел «Задача»" },
            { kind: "file", target: "src/model.py", detail: "30-44" },
          ],
          evidence: "RESEARCH.md: «предсказать LD50 (мг/кг)»; model.py: y = (ld50 < 300).astype(int)",
          impact: "Результаты не отвечают на поставленный вопрос; сравнение с литературой по LD50 невозможно.",
          recommendation: "Либо вернуться к регрессии, либо обновить описание исследования и обосновать порог.",
        }),
        style,
      ],
    },
    { files: ["notebooks/train.ipynb", "src/model.py", "RESEARCH.md"] },
  );
  reply(t1, 900001, "student-vera", "Это временный отладочный вывод, уберу перед слиянием. На метрику не влияет.", 3);
  const styleChange = t1changes.find((c) => c.title === style.title);
  if (styleChange) {
    review(
      t1,
      3,
      {
        summary: "Учтён ответ студента.",
        findings: [
          carry(style, styleChange, "dismissed", "Студент объяснил, что уберёт при финализации; на корректность не влияет."),
        ],
      },
      { files: ["notebooks/train.ipynb"], trigger: "comment" },
    );
  }
  setPrActivity(t1, 3);

  // 3. Quiet, and fixed across PRs: the baseline PR was merged with a finding still
  //    open; the next PR fixed it (pending) and its merge closed it. Nothing for 18 days.
  const yieldP = upsertProject(DEMO_OWNER, "reaction-yield", "Предсказание выхода реакции");
  upsertParticipant(yieldP, "student-grigory");
  const y1 = pr(yieldP, 2, "student-grigory", "Базовый бейзлайн", "merged");
  const seeds = finding({
    area: "reproducibility",
    severity: "important",
    title: "Обучение бейзлайна не воспроизводится между запусками",
    description: "Случайный лес обучается без фиксированного random_state, а результаты записаны в README как окончательные.",
    locations: [
      { kind: "file", target: "src/baseline.py", detail: "25" },
      { kind: "document", target: "README.md", detail: "раздел «Результаты»" },
    ],
    evidence: "RandomForestRegressor(n_estimators=500) без random_state.",
    impact: "Числа в README нельзя повторить; сравнение с будущими моделями будет шумным.",
    recommendation: "Зафиксировать random_state и перезапустить бейзлайн.",
  });
  const y1changes = review(
    y1,
    40,
    { summary: "Добавлен бейзлайн на случайном лесе.", findings: [seeds] },
    { files: ["src/baseline.py", "README.md"] },
  );
  setPrActivity(y1, 38);
  const y2 = pr(yieldP, 3, "student-grigory", "Правки бейзлайна", "merged");
  const seedsC = y1changes.find((c) => c.title === seeds.title);
  review(
    y2,
    18,
    {
      summary: "Зафиксированы сиды, бейзлайн перезапущен, результаты в README обновлены.",
      findings: seedsC
        ? [carry(seeds, seedsC, "closed", "random_state зафиксирован в baseline.py, результаты в README пересчитаны.")]
        : [],
    },
    { files: ["src/baseline.py", "README.md"] },
  );
  resolvePendingOnClose(y2, "merged-default");
  if (seedsC) backdateLastChange(seedsC.findingId, 18);
  setPrActivity(y2, 18);

  // 4. A critical finding found and fixed (open → closed), and one that came back
  //    (open → closed → reopened).
  const bandgap = upsertProject(DEMO_OWNER, "bandgap", "Ширина запрещённой зоны");
  upsertParticipant(bandgap, "student-dmitry");
  const b1 = pr(bandgap, 7, "student-dmitry", "Исправил разделение по структурам", "open");
  quiet(b1, 30, ["src/dataset.py"]);
  const dup = finding({
    area: "methodology",
    severity: "critical",
    title: "Одинаковые кристаллические структуры в обучающей и тестовой выборках",
    description: "Данные делятся по строкам, а одна структура встречается в нескольких строках с разными расчётами.",
    locations: [{ kind: "file", target: "src/dataset.py", detail: "77-90" }],
    evidence: "train_test_split по строкам таблицы; material_id не учитывается.",
    impact: "Модель видит тестовые структуры при обучении — оценка завышена.",
    recommendation: "Группировать по структуре (GroupShuffleSplit по material_id).",
  });
  const evalF = finding({
    area: "methodology",
    severity: "important",
    title: "Качество модели считается на обучающей выборке",
    description: "Отчётный R² вычисляется по тем же данным, на которых модель обучалась.",
    locations: [{ kind: "file", target: "src/eval.py", detail: "12" }],
    evidence: "r2_score(y_train, model.predict(X_train))",
    impact: "Отчётный R² ничего не говорит о качестве на новых материалах.",
    recommendation: "Считать метрику на отложенной выборке.",
  });
  const b1changes = review(
    b1,
    12,
    { summary: "Изменена схема разделения данных и оценка качества.", findings: [dup, evalF] },
    { files: ["src/dataset.py", "src/eval.py"] },
  );
  const dupC = b1changes.find((c) => c.title === dup.title);
  const evalC = b1changes.find((c) => c.title === evalF.title);
  if (dupC && evalC) {
    review(
      b1,
      6,
      {
        summary: "Разделение переведено на группы по структурам, метрика — на отложенную выборку.",
        findings: [
          carry(dup, dupC, "closed", "Внедрён GroupShuffleSplit — дубликаты между выборками устранены."),
          carry(evalF, evalC, "closed", "Метрика переведена на отложенную выборку."),
        ],
      },
      { files: ["src/dataset.py", "src/eval.py"] },
    );
    review(
      b1,
      1,
      {
        summary: "Рефакторинг модуля оценки.",
        findings: [
          carry(evalF, evalC, "reopened", "После рефакторинга eval.py снова считает R² на обучающей выборке.", {
            locations: [{ kind: "file", target: "src/eval.py", detail: "14" }],
          }),
        ],
      },
      { files: ["src/eval.py"] },
    );
  }
  setPrActivity(b1, 1);

  // 5. Stale: nothing for 40 days; a methodology finding and a novelty note open.
  const retro = upsertProject(DEMO_OWNER, "retrosynthesis", "Планирование ретросинтеза");
  upsertParticipant(retro, "student-elena");
  const r1 = pr(retro, 4, "student-elena", "Добавил перебор путей синтеза", "open");
  quiet(r1, 68, ["src/search.py"]);
  const r1changes = review(
    r1,
    42,
    {
      summary: "Добавлен перебор путей синтеза и оценка найденных маршрутов.",
      findings: [
        finding({
          area: "methodology",
          severity: "important",
          title: "Оценивается только первый предложенный путь",
          description: "Считается доля точных совпадений top-1; top-k не измеряется.",
          locations: [{ kind: "file", target: "src/search.py", detail: "120-140" }],
          evidence: "accuracy = mean(pred[0] == true_route)",
          impact: "Практическая полезность занижена — верный путь часто находится среди первых пяти.",
          recommendation: "Добавить top-3 и top-5 accuracy к отчёту.",
        }),
        finding({
          area: "novelty",
          severity: "info",
          title: "Нет сравнения с существующими инструментами ретросинтеза",
          description:
            "Предложенный перебор близок к известным подходам (поиск по дереву шаблонов), но в работе не сравнивается ни с одним из них.",
          locations: [
            { kind: "document", target: "RESEARCH.md", detail: "раздел «Методы»" },
            { kind: "other", target: "Сравнение с AiZynthFinder или ASKCOS отсутствует" },
          ],
          evidence: "RESEARCH.md не упоминает существующие системы планирования синтеза.",
          impact: "Неясно, в чём вклад работы относительно известных решений.",
          recommendation: "Добавить сравнение хотя бы с одним открытым инструментом на том же наборе реакций.",
        }),
      ],
    },
    { files: ["src/search.py", "RESEARCH.md"] },
  );
  // The supervisor overrode the model: the comparison is planned for a later stage.
  const novelty = r1changes.find((c) => c.title.startsWith("Нет сравнения"));
  if (novelty) {
    setFindingStatusByPerson({
      findingId: novelty.findingId,
      status: "dismissed",
      reason: "Сравнение с AiZynthFinder запланировано на этап 3 (PLAN.md), сейчас не требуется.",
      actor: "supervisor3",
    });
    backdateLastChange(novelty.findingId, 39);
  }
  setPrActivity(r1, 40);

  // 6. Healthy and busy: a critical leak found earlier and fixed, an info finding open,
  //    a PR closed without merge (its finding is listed apart), latest answer unparsed.
  const proteinLigand = upsertProject(DEMO_OWNER, "protein-ligand", "Аффинность белок–лиганд");
  upsertParticipant(proteinLigand, "student-fedor");
  upsertParticipant(proteinLigand, "student-galina");
  const p0 = pr(proteinLigand, 9, "student-galina", "Эксперимент с GNN (отложен)", "closed");
  review(
    p0,
    25,
    {
      summary: "Экспериментальная ветка с графовой нейросетью.",
      findings: [
        finding({
          area: "methodology",
          severity: "important",
          title: "Гиперпараметры подбираются по тестовой выборке",
          description: "Перебор гиперпараметров оценивает кандидатов на тестовых данных.",
          locations: [{ kind: "file", target: "experiments/gnn.py", detail: "60-75" }],
          evidence: "GridSearch оценивает кандидатов на X_test.",
          impact: "Тест перестаёт быть независимой оценкой.",
          recommendation: "Подбирать на валидации или через вложенную кросс-валидацию.",
        }),
      ],
    },
    { files: ["experiments/gnn.py"] },
  );
  setPrActivity(p0, 24);

  const p1 = pr(proteinLigand, 11, "student-fedor", "Кросс-валидация по белковым семействам", "open");
  quiet(p1, 50, ["src/cv.py"]);
  const ligands = finding({
    area: "methodology",
    severity: "critical",
    title: "Похожие лиганды попадают и в обучение, и в тест",
    description: "Разбиение случайное по строкам; лиганды с общим скелетом оказываются по обе стороны.",
    locations: [{ kind: "file", target: "src/cv.py", detail: "30-52" }],
    evidence: "KFold(shuffle=True) по строкам таблицы.",
    impact: "Оценка завышена: модель запоминает скелеты, а не учится обобщать.",
    recommendation: "Кластеризовать по скелету (Bemis–Murcko) и делить по кластерам.",
  });
  const p1changes = review(
    p1,
    22,
    { summary: "Первая версия кросс-валидации.", findings: [ligands] },
    { files: ["src/cv.py"] },
  );
  quiet(p1, 9, ["src/cv.py", "tests/test_cv.py"]);
  const ligandsC = p1changes.find((c) => c.title === ligands.title);
  review(
    p1,
    5,
    {
      summary: "Кросс-валидация переведена на разбиение по белковым семействам.",
      findings: [
        ...(ligandsC ? [carry(ligands, ligandsC, "closed", "Исправлено в этом PR — разбиение по семействам.")] : []),
        finding({
          area: "reproducibility",
          severity: "info",
          title: "Версии зависимостей не зафиксированы",
          description: "Пакеты в requirements.txt указаны без версий.",
          locations: [{ kind: "file", target: "requirements.txt" }],
          evidence: "rdkit\ntorch\nscikit-learn",
          impact: "Окружение может не воспроизвестись через несколько месяцев.",
          recommendation: "Зафиксировать версии (pip freeze).",
        }),
      ],
    },
    { files: ["src/cv.py", "requirements.txt"] },
  );
  review(p1, 2, null, { files: ["src/cv.py"], outcome: "parse_error" });
  setPrActivity(p1, 2);

  // 7. Unassigned and active: a critical finding open 5 days, a problem-statement
  //    finding, and the latest commit could not be reviewed at all.
  const spectra = upsertProject(DEMO_OWNER, "spectra", "Предсказание ИК-спектров");
  upsertParticipant(spectra, "student-igor");
  const sp1 = pr(spectra, 1, "student-igor", "Первая версия модели спектров", "open");
  quiet(sp1, 16, ["src/train.py"]);
  review(
    sp1,
    5,
    {
      summary: "Первая версия модели предсказания спектров.",
      findings: [
        finding({
          area: "methodology",
          severity: "critical",
          title: "Тестовая выборка используется для ранней остановки",
          description: "Остановка обучения ориентируется на ошибку, посчитанную на тестовом наборе.",
          locations: [{ kind: "file", target: "src/train.py", detail: "88-95" }],
          evidence: "EarlyStopping(monitor='val_loss') с validation_data=(X_test, y_test).",
          impact: "Модель косвенно подгоняется под тест — итоговая оценка оптимистична.",
          recommendation: "Выделить отдельный валидационный набор для ранней остановки.",
        }),
        finding({
          area: "problem",
          severity: "important",
          title: "Не определено, как сравнивать предсказанный спектр с настоящим",
          description:
            "Цель сформулирована как «предсказать ИК-спектр», но не выбрано, что считать хорошим предсказанием: положение пиков, форма или корреляция.",
          locations: [{ kind: "document", target: "RESEARCH.md", detail: "раздел «Цель»" }],
          evidence: "RESEARCH.md: «цель — предсказание ИК-спектров по структуре»; критерий качества не указан.",
          impact: "Без критерия невозможно сравнить модели и сделать вывод об успехе работы.",
          recommendation: "Выбрать метрику сходства спектров (например, косинусную по бинам) и зафиксировать её в описании.",
        }),
      ],
    },
    { files: ["src/train.py", "RESEARCH.md"] },
  );
  // The latest commit could not be reviewed within the retry window: the check was
  // concluded "not reviewed" and the job failed — the panel offers a restart.
  review(sp1, 1, null, { files: [], outcome: "error" });
  db()
    .prepare(
      `INSERT INTO review_jobs (pull_request_id, kind, head_sha, payload, status, attempts,
         check_concluded, note, last_error, created_at)
       VALUES (@prId, 'commit', 'demo-unreviewed', '{}', 'failed', 12, 1, 'deadline',
         'LLM provod 503: service unavailable', datetime('now', '-1 day'))`,
    )
    .run({ prId: sp1 });
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
