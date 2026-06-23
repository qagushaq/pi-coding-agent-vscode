# Pi Coding Agent VS Code

**Язык / Language:** [English](README.md) | Русский

Расширение VS Code — обёртка над RPC-режимом [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Текущий MVP

- Чат в боковой панели VS Code
- Несколько вкладок задач
- Запуск `pi --mode rpc` для каждой задачи
- Потоковый вывод ответа ассистента
- Блоки выполнения tools
- Остановка/перезапуск задачи
- Выбор модели
- Прикрепление изображения из файла
- Preview изображения перед отправкой
- Удаление прикреплённых изображений перед отправкой
- Paste/drop изображений прямо в чат
- Переименование задач с синхронизацией имени в Pi session
- Статусы задач: idle/running/error
- Отображение session file/id
- Копирование пути сессии
- Экспорт текущей сессии в HTML

## Разработка

```bash
npm install
npm run compile
```

Собрать VSIX:

```bash
npx @vscode/vsce package --no-dependencies
```

## Использование

1. Установите VSIX-файл расширения.
2. Перезагрузите окно VS Code.
3. Откройте пункт Pi Code в activity bar.
4. Отправьте сообщение.
5. Настройте команду/модель через настройки VS Code:
   - `piCode.piCommand`
   - `piCode.defaultModel`
   - `piCode.extraArgs`

## Локальная установка

```bash
npm run package
code --install-extension pi-coding-agent-vscode-0.1.0.vsix --force
```

После этого выполните `Developer: Reload Window` в VS Code.

## Чеклист проверки

- Иконка Pi Code появилась в Activity Bar.
- Новая задача стартует без ошибок команды `pi`.
- Prompt отправляется, ответ ассистента стримится.
- Tool executions отображаются отдельными блоками.
- Кнопки New/Rename/Restart/Stop работают.
- Model selector заполняется.
- Attach/paste/drop image показывает preview и отправляет картинку с prompt.
- Copy session копирует путь текущей Pi session.
- Export HTML пишет путь HTML-транскрипта в чат.
