const MODULE_ID = 'pf2e-combat-chronicle';

const TRACKED_ITEM_TYPES = new Set(['condition', 'effect', 'buff']);

export class EffectTracker {
  /** @type {Map<string, Array>} */
  #baselines = new Map();

  /** @type {Array<object>} Pending effect events for the current turn */
  #pendingEvents = [];

  /** @type {Map<string, number|null>} Pre-update values captured before updateItem */
  #preUpdateValues = new Map();

  /**
   * Take a snapshot of an actor's current effects and conditions.
   * @param {Actor} actor
   * @returns {Array<{name: string, type: string, slug: string|null, value: number|null, remaining_rounds: number|null, remaining_text: string|null, source: string|null}>}
   */
  snapshotEffects(actor) {
    if (!actor?.items) return [];
    return actor.items
      .filter(i => TRACKED_ITEM_TYPES.has(i.type))
      .map(i => ({
        name: i.name,
        type: i.type,
        slug: i.system?.slug ?? null,
        value: i.system?.value?.value ?? null,
        remaining_rounds: i.system?.duration?.value ?? null,
        remaining_text: this.#formatDuration(i),
        source: i.system?.context?.origin?.actor ?? null,
      }));
  }

  /**
   * Store the actor's current effects as the baseline for diff computation.
   * Called at turn start.
   * @param {Actor} actor
   */
  initBaseline(actor) {
    if (!actor) return;
    this.#baselines.set(actor.id, this.snapshotEffects(actor));
  }

  /**
   * Compare baseline (start) against end snapshot and return the diff.
   * @param {string} actorId
   * @param {Array} endSnapshot
   * @returns {{effects_gained: string[], effects_lost: string[], effects_changed: Array<{name: string, from: number, to: number}>}}
   */
  computeDiff(actorId, endSnapshot) {
    const startSnapshot = this.#baselines.get(actorId) ?? [];
    const startCounts = this.#buildCountMap(startSnapshot);
    const endCounts = this.#buildCountMap(endSnapshot);

    const effects_gained = [];
    const effects_lost = [];
    const effects_changed = [];

    // Find gained and changed
    for (const [key, endEntries] of endCounts) {
      const startEntries = startCounts.get(key) ?? [];
      if (startEntries.length === 0) {
        // All entries are gained
        for (const e of endEntries) effects_gained.push(e.name);
      } else {
        // Check for value changes between matched pairs
        const minLen = Math.min(startEntries.length, endEntries.length);
        for (let idx = 0; idx < minLen; idx++) {
          const s = startEntries[idx];
          const e = endEntries[idx];
          if (s.value !== null && e.value !== null && s.value !== e.value) {
            effects_changed.push({ name: e.name, from: s.value, to: e.value });
          }
        }
        // Extra entries in end are gained
        for (let idx = minLen; idx < endEntries.length; idx++) {
          effects_gained.push(endEntries[idx].name);
        }
      }
    }

    // Find lost
    for (const [key, startEntries] of startCounts) {
      const endEntries = endCounts.get(key) ?? [];
      if (endEntries.length === 0) {
        for (const e of startEntries) effects_lost.push(e.name);
      } else if (startEntries.length > endEntries.length) {
        // Extra entries in start are lost
        for (let idx = endEntries.length; idx < startEntries.length; idx++) {
          effects_lost.push(startEntries[idx].name);
        }
      }
    }

    return { effects_gained, effects_lost, effects_changed };
  }

  /**
   * Handle an effect/condition being created on an actor.
   * @param {Item} item — the created item
   * @param {object} options
   * @param {string} userId
   */
  onEffectCreated(item, options, userId) {
    if (!TRACKED_ITEM_TYPES.has(item.type)) return null;
    const event = {
      event_type: 'applied',
      effect_name: item.name,
      effect_type: item.type,
      slug: item.system?.slug ?? null,
      value: item.system?.value?.value ?? null,
      old_value: null,
      new_value: item.system?.value?.value ?? null,
      actor_id: item.actor?.id ?? null,
      actor_name: item.actor?.name ?? null,
      timestamp: new Date().toISOString(),
      round: game.combat?.round ?? null,
      turn: game.combat?.turn ?? null,
    };
    this.#pendingEvents.push(event);
    console.log(`${MODULE_ID} | Effect applied: ${event.effect_name} on ${event.actor_name}`);
    return event;
  }

  /**
   * Handle an effect/condition being removed from an actor.
   * @param {Item} item — the deleted item
   * @param {object} options
   * @param {string} userId
   */
  onEffectDeleted(item, options, userId) {
    if (!TRACKED_ITEM_TYPES.has(item.type)) return null;
    const event = {
      event_type: 'removed',
      effect_name: item.name,
      effect_type: item.type,
      slug: item.system?.slug ?? null,
      value: item.system?.value?.value ?? null,
      old_value: item.system?.value?.value ?? null,
      new_value: null,
      actor_id: item.actor?.id ?? null,
      actor_name: item.actor?.name ?? null,
      timestamp: new Date().toISOString(),
      round: game.combat?.round ?? null,
      turn: game.combat?.turn ?? null,
    };
    this.#pendingEvents.push(event);
    console.log(`${MODULE_ID} | Effect removed: ${event.effect_name} from ${event.actor_name}`);
    return event;
  }

  /**
   * Capture old value before an effect/condition update is applied.
   * Call from preUpdateItem hook.
   * @param {Item} item — the item before the update
   * @param {object} changes — the change delta
   */
  capturePreUpdateValue(item, changes) {
    if (!TRACKED_ITEM_TYPES.has(item.type)) return;
    if (!foundry.utils.hasProperty(changes, 'system.value.value') &&
        !foundry.utils.hasProperty(changes, 'system.duration')) return;
    this.#preUpdateValues.set(item.id, item.system?.value?.value ?? null);
  }

  /**
   * Handle an effect/condition being updated on an actor.
   * Call from updateItem hook (post-update).
   * @param {Item} item — the updated item (post-update state)
   * @param {object} changes — the change delta
   * @param {object} options
   * @param {string} userId
   */
  onEffectUpdated(item, changes, options, userId) {
    if (!TRACKED_ITEM_TYPES.has(item.type)) return null;

    const valueChanged = foundry.utils.hasProperty(changes, 'system.value.value');
    const durationChanged = foundry.utils.hasProperty(changes, 'system.duration');
    if (!valueChanged && !durationChanged) return null;

    const oldValue = this.#preUpdateValues.get(item.id) ?? null;
    this.#preUpdateValues.delete(item.id);

    const newValue = item.system?.value?.value ?? null;

    // Skip if value didn't actually change and no duration change
    if (valueChanged && oldValue === newValue && !durationChanged) return null;

    const event = {
      event_type: 'changed',
      effect_name: item.name,
      effect_type: item.type,
      slug: item.system?.slug ?? null,
      value: newValue,
      old_value: valueChanged ? oldValue : null,
      new_value: valueChanged ? newValue : null,
      actor_id: item.actor?.id ?? null,
      actor_name: item.actor?.name ?? null,
      timestamp: new Date().toISOString(),
      round: game.combat?.round ?? null,
      turn: game.combat?.turn ?? null,
    };

    this.#pendingEvents.push(event);
    console.log(`${MODULE_ID} | Effect changed: ${event.effect_name} on ${event.actor_name} (${event.old_value} → ${event.new_value})`);
    return event;
  }

  /**
   * Drain accumulated effect events (returns and clears the pending list).
   * @returns {Array<object>}
   */
  drainEvents() {
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    return events;
  }

  /**
   * Serialize internal state for persistence.
   * @returns {{baselines: Array, pendingEvents: Array, preUpdateValues: Array}}
   */
  serialize() {
    return {
      baselines: Array.from(this.#baselines.entries()),
      pendingEvents: this.#pendingEvents,
      preUpdateValues: Array.from(this.#preUpdateValues.entries()),
    };
  }

  /**
   * Restore internal state from serialized data.
   * @param {object} data — output of serialize()
   */
  restoreState(data) {
    if (!data) return;
    this.#baselines = new Map(data.baselines ?? []);
    this.#pendingEvents = data.pendingEvents ?? [];
    this.#preUpdateValues = new Map(data.preUpdateValues ?? []);
  }

  /**
   * Clear all tracked state (call when combat ends).
   */
  reset() {
    this.#baselines.clear();
    this.#pendingEvents = [];
    this.#preUpdateValues.clear();
  }

  /**
   * Build a frequency map keyed by composite key (type|slug or type|name).
   * Each key maps to an array of snapshot entries (sorted by value for stable pairing).
   * @param {Array} snapshot
   * @returns {Map<string, Array>}
   */
  #buildCountMap(snapshot) {
    const map = new Map();
    for (const entry of snapshot) {
      const key = `${entry.type}|${entry.slug ?? entry.name}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
    // Sort each group by value for stable matching
    for (const entries of map.values()) {
      entries.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
    }
    return map;
  }

  /**
   * Format an item's duration into a human-readable string.
   * @param {Item} item
   * @returns {string|null}
   */
  #formatDuration(item) {
    const duration = item.system?.duration;
    if (!duration?.value || !duration?.unit) return null;
    const val = duration.value;
    const unit = duration.unit;
    if (unit === 'unlimited') return 'unlimited';
    return `${val} ${unit}`;
  }
}
