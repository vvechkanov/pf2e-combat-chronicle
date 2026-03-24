# PF2e Combat Chronicle — Parsing Review

Review of all parsing code against the official PF2e system source code (`foundryvtt/pf2e` on GitHub).

**Module version**: 0.4.0
**PF2e system compatibility**: 7.11+
**Foundry VTT compatibility**: v13+
**Review date**: 2026-03-24

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| HIGH     | 1     | save_type always null — wrong data path |
| MEDIUM   | 4     | Incorrect data paths, wrong type assumptions |
| LOW      | 9     | Dead code, missing context types, minor inaccuracies |

---

## HIGH Severity Issues

### 1. `save_type` always returns `null` (message-parser.js:82)

**Code:**
```javascript
save_type: contextType === 'saving-throw' ? (pf2e.modifierName ?? null) : null,
```

**Problem:** `pf2e.modifierName` does not exist in PF2e chat message flags. The save type (fortitude/reflex/will) is stored in:
- `pf2e.context.statistic` — the statistic slug
- Or within `pf2e.context.options` array as `check:statistic:fortitude`, etc.

**Fix:**
```javascript
save_type: contextType === 'saving-throw'
  ? (context.statistic ?? context.slug ?? null)
  : null,
```

---

## MEDIUM Severity Issues

### 2. `extractDamageType` uses non-existent paths (message-parser.js:294-307)

**Code:**
```javascript
const options = roll.options ?? {};
if (options.damageType) return options.damageType;
const term = roll.terms?.[0];
if (term?.flavor) return term.flavor;
```

**Problem:** `roll.options.damageType` does not exist on PF2e DamageRoll. The correct path is:
- `roll.instances?.[0]?.type` — the primary damage type from DamageInstance
- `flags.pf2e.damageRoll.types` — full breakdown by damage type

**Fix:**
```javascript
#extractDamageType(roll) {
    if (!roll) return null;
    // Primary: DamageInstance type (PF2e DamageRoll structure)
    if (roll.instances?.[0]?.type) return roll.instances[0].type;
    // Fallback: first term flavor
    const term = roll.terms?.[0];
    if (term?.flavor) return term.flavor;
    return null;
}
```

### 3. Healing fallback checks wrong location for traits (message-parser.js:279-282)

**Code:**
```javascript
const contextTraits = pf2e.context?.traits;
if (Array.isArray(contextTraits)) {
    if (contextTraits.includes('healing') || contextTraits.includes('vitality')) return true;
}
```

**Problem:** `DamageDamageContextFlag` does not have a `traits` field. Damage traits are in `flags.pf2e.damageRoll.traits` (the `DamageRollFlag`).

**Fix:**
```javascript
const damageRollTraits = pf2e.damageRoll?.traits;
if (Array.isArray(damageRollTraits)) {
    if (damageRollTraits.includes('healing') || damageRollTraits.includes('vitality')) return true;
}
```

### 4. `appliedDamage.persistent` and `shield` wrong types (message-parser.js:138-143)

**Code (parser):**
```javascript
persistent: applied.persistent ?? [],  // stored as-is
shield: applied.shield ?? null,        // stored as-is
```

**Code (formatter, journal-formatter.js:348-351):**
```javascript
const type = p.damageType ? escapeHTML(p.damageType) : '';
const formula = p.formula ? escapeHTML(p.formula) : '';
```

**Code (formatter, journal-formatter.js:385):**
```javascript
if (applied.shield && applied.shield > 0)
```

**Problem:**
- `persistent` in PF2e is `string[]` (e.g., `["1d6 fire"]`), NOT `object[]` with `.damageType`/`.formula`
- `shield` in PF2e is `{ id: string; damage: number } | null`, NOT a number

**Fix for formatter:**
```javascript
// persistent: just display the strings
const persistentParts = applied.persistent.filter(Boolean);

// shield: access .damage property
if (applied.shield?.damage > 0) {
    parts.push(`shield blocked ${applied.shield.damage}`);
}
```

### 5. `hit_rate_percent` counts all rolls, not just attacks (summary-generator.js:263-274)

**Code:**
```javascript
function computeHitRate(actorActions) {
    for (const action of actorActions) {
        if (!action.degree_of_success) continue;
        total++;
        // ...
    }
}
```

**Problem:** Includes skill checks, saving throws, and other non-attack rolls. Hit rate should only count attack actions.

**Fix:**
```javascript
function computeHitRate(actorActions) {
    for (const action of actorActions) {
        if (!action.degree_of_success) continue;
        if (action.action_type !== 'strike' && action.action_type !== 'spell') continue;
        total++;
        // ...
    }
}
```

---

## LOW Severity Issues

### 6. `spell-attack-roll` is dead code (message-parser.js:152)

`CheckType` in PF2e does not include `spell-attack-roll`. Spell attacks use `attack-roll` with `origin.type === 'spell'`. The line `if (contextType === 'spell-attack-roll') return 'spell';` never matches. Not a bug (the fallback at line 155-157 handles this correctly), but dead code.

### 7. Missing context types (message-parser.js)

The following PF2e context types are not handled:
- `check` — generic checks
- `counteract-check` — counteract checks (Dispel Magic, etc.)
- `flat-check` — flat checks (concealment, persistent damage recovery)
- `perception-check` — Seek, Sense Motive, etc.
- `spell-cast` — non-attack spell casting messages
- `self-effect` — self-buff effects (Raise Shield, etc.)

These fall through to the `'other'` classification, which is acceptable but loses specificity.

### 8. `mapIncreases` only in damage context (message-parser.js:78)

`mapIncreases` is defined in `DamageDamageContextFlag`, not in check context. For attack rolls, MAP info is in `context.options` as `map:increases:1`, etc.

### 9. `flags.pf2e.damageRoll` ignored (message-parser.js)

PF2e provides `flags.pf2e.damageRoll` with detailed damage breakdown:
```typescript
interface DamageRollFlag {
    outcome: DegreeOfSuccessString;
    total: number;
    traits: string[];
    types: Record<string, Record<string, number>>;
}
```
This is the most reliable source for damage types, traits, and per-type breakdown. Currently unused.

### 10. Array targets dead code (message-parser.js:254)

`Array.isArray(target)` check — PF2e `context.target` is always a single `ActorTokenFlag` object or null, never an array. Dead code.

### 11. Effect tracker misses `buff` type (effect-tracker.js)

PF2e also uses `type === 'buff'` for some NPC effects. Not tracked.

### 12. `negativeHealing` not considered (health-tracker.js)

Undead with `negativeHealing: true` receive healing from void damage and damage from vitality. Not accounted for in healing detection.

### 13. `enrichLastAction` imprecise matching (combat-tracker.js:475-485)

Backward search for action without damage doesn't verify `strike_name` from the enrichment. If a reaction damage roll arrives, it may be attributed to the wrong action.

### 14. XP not adjusted for party size (summary-generator.js)

PF2e XP budget is designed for 4 PCs. For groups of different sizes, the encounter budget should be adjusted (+20 XP per additional PC, -20 per missing). The module simply divides total XP by PC count.

---

## Correct Implementations

The following are verified as correct against PF2e source:

- **HP paths**: `actor.system.attributes.hp.{value, max, temp}` ✓
- **Actor level**: `actor.system.details.level.value` ✓
- **Speed**: `actor.system.attributes.speed.total` ✓
- **Outcome normalization**: `criticalSuccess → critical-success`, etc. ✓
- **XP table values**: All 9 entries match official PF2e rules ✓
- **Effect snapshot paths**: `system.slug`, `system.value.value`, `system.duration` ✓
- **Grid distance calculation**: `scene.grid.size`, `scene.grid.distance` ✓ (Foundry v13)
- **Actor UUID regex**: `/Actor\.([^.]+)$/` correctly extracts ID from UUIDs ✓
- **`roll.kinds.has('healing')`**: Primary healing detection is correct ✓
- **Foundry v13 hooks**: `combatTurnChange`, `combatStart`, etc. all correct ✓
- **Token position in v13**: `changes._source` handling correct ✓
- **`hasPlayerOwner` for PC detection**: Correct PF2e approach ✓
- **`foundry.utils.hasProperty`** for deep path checking: Correct ✓

---

## PF2e Damage Types Reference (for validation)

| Category | Types |
|----------|-------|
| Physical | `bludgeoning`, `piercing`, `slashing`, `bleed` |
| Energy   | `acid`, `cold`, `electricity`, `fire`, `sonic`, `force`, `vitality`, `void` |
| Other    | `mental`, `poison`, `spirit`, `untyped` |

## PF2e Context Types Reference

| Type | Source | Description |
|------|--------|-------------|
| `attack-roll` | CheckType | Weapon and spell attacks |
| `check` | CheckType | Generic checks |
| `counteract-check` | CheckType | Counteract attempts |
| `flat-check` | CheckType | Flat checks |
| `initiative` | CheckType | Initiative rolls |
| `perception-check` | CheckType | Perception checks |
| `saving-throw` | CheckType | Saving throws |
| `skill-check` | CheckType | Skill checks |
| `damage-roll` | DamageDamageContext | Damage rolls |
| `damage-taken` | DamageTakenContext | Applied damage |
| `spell-cast` | SpellCastContext | Spell casting |
| `self-effect` | SelfEffectContext | Self-buff effects |
