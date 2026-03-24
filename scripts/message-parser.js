const MODULE_ID = 'pf2e-combat-chronicle';

const MOVE_ACTIONS = new Set([
  'stride', 'step', 'fly', 'swim', 'climb', 'burrow',
  'tumble-through', 'leap', 'high-jump', 'long-jump',
]);

const INTERACT_ACTIONS = new Set([
  'interact', 'draw-weapon', 'pick-up-item', 'drop-item',
  'release', 'retrieve', 'open', 'close',
]);

const SKIP_CONTEXT_TYPES = new Set(['initiative']);

const DEFAULT_ACTION_COST = {
  strike: 1,
  spell: 2,
  skill: 1,
  move: 1,
  interact: 1,
  other: 0,
};

export class MessageParser {
  /**
   * Parse a PF2e ChatMessage into an action object, damage enrichment, or null.
   * @param {ChatMessage} message
   * @returns {object|null}
   */
  parse(message) {
    const pf2e = message.flags?.pf2e;
    if (!pf2e) return null;

    const speakerActorId = message.speaker?.actor;
    if (!speakerActorId) return null;

    const context = pf2e.context ?? {};
    const contextType = context.type ?? null;

    if (contextType && SKIP_CONTEXT_TYPES.has(contextType)) return null;

    // Damage rolls produce enrichments, not standalone actions
    if (contextType === 'damage-roll') {
      return this.#parseDamageRoll(message, pf2e);
    }

    // damage-taken messages: extract appliedDamage info
    if (contextType === 'damage-taken') {
      return this.#parseDamageTaken(message, pf2e);
    }

    // Require either a roll or an origin to treat as an action
    const origin = pf2e.origin ?? {};
    if (!message.isRoll && !origin.type) return null;

    const actionType = this.#classifyAction(pf2e, contextType, origin);
    const actionName = this.#extractActionName(pf2e, origin, contextType, message.content);
    const targets = this.#extractTargets(pf2e);
    const roll = message.rolls?.[0] ?? null;

    const rawTitle = context.title ?? null;
    const cleanTitle = rawTitle ? this.#stripHTML(rawTitle).trim() : null;
    const itemName = this.#extractItemName(pf2e, origin, cleanTitle, message.content);

    return {
      action_name: actionName,
      action_cost: DEFAULT_ACTION_COST[actionType] ?? 0,
      action_type: actionType,
      item_name: itemName,
      item_type: origin.type ?? null,
      targets,
      roll_result: roll?.total ?? null,
      roll_formula: roll?.formula ?? null,
      degree_of_success: this.#normalizeOutcome(context.outcome),
      damage_dealt: null,
      damage_type: null,
      healing_done: null,
      map_penalty: context.mapIncreases ?? null,
      notes: null,
      title: cleanTitle,
      dc: context.dc ? { value: context.dc.value, slug: context.dc.slug ?? null } : null,
      save_type: contextType === 'saving-throw' ? (pf2e.modifierName ?? null) : null,
      item_img: origin.img ?? origin.item?.img ?? null,
      item_description: this.#extractDescription(origin),
    };
  }

  /**
   * Reset parser state. No-op for stateless parser; included for API consistency.
   */
  reset() {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #parseDamageRoll(message, pf2e) {
    const roll = message.rolls?.[0] ?? null;
    const total = roll?.total ?? 0;
    const targets = this.#extractTargets(pf2e);

    const isHealing = this.#isHealingRoll(pf2e, roll);

    return {
      _type: 'damage-enrichment',
      damage_dealt: isHealing ? null : total,
      damage_type: this.#extractDamageType(roll),
      healing_done: isHealing ? total : null,
      targets,
      roll_result: total,
      strike_name: pf2e.strike?.name ?? null,
    };
  }

  #parseDamageTaken(message, pf2e) {
    const applied = pf2e.appliedDamage;
    if (!applied) return null;

    return {
      action_name: 'damage-taken',
      action_cost: 0,
      action_type: 'other',
      item_name: null,
      item_type: null,
      targets: null,
      roll_result: null,
      roll_formula: null,
      degree_of_success: null,
      damage_dealt: null,
      damage_type: null,
      healing_done: null,
      map_penalty: null,
      notes: null,
      title: null,
      dc: null,
      save_type: null,
      // damage-taken specific fields
      applied_damage: {
        target_uuid: applied.uuid ?? null,
        is_healing: applied.isHealing ?? false,
        shield: applied.shield ?? null,
        persistent: applied.persistent ?? [],
        final_hp: applied.updates?.find(u => u.path === 'system.attributes.hp.value')?.value ?? null,
      },
    };
  }

  #classifyAction(pf2e, contextType, origin) {
    const originType = origin.type ?? null;

    // Spell attack rolls
    if (contextType === 'spell-attack-roll') return 'spell';

    // Regular attack rolls — spell origins are spells, everything else is a strike
    if (contextType === 'attack-roll') {
      return originType === 'spell' ? 'spell' : 'strike';
    }

    // Spell casting (non-attack spells like buffs/heals)
    if (originType === 'spell' || pf2e.casting) return 'spell';

    // Skill checks
    if (contextType === 'skill-check') return 'skill';

    // Move and interact — check origin slug or slugified name
    const slug = origin.slug ?? this.#slugify(origin.name);
    if (slug && MOVE_ACTIONS.has(slug)) return 'move';
    if (slug && INTERACT_ACTIONS.has(slug)) return 'interact';

    return 'other';
  }

  #extractActionName(pf2e, origin, contextType, messageContent) {
    if (origin.name) return origin.name;
    if (pf2e.casting?.name) return pf2e.casting.name;

    // Embedded spell (scrolls/wands) has full item data including name
    if (pf2e.casting?.embeddedSpell?.name) return pf2e.casting.embeddedSpell.name;

    // Resolve item name from world via UUID (sync Foundry API)
    if (origin.uuid && typeof globalThis.fromUuidSync === 'function') {
      try {
        const item = globalThis.fromUuidSync(origin.uuid);
        if (item?.name) return item.name;
      } catch { /* item may not exist or be inaccessible */ }
    }

    // Parse spell name from message HTML content (spell card uses <h3>SpellName</h3>)
    if (messageContent) {
      const h3Match = messageContent.match(/<h3[^>]*>([^<]+)/);
      if (h3Match?.[1]?.trim()) return h3Match[1].trim();
    }

    if (contextType) return contextType;
    return 'Unknown';
  }

  /**
   * Extract item name from multiple sources.
   */
  #extractItemName(pf2e, origin, cleanTitle, messageContent) {
    if (origin.name) return origin.name;
    if (pf2e.casting?.name) return pf2e.casting.name;
    if (pf2e.strike?.name) return pf2e.strike.name;
    // Extract from origin item data if available
    if (origin.item?.name) return origin.item.name;
    // Embedded spell name (scrolls/wands)
    if (pf2e.casting?.embeddedSpell?.name) return pf2e.casting.embeddedSpell.name;
    // Resolve from world UUID
    if (origin.uuid && typeof globalThis.fromUuidSync === 'function') {
      try {
        const item = globalThis.fromUuidSync(origin.uuid);
        if (item?.name) return item.name;
      } catch { /* item may not exist */ }
    }
    // Parse from spell card HTML
    if (messageContent) {
      const h3Match = messageContent.match(/<h3[^>]*>([^<]+)/);
      if (h3Match?.[1]?.trim()) return h3Match[1].trim();
    }
    return null;
  }

  /**
   * Strip HTML tags from a string, returning plain text.
   */
  #stripHTML(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  }

  /**
   * Extract item description from origin data.
   */
  #extractDescription(origin) {
    const desc = origin.item?.system?.description?.value ?? null;
    if (!desc) return null;
    // Strip HTML tags to store as plain text
    return this.#stripHTML(desc).trim() || null;
  }

  #extractTargets(pf2e) {
    // Check context.target first (where PF2e v7.11+ puts target info)
    const target = pf2e.context?.target ?? pf2e.target;
    if (!target) return null;

    // Single target object with actor UUID
    if (target.actor) {
      const actorId = this.#extractActorIdFromUUID(target.actor);
      return actorId ? [{ actor_id: actorId }] : null;
    }

    // Array of targets
    if (Array.isArray(target)) {
      const results = target
        .map(t => {
          const id = this.#extractActorIdFromUUID(t.actor);
          return id ? { actor_id: id } : null;
        })
        .filter(Boolean);
      return results.length > 0 ? results : null;
    }

    return null;
  }

  #extractActorIdFromUUID(uuid) {
    if (!uuid) return null;
    // "Actor.U7bM8NEzGa8ZDZrd" → "U7bM8NEzGa8ZDZrd"
    // "Scene.xxx.Token.xxx.Actor.HnVo1YGcyvJ2l5Sq" → "HnVo1YGcyvJ2l5Sq"
    const match = uuid.match(/Actor\.([^.]+)$/);
    return match?.[1] ?? null;
  }

  #isHealingRoll(pf2e, roll) {
    // Primary: DamageRoll.kinds Set contains 'healing' (most reliable)
    if (roll?.kinds?.has?.('healing')) return true;

    // Fallback: context.traits includes healing/vitality trait slugs
    const contextTraits = pf2e.context?.traits;
    if (Array.isArray(contextTraits)) {
      if (contextTraits.includes('healing') || contextTraits.includes('vitality')) return true;
    }

    // Fallback: roll options contain item:trait:healing
    const options = pf2e.context?.options;
    if (Array.isArray(options)) {
      if (options.includes('item:trait:healing') || options.includes('item:trait:vitality')) return true;
    }

    return false;
  }

  #extractDamageType(roll) {
    // PF2e damage rolls may contain damage type info in the roll's options or terms
    if (!roll) return null;

    // Check roll options for damage type
    const options = roll.options ?? {};
    if (options.damageType) return options.damageType;

    // Check first damage term for type flavor
    const term = roll.terms?.[0];
    if (term?.flavor) return term.flavor;

    return null;
  }

  #normalizeOutcome(outcome) {
    if (!outcome) return null;
    const map = {
      criticalSuccess: 'critical-success',
      success: 'success',
      failure: 'failure',
      criticalFailure: 'critical-failure',
    };
    return map[outcome] ?? outcome;
  }

  #slugify(name) {
    if (!name) return null;
    return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
}
