# Дельта для домена workflow

## ADDED Requirements

### Requirement: Публикуется проверенный результат слияния
В main ДОЛЖЕН попадать только commit, полученный слиянием проверенного implementation
SHA с актуальным main и прошедший проверки именно в этом результате.

#### Scenario: Проверки слияния красные
- GIVEN тесты integration checkout падают
- WHEN deploy завершается
- THEN main не меняется.

#### Scenario: Чужая ветка
- GIVEN branch не совпадает с веткой verified-результата
- WHEN вызывается deploy
- THEN выпуск отклоняется.
