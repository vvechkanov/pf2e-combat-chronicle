# pf2e-combat-chronicle — Спецификация модуля

## Назначение

Foundry VTT модуль для PF2e, который автоматически протоколирует бои в структурированном формате (JSON + человекочитаемый журнал). Предназначен для:
1. **Пост-обработки боёв** — генерации нарративных пересказов и глав книги
2. **Тактического анализа** — понимания action economy, эффективности персонажей
3. **GM-рефлексии** — что работало, что нет, баланс энкаунтеров

## Среда

- **Foundry VTT:** v13+ (текущая: 13.351)
- **Система:** PF2e 7.11+
- **Только GM:** модуль работает на стороне GM, игрокам ничего не показывает
- **Без зависимостей:** не требует других модулей

---

## Что логируем

### 1. Структура боя (Combat Skeleton)

На каждый encounter автоматически фиксировать:

```
{
  encounter_id: string,
  scene_name: string,
  started_at: ISO timestamp,
  ended_at: ISO timestamp,
  initiative_order: [
    { name, actor_id, initiative_roll, initiative_total }
  ],
  rounds: [ ... ],
  summary: { ... }
}
```

**Хуки:** `combatStart`, `combatRound`, `deleteCombat` (или `combatEnd` если есть)

### 2. Раунды и ходы (Round/Turn tracking)

Для каждого раунда:
```
{
  round_number: number,
  turns: [
    {
      combatant_name: string,
      actor_id: string,
      turn_number: number,
      hp_start: number,
      hp_max: number,
      hp_end: number,         // фиксируется при окончании хода
      temp_hp_start: number,
      temp_hp_end: number,
      position_start: { x, y },
      position_end: { x, y },

      // === ПОЛНЫЙ СНАПШОТ ЭФФЕКТОВ (начало и конец хода) ===
      effects_start: [
        {
          name: string,
          type: string,          // "condition" | "effect"
          slug?: string,
          value?: number,
          remaining_rounds?: number,
          remaining_text?: string,
          source?: string
        }
      ],
      effects_end: [ /* та же структура */ ],

      // Автоматический diff
      effects_gained: string[],
      effects_lost: string[],
      effects_changed: [
        { name: "Frightened", from: 2, to: 1 }
      ],

      actions: [ ... ],
      chat_messages: [ ... ]
    }
  ]
}
```

**Хуки:** `combatTurn`, `updateActor` (для HP), `updateToken` (для позиции)

### 3. Действия (Action Tracking)

На каждое действие в ходе:

```
{
  action_name: string,
  action_cost: number,
  action_type: string,       // "strike", "spell", "skill", "move", "interact", "other"
  item_name?: string,
  item_type?: string,
  targets?: string[],
  roll_result?: number,
  roll_formula?: string,
  degree_of_success?: string,
  damage_dealt?: number,
  damage_type?: string,
  healing_done?: number,
  map_penalty?: number,
  notes?: string
}
```

**Источники данных:**
- `createChatMessage` — главный хук; PF2e кладёт богатые данные в `message.flags.pf2e`
- `updateToken` — для отслеживания перемещений

### 4. HP-трекинг (Health Tracking)

На каждое изменение HP:
```
{
  actor_name: string,
  actor_id: string,
  timestamp: ISO,
  hp_before: number,
  hp_after: number,
  hp_max: number,
  temp_hp_before: number,
  temp_hp_after: number,
  delta: number,             // отрицательное = урон, положительное = хил
  source?: string,
  damage_type?: string
}
```

**Хуки:** `updateActor` (при изменении `system.attributes.hp`)

### 5. Эффекты и состояния (Effect & Condition Tracking)

#### 5a. Снапшоты на начало/конец хода (основной)
Полный снимок `actor.items.filter(i => i.type === "condition" || i.type === "effect")`

#### 5b. Event-лог изменений (дополнительный)
```
{
  actor_name: string,
  effect_name: string,
  effect_type: string,
  slug?: string,
  event: "applied" | "removed" | "value_changed",
  old_value?: number,
  new_value?: number,
  timestamp: ISO,
  round: number,
  turn: number,
  source?: string
}
```

**Хуки:**
- `createItem` на актёре (type === "condition" || type === "effect")
- `deleteItem` на актёре
- `updateItem` на актёре

### 6. Перемещения (Movement Tracking)

```
{
  actor_name: string,
  from: { x, y },
  to: { x, y },
  distance_ft: number,
  timestamp: ISO,
  round: number,
  turn: number
}
```

**Хуки:** `updateToken` (при изменении `x` или `y`)

---

## Вывод данных

### JSON-экспорт (основной)

- Полный JSON-файл для каждого encounter, сохраняемый как JournalEntry с флагом модуля
- Экспорт в файл по кнопке (скачать .json)

### Human-Readable журнал (вторичный)

Опциональная генерация читаемого текста в JournalEntry.

### Сводка энкаунтера (Summary)

Автоматически рассчитывать после окончания боя.

#### Базовая статистика
```
{
  total_rounds: number,
  total_damage_dealt: { [actor_name]: number },
  total_damage_taken: { [actor_name]: number },
  total_healing: { [actor_name]: number },
  kills: [ { killer, target, round } ],
  spells_cast: { [actor_name]: string[] },
  movement_total_ft: { [actor_name]: number }
}
```

#### Dice Stats (броски d20)
```
{
  per_actor: {
    [actor_name]: {
      total_d20_rolls: number,
      natural_20s: number,
      natural_1s: number,
      critical_successes: number,
      critical_failures: number,
      successes: number,
      failures: number,
      average_d20: number,
      highest_roll: number,
      lowest_roll: number,
      hit_rate: number,
    }
  }
}
```

#### Награды / Fun Facts (автоматические)

Генерируются из статистики, показываются игрокам после боя.

---

## UI (минимальный)

- **Кнопка в Combat Tracker:** "Export Chronicle"
- **Настройки модуля:** автосохранение, human-readable журнал, папка журнала
- **Нет UI во время боя**

---

## Технические решения

### Хранение данных во время боя
- Хранить в `game.combatChronicle.currentEncounter` (в памяти)
- Сбрасывать в JournalEntry только при окончании боя или по кнопке

### PF2e-специфичные данные
- Степень успеха: `message.flags.pf2e.context.outcome`
- Тип действия: `message.flags.pf2e.context.type`
- MAP: `message.flags.pf2e.context.mapIncreases`
- Условия: `actor.items.filter(i => i.type === "condition")`
- Эффекты: `actor.items.filter(i => i.type === "effect")`
- HP: `actor.system.attributes.hp.value` / `.max` / `.temp`

### Edge cases
- Эйдолон + Призыватель: логировать обоих на один turn
- Реакции: привязывать к активному ходу с пометкой "reaction"
- Смерть / потеря сознания: специальная пометка при HP ≤ 0

---

## Приоритеты реализации

### MVP (Phase 1)
- [ ] Структура боя: начало/конец, инициатива, раунды/ходы
- [ ] HP-трекинг на каждый ход (start/end)
- [ ] Снапшоты эффектов на начало/конец хода
- [ ] Логирование бросков атак и урона из ChatMessage
- [ ] JSON-экспорт в JournalEntry

### Phase 2
- [ ] Action classification
- [ ] Effect event-лог
- [ ] Movement tracking
- [ ] Human-readable журнал

### Phase 3
- [ ] UI: кнопка экспорта в Combat Tracker
- [ ] Настройки модуля

### Phase 4 — Статистика, награды и ачивки
- [ ] Encounter summary
- [ ] Dice stats per actor
- [ ] Награды после боя
- [ ] Система ачивок
- [ ] Кампейн-лидерборд и рекорды

---

## Структура файлов модуля

```
pf2e-combat-chronicle/
├── module.json
├── scripts/
│   ├── module.js              # entry point, хук регистрация
│   ├── combat-tracker.js      # логика отслеживания раундов/ходов
│   ├── message-parser.js      # парсинг ChatMessage + PF2e flags
│   ├── health-tracker.js      # HP дельты
│   ├── movement-tracker.js    # позиции токенов
│   ├── effect-tracker.js      # эффекты + состояния
│   ├── journal-writer.js      # запись в JournalEntry
│   └── utils.js               # хелперы
├── lang/
│   └── en.json
└── styles/
    └── chronicle.css
```
