# Решение

- `git.mergeAndPush({branch,target})` — явный merge и push (без API PR).
- `createDeployService`:
  1) `confirm !== requestId` → отказ;
  2) `checks()` должен быть зелёным;
  3) merge ветки в main;
  4) `install({repository, sha})` — обязательный порт; без него ошибка.
- Деплой не запускается на неполной заявке и при красных проверках.
