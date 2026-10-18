# Решение

Чистый модуль `request-state.mjs` отделяет правила от HTTP. Approval сравнивается с
manifest по revision и точным SHA компонентов. Implement клонирует ветку, затем
`checkoutCommit` согласованного SHA и проверяет HEAD. Пустой manifest и отсутствие
approval — ошибка, не успех.
