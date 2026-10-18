# Решение

Policy.decide({action,budgetCost}) → allowed/requiresApproval/reason. observe запрещает
всё; prepare разрешает только подготовку; execute — только allowlisted при enabled и
бюджете; approval — требует подтверждения. cancel() выключает все действия. Бюджет
списывается только при execute.
