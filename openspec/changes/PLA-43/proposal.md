# PLA-43 / G3: честные состояния установки и откат

Основание: review G3. Deploy различает merge и installation_required, но нет
healthcheck/rollback и отчёт не отделяет установленный SHA.

## Что меняется
- install-порт возвращает healthy; при неудаче/исключении вызывается rollback.
- Состояния: merged, installation_required, installing, healthy, rolled_back.
- `installed.ok=false` при откате; merge не выдаётся за установку.
- Ручной режим остаётся installation_required с командой владельца.

## Не входит
Автоматический установщик: политика владельца — ручная установка.
