const MODULE_ID = 'pf2e-combat-chronicle';

export class RawCollector {
  /** @type {Array<object>} */
  #entries = [];

  /**
   * Check if raw data collection is enabled.
   * @returns {boolean}
   */
  isEnabled() {
    try {
      return game.settings.get(MODULE_ID, 'rawDataCollection') === true;
    } catch {
      return false;
    }
  }

  /**
   * Collect a raw hook event.
   * @param {string} hookName
   * @param {object} rawData — pre-serialized plain object
   */
  collect(hookName, rawData) {
    if (!this.isEnabled()) return;
    this.#entries.push({
      timestamp: new Date().toISOString(),
      hook: hookName,
      data: rawData,
    });
  }

  /**
   * Drain and return all collected entries.
   * @returns {Array<object>}
   */
  drain() {
    const entries = this.#entries;
    this.#entries = [];
    return entries;
  }

  /**
   * Serialize for persistence.
   * @returns {{entries: Array}}
   */
  serialize() {
    return { entries: [...this.#entries] };
  }

  /**
   * Restore from serialized state.
   * @param {object} data
   */
  restoreState(data) {
    if (!data) return;
    this.#entries = data.entries ?? [];
  }

  /**
   * Clear all state.
   */
  reset() {
    this.#entries = [];
  }

  // ── Static serializers ─────────────────────────────────────

  /**
   * Serialize a ChatMessage for raw collection.
   * Captures full flags, speaker, content, and rolls without circular refs.
   * @param {ChatMessage} message
   * @returns {object}
   */
  static serializeChatMessage(message) {
    return {
      id: message.id,
      flags: message.flags ?? {},
      speaker: message.speaker ?? {},
      content: message.content ?? '',
      rolls: message.rolls?.map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r)) ?? [],
      isRoll: message.isRoll ?? false,
      type: message.type ?? null,
    };
  }

  /**
   * Serialize an Item (effect/condition/buff) for raw collection.
   * @param {Item} item
   * @returns {object}
   */
  static serializeItem(item) {
    return {
      item_id: item.id,
      item_name: item.name,
      item_type: item.type,
      item_system: item.system ?? {},
      actor_id: item.actor?.id ?? null,
      actor_name: item.actor?.name ?? null,
    };
  }

  /**
   * Serialize a token update for raw collection.
   * @param {TokenDocument} token
   * @param {object} changes
   * @returns {object}
   */
  static serializeTokenUpdate(token, changes) {
    return {
      token_id: token.id,
      token_name: token.name,
      changes,
    };
  }
}
