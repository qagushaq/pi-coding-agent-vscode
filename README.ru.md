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
2. Откройте пункт Pi Code в activity bar.
3. Отправьте сообщение.
4. Настройте команду/модель через настройки VS Code:
   - `piCode.piCommand`
   - `piCode.defaultModel`
   - `piCode.extraArgs`
