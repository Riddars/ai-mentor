export function TransferRepositoryGuide({ org }: { org: string }) {
  const linkClass = "font-medium text-primary hover:underline";

  return (
    <details className="rounded-lg border border-border p-4 text-sm">
      <summary className="cursor-pointer font-semibold">
        Уже есть репозиторий? Как перенести его в {org}
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <p>
          Этот путь подходит, если проект уже ведётся в личном аккаунте или другой
          организации GitHub. Перенос сохраняет ветки, коммиты, теги, issues и pull
          requests. Репозиторий сменит владельца и адрес: вместо прежнего владельца
          в адресе будет <b>{org}</b>. Новый репозиторий из шаблона для этого создавать не нужно.
        </p>
        <ol className="flex list-decimal flex-col gap-4 pl-5">
          <li>
            <b>Подготовьте доступ.</b> Войдите в GitHub под своим аккаунтом.
            У вас должны быть права администратора исходного репозитория и разрешение
            создавать репозитории в {org}. Если вы ещё не участник нашей организации,
            попросите руководителя центра пригласить вас и примите приглашение.
            Членство можно проверить на{" "}
            <a href={`https://github.com/orgs/${org}/people`} target="_blank" rel="noreferrer" className={linkClass}>
              странице участников {org}
            </a>.
            Если прежняя организация запрещает перенос, обратитесь к её владельцу.
          </li>
          <li>
            <b>Проверьте имя.</b> Откройте{" "}
            <a href={`https://github.com/orgs/${org}/repositories`} target="_blank" rel="noreferrer" className={linkClass}>
              репозитории нашей организации
            </a>{" "}
            и убедитесь, что такого имени ещё нет. При совпадении согласуйте другое имя
            с руководителем центра. Не создавайте пустой репозиторий с этим именем перед переносом.
          </li>
          <li>
            <b>Откройте настройки исходного репозитория.</b> Перейдите на его страницу
            в GitHub → <b>Settings</b> → <b>General</b>. Прокрутите страницу до самого
            низа, до раздела <b>Danger Zone</b>. В строке <b>Transfer ownership</b>
            нажмите <b>Transfer</b>. Если кнопки нет или она недоступна, попросите
            владельца исходного репозитория выполнить перенос.
          </li>
          <li>
            <b>Укажите новую организацию.</b> В поле <b>New owner</b> выберите{" "}
            <b>Select one of my organizations</b> и организацию <b>{org}</b>.
            Если её нет в списке, выберите <b>Specify an organization or username</b>
            и введите <code>{org}</code>. Проверьте написание имени организации.
            Если GitHub сообщает о нехватке прав, обратитесь к руководителю центра.
          </li>
          <li>
            <b>Подтвердите перенос.</b> Прочитайте предупреждения GitHub, введите
            имя репозитория в поле подтверждения и нажмите{" "}
            <b>I understand, transfer this repository</b>. Дождитесь завершения.
            Откройте репозиторий по новому адресу и проверьте, что вверху указано{" "}
            <code>{org}/имя-репозитория</code>. На вкладке <b>Code</b> проверьте
            список веток и историю коммитов, а на <b>Pull requests</b> — сохранённые PR.
          </li>
          <li>
            <b>Проверьте доступ людей и куратора.</b> В перенесённом репозитории
            откройте <b>Settings → Collaborators and teams</b> (раздел управления
            доступом). У студентов должно быть право <b>Write</b>, а у руководителя,
            который приглашает участников, — <b>Admin</b>.
            Если приложение не видит репозиторий, попросите владельца организации открыть{" "}
            <a href={`https://github.com/organizations/${org}/settings/installations`} target="_blank" rel="noreferrer" className={linkClass}>
              настройки GitHub Apps
            </a>{" "}
            → <b>AI Chem Curator → Configure</b>. При выборе <b>Only select repositories</b>
            нужно добавить перенесённый репозиторий и сохранить. При <b>All repositories</b>
            он уже входит в область доступа.
          </li>
          <li>
            <b>Подключите проект к сервису.</b> Вернитесь на эту страницу. В форме
            подключения укажите <b>владелец (owner)</b> — <code>{org}</code>,{" "}
            <b>репозиторий (repo)</b> — только его имя, без ссылки и без <code>.git</code>.
            Название проекта можно указать по желанию. Нажмите <b>Подключить</b>.
            Сервис откроет настройки проекта и запустит первый обзор основной ветки.
            Сам перенос в GitHub проект к сервису не подключает.
          </li>
          <li>
            <b>Обновите адрес в локальных копиях.</b> Если вы или студенты уже работаете
            с проектом на компьютере, откройте терминал в его папке и выполните команду,
            заменив <code>ИМЯ-РЕПОЗИТОРИЯ</code> на настоящее имя:
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs"><code>{`git remote set-url origin https://github.com/${org}/ИМЯ-РЕПОЗИТОРИЯ.git\ngit remote -v`}</code></pre>
            <p className="mt-2">Во второй команде проверьте, что адрес origin содержит <code>{org}</code>.
              При работе через SSH скопируйте SSH-адрес из <b>Code → SSH</b> нового репозитория
              и используйте его вместо HTTPS-адреса.</p>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Если репозиторий уже подключён к нашему сервису под старым адресом,
          перед переносом обратитесь к руководителю центра, чтобы сохранить связь
          с его замечаниями и историей разборов. Повторно подключать такой проект не нужно.
          При переносе приватного репозитория с платного тарифа на GitHub Free
          некоторые возможности GitHub, например защита веток, могут стать недоступны.
          Особые случаи переноса описаны в{" "}
          <a href="https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository" target="_blank" rel="noreferrer" className={linkClass}>
            официальной инструкции GitHub
          </a>.
        </p>
      </div>
    </details>
  );
}
