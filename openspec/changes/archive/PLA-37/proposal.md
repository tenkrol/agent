# PLA-37 / E10: персональный агент

Основание: план E10. У агента есть память, но нет исполнителя для личных задач.

## Что меняется
- Исполнитель `personal` (capabilities personal/memory/reminders/preferences).
- В промпт попадают факты памяти владельца (динамический taskPrefix).
- `chooseExecutorId`: personal → monitor → files → dsh; явный id сохраняется.
- Профиль agentProfiles.personal.

## Не входит
Новые хранилища; E11.
