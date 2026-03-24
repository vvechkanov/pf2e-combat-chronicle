const MODULE_ID = 'pf2e-combat-chronicle';

export class EffectTracker {
  /** @type {Map<string, Array>} */
  #baselines = new Map();

  /**
   * Take a snapshot of an actor's current effects and conditions.
   * @param {Actor} actor
   * @returns {Array<{name: string, type: string, slug: string|null, value: number|null, remaining_rounds: number|null, remaining_text: string|null, source: string|null}>}
   */
  snapshotEffects(actor) {
    if (!actor?.items) return [];
    return actor.items
      .filter(i => i.type === 'condition' || i.type === 'effect')
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
   * Clear all tracked state (call when combat ends).
   */
  reset() {
    this.#baselines.clear();
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
