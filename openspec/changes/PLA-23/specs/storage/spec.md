# Дельта для домена storage

## MODIFIED Requirements

### Requirement: Транзакционная очередь с арендой
Очередь ДОЛЖНА поддерживать транзакционный возврат задачи в queued с обновлением
payload, новым generation и идемпотентностью; отмена очереди и завершение ДОЛЖНЫ
быть согласованы между SQLite и журналом.

#### Scenario: Ответ на вопрос
- GIVEN задача в awaiting_owner в SQLite
- WHEN lifecycle.retry с новым payload
- THEN та же задача снова queued с новым generation
- AND claim выдаёт её один раз.

#### Scenario: Отмена очереди
- GIVEN задачи queued в SQLite
- WHEN clearQueue
- THEN claim не выдаёт ни одну из них.

### Requirement: Fencing завершения
Завершить задачу МОЖЕТ только владелец аренды с актуальным generation и живой арендой;
повторный terminal и результат после потери аренды отвергаются.

#### Scenario: Потеря аренды
- GIVEN аренда истекла и задача перезахвачена
- WHEN старая попытка завершает done
- THEN запись отвергается
- AND новая попытка продолжает владеть задачей.
