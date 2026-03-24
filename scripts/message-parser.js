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

    // Require either a roll or an origin to treat as an action
    const origin = pf2e.origin ?? {};
    if (!message.isRoll && !origin.type) return null;

    const actionType = this.#classifyAction(pf2e, contextType, origin);
    const actionName = this.#extractActionName(pf2e, origin, contextType);
    const targets = this.#extractTargets(pf2e);
    const roll = message.rolls?.[0] ?? null;

    return {
      action_name: actionName,
      action_cost: DEFAULT_ACTION_COST[actionType] ?? 0,
      action_type: actionType,
      item_name: origin.name ?? null,
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

    const isHealing = this.#isHealingRoll(pf2e);

    return {
      _type: 'damage-enrichment',
      damage_dealt: isHealing ? null : total,
      damage_type: this.#extractDamageType(roll),
      healing_done: isHealing ? total : null,
      targets,
      roll_result: total,
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

  #extractActionName(pf2e, origin, contextType) {
    if (origin.name) return origin.name;
    if (pf2e.casting?.name) return pf2e.casting.name;
    if (contextType) return contextType;
    return 'Unknown';
  }

  #extractTargets(pf2e) {
    const target = pf2e.target;
    if (!target) return null;

    // Single target object with actor or token name
    const name = target.name ?? target.actor?.name ?? target.token?.name ?? null;
    if (name) return [name];

    // Array of targets
    if (Array.isArray(target)) {
      const names = target
        .map(t => t.name ?? t.actor?.name ?? t.token?.name ?? null)
        .filter(Boolean);
      return names.length > 0 ? names : null;
    }

    return null;
  }

  #isHealingRoll(pf2e) {
    const traits = pf2e.origin?.item?.system?.traits?.value;
    if (Array.isArray(traits) && traits.includes('healing')) return true;

    // Also check for vitality trait (PF2e remaster term for positive healing)
    if (Array.isArray(traits) && traits.includes('vitality')) return true;

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
