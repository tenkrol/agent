# Решение

Состояние: items[] {id,signature,at,day,status: proposed|later|done|never, suggestion}.
propose отбрасывает never, уже proposed в тот же день и сигнатуры из later до
следующего дня; соблюдает quietHours и dailyLimit. decide пишет историю.
