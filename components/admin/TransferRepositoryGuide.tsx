export function TransferRepositoryGuide({ org }: { org: string }) {
  return (
    <details className="rounded-lg border border-border p-4 text-sm">
      <summary className="cursor-pointer font-semibold">
        Как перенести существующий репозиторий с коммитами и ветками
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <p>Ветки, коммиты и PR сохранятся. Для переноса нужны права администратора
          репозитория и участника нашей организации.</p>
        <ol className="flex list-decimal flex-col gap-3 pl-5">
          <li>В исходном репозитории откройте <b>Settings</b>, раздел <b>General</b>.
            Внизу страницы, в <b>Danger Zone</b>, нажмите <b>Transfer</b>.</li>
          <li>В поле <b>New owner</b> выберите <b>{org}</b>. Если организации нет в списке,
            выберите <b>Specify an organization or username</b> и введите её название.</li>
          <li>Введите имя репозитория для подтверждения и нажмите <b>I understand, transfer this repository</b>.</li>
          <li>После переноса подключите его в форме ниже: <b>Owner</b> — <code>{org}</code>,
            <b> Repo</b> — имя репозитория.</li>
        </ol>
        <p>Если проект уже есть на компьютере, обновите его адрес в терминале из папки проекта:</p>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{`git remote set-url origin https://github.com/${org}/ИМЯ-РЕПОЗИТОРИЯ.git`}</code></pre>
        <p>Замените <code>ИМЯ-РЕПОЗИТОРИЯ</code> на название своего репозитория.</p>
      </div>
    </details>
  );
}
