# Решение

Каждое предложение хранится как {id, at, signature, suggestion, status:
shadow|accepted|rejected|later|acted, outcome}. Collect дедуплицирует по id.
Stats считает принятые/отклонённые/действованные за период.
