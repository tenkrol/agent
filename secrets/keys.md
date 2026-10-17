# Ключи агента

**Значений здесь нет.** Значения — в `secrets/agent.env.enc` (шифртекст), пароль — вне репозитория.

| Переменная | Зачем | Где взять |
|---|---|---|
`TELEGRAM_BOT_TOKEN` | бот агента (@Tenkrol_ag_bot) | @BotFather |
`MODEL_API_KEY` | модель для длинных задач | platform.deepseek.com |
`BRIDGE_TOKEN` | приём задач от чат-бота | генерируется на сервере |
`OUTBOX_TOKEN` | точка приёма ответов чат-бота | генерируется на сервере бота |
`YANDEX_DISK_TOKEN` | бэкапы агента | oauth.yandex.ru |
`BACKUP_PASSPHRASE` | пароль шифрования бэкапов | генерируется один раз |
`ALLOWED_USER_IDS` | кто имеет доступ | id владельца |

## Как зашифровать
```sh
# на сервере агента: скопировать рабочий env в репозиторий и зашифровать
cp /etc/agent/agent.env secrets/agent.env
SECRETS_PASSPHRASE='ваш-пароль' bash tools/secrets.sh encrypt
rm secrets/agent.env                     # открытый текст не хранить
```
`secrets/agent.env` и `.env` игнорируются git, в репозиторий попадает только `.enc`.
