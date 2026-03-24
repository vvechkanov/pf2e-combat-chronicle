/**
 * Formats encounter data into human-readable HTML for a JournalEntryPage.
 * Pure function — no Foundry API dependencies, operates only on the data object.
 *
 * Features:
 * - Collapsible rounds via <details>
 * - Action grouping: related actions (spell + attacks + damage) clustered visually
 * - Attack series: consecutive strikes/spells grouped as one activity
 * - Follow-up actions (damage-taken) shown only when they carry extra info
 */

const DEGREE_LABELS = {
  'critical-success': 'Critical Success',
  'success': 'Success',
  'failure': 'Failure',
  'critical-failure': 'Critical Failure',
};

const SAVE_TYPE_LABELS = {
  fortitude: 'Fortitude',
  reflex: 'Reflex',
  will: 'Will',
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Format encounter data as human-readable HTML.
 * @param {object} data — full encounter data object
 * @returns {string} HTML string
 */
export function formatEncounterHTML(data) {
  if (!data) return '';
  const parts = [];
  const combatStart = data.started_at ? new Date(data.started_at) : null;
  const actorNames = buildActorNameMap(data.initiative_order);

  parts.push(`<div class="combat-chronicle">`);
  parts.push(formatHeader(data, combatStart));
  parts.push(formatInitiativeTable(data.initiative_order));

  for (const round of data.rounds ?? []) {
    parts.push(formatRound(round, combatStart, actorNames));
  }

  parts.push(`</div>`);
  return parts.join('\n');
}

// ── Actor name map ──────────────────────────────────────────────────────────

function buildActorNameMap(initiativeOrder) {
  const map = new Map();
  if (!initiativeOrder) return map;
  for (const entry of initiativeOrder) {
    if (entry.actor_id && entry.name) {
      map.set(entry.actor_id, entry.name);
    }
  }
  return map;
}

// ── Header ──────────────────────────────────────────────────────────────────

function formatHeader(data, combatStart) {
  const scene = escapeHTML(data.scene_name ?? 'Unknown Scene');
  const rounds = data.rounds?.length ?? 0;

  let durationStr = '';
  if (combatStart && data.ended_at) {
    const combatEnd = new Date(data.ended_at);
    durationStr = ` ${formatElapsed(combatStart, combatEnd)}, ${rounds} round${rounds !== 1 ? 's' : ''}`;
  }

  return `<h2>${scene}</h2>\n<p class="cc-meta"><strong>Duration:</strong>${durationStr}</p>`;
}

// ── Initiative ──────────────────────────────────────────────────────────────

function formatInitiativeTable(order) {
  if (!order || order.length === 0) return '';

  const rows = order.map((entry, i) => {
    const name = escapeHTML(entry.name ?? 'Unknown');
    const init = entry.initiative_total ?? '—';
    return `  <tr><td>${i + 1}.</td><td>${name}</td><td>${init}</td></tr>`;
  });

  return `<div class="cc-initiative"><h3>Initiative</h3>\n<table>\n${rows.join('\n')}\n</table></div>`;
}

// ── Round ───────────────────────────────────────────────────────────────────

function formatRound(round, combatStart, actorNames) {
  const elapsed = formatElapsedTag(combatStart, round.started_at);
  const parts = [];

  parts.push(`<details class="cc-round" open>`);
  parts.push(`<summary>Round ${round.round_number} ${elapsed}</summary>`);
  parts.push(`<div class="cc-round-body">`);

  for (const turn of round.turns ?? []) {
    parts.push(formatTurn(turn, combatStart, actorNames));
  }

  parts.push(`</div>`);
  parts.push(`</details>`);

  return parts.join('\n');
}

// ── Turn ────────────────────────────────────────────────────────────────────

function formatTurn(turn, combatStart, actorNames) {
  const name = escapeHTML(turn.combatant_name ?? 'Unknown');
  const hpLabel = turn.hp_start !== null && turn.hp_max !== null
    ? `HP ${turn.hp_start}/${turn.hp_max}`
    : '';
  const elapsed = formatElapsedTag(combatStart, turn.started_at);

  const parts = [];
  parts.push(`<div class="cc-turn">`);

  // Turn header
  parts.push(`<div class="cc-turn-header">`);
  parts.push(`  <strong>${name}</strong>`);
  if (hpLabel) parts.push(`  <span class="cc-hp">${hpLabel}</span>`);
  if (elapsed) parts.push(`  <span class="cc-elapsed">${elapsed}</span>`);
  parts.push(`</div>`);

  // Active effects at turn start
  const activeEffects = formatActiveEffects(turn.effects_start);
  if (activeEffects) parts.push(activeEffects);

  // Group actions and render
  const groups = groupTurnActions(turn.actions ?? []);
  for (const group of groups) {
    parts.push(formatActionGroup(group, turn.hp_changes, actorNames));
  }

  // Effect changes as follow-up blocks (gained/lost/changed during this turn)
  const effectChanges = formatEffectChanges(turn);
  if (effectChanges) parts.push(effectChanges);

  // Turn footer: movement, HP delta
  const footer = formatTurnFooter(turn);
  if (footer) parts.push(footer);

  parts.push(`</div>`);
  return parts.join('\n');
}

// ── Action grouping ─────────────────────────────────────────────────────────

/**
 * Group turn actions into logical clusters.
 * Returns an array of { primary: Action[], followUps: Action[], type: string }.
 */
function groupTurnActions(actions) {
  const groups = [];
  let current = null;

  for (const action of actions) {
    // Skip move-type actions — shown in turn footer
    if (action.action_type === 'move') continue;

    if (isFollowUpAction(action)) {
      if (current) {
        current.followUps.push(action);
      }
      // If no current group, discard orphaned follow-ups
      continue;
    }

    // Check if this continues the current group (attack series, spell multi-attack)
    if (current && isSameActivityGroup(current, action)) {
      current.primary.push(action);
      continue;
    }

    // Start a new group
    current = { primary: [action], followUps: [], type: action.action_type };
    groups.push(current);
  }

  return groups;
}

/**
 * Actions that attach to the preceding group rather than starting a new one.
 */
function isFollowUpAction(action) {
  if (action.action_name === 'damage-taken') return true;
  if (action.notes === 'standalone damage roll') return true;
  // Only treat Unknown as follow-up when it's truly ancillary (no type, no cost)
  if (action.action_name === 'Unknown' && action.action_type === 'other' && !action.action_cost) return true;
  return false;
}

/**
 * Whether an action continues the current group (attack series / multi-spell).
 */
function isSameActivityGroup(group, action) {
  if (group.primary.length === 0) return false;
  const first = group.primary[0];

  // Consecutive spell actions (spell-cast → spell attacks)
  if (first.action_type === 'spell' && action.action_type === 'spell') return true;

  // Consecutive strike actions (flurry, multi-attack)
  if (first.action_type === 'strike' && action.action_type === 'strike') return true;

  return false;
}

// ── Action group rendering ──────────────────────────────────────────────────

function formatActionGroup(group, hpChanges, actorNames) {
  const typeClass = `cc-action-group--${group.type || 'other'}`;
  const parts = [];

  parts.push(`<div class="cc-action-group ${typeClass}">`);

  // Primary actions
  for (const action of group.primary) {
    parts.push(formatAction(action, hpChanges, actorNames));
  }

  // Follow-up actions (damage-taken) — only if they have useful extra info
  for (const followUp of group.followUps) {
    const followUpHTML = formatFollowUp(followUp, actorNames);
    if (followUpHTML) parts.push(followUpHTML);
  }

  parts.push(`</div>`);
  return parts.join('\n');
}

// ── Action formatting ───────────────────────────────────────────────────────

function formatAction(action, hpChanges, actorNames) {
  const fragments = [];

  // Action name / title
  let label;
  if (action.title) {
    label = escapeHTML(action.title);
  } else {
    label = escapeHTML(action.action_name ?? 'Unknown');
    if (action.item_name && action.item_name !== action.action_name) {
      label += ` (${escapeHTML(action.item_name)})`;
    }
  }
  fragments.push(`<span class="cc-action-name">${label}</span>`);

  // MAP penalty
  if (action.map_penalty) {
    fragments.push(`<span class="cc-action-map">MAP -${action.map_penalty * 5}</span>`);
  }

  // Targets
  if (action.targets?.length) {
    const targetNames = action.targets.map(t => escapeHTML(t.name ?? t.actor_id ?? '?')).join(', ');
    let targetStr = `<span class="cc-target">${targetNames}</span>`;
    if (action.dc && (action.dc.slug === 'armor' || action.dc.slug === 'ac')) {
      targetStr += ` (AC ${action.dc.value})`;
    }
    fragments.push(`→ ${targetStr}`);
  }

  // Roll result
  if (action.roll_result !== null && action.roll_result !== undefined) {
    let rollStr = `<span class="cc-roll">${action.roll_result}</span>`;
    if (action.save_type) {
      const dcStr = action.dc ? ` vs DC ${action.dc.value}` : '';
      rollStr += dcStr;
    }
    fragments.push(rollStr);
  }

  // Degree of success
  if (action.degree_of_success) {
    const degreeLabel = DEGREE_LABELS[action.degree_of_success] ?? action.degree_of_success;
    fragments.push(`<span class="cc-degree cc-degree--${action.degree_of_success}">${degreeLabel}</span>`);
  }

  // Detect healing misclassified as damage: damage_dealt is set but hp_change delta is positive
  const hpDelta = findActualHPDelta(action, hpChanges);
  const isMisclassifiedHealing = action.damage_dealt > 0 && action.healing_done === null && hpDelta !== null && hpDelta > 0;

  // Damage (or misclassified healing shown as healing)
  if (action.damage_dealt !== null && action.damage_dealt !== undefined) {
    if (isMisclassifiedHealing) {
      // Show as healing instead of damage — parser failed to detect healing trait
      const hpChange = findHPChange(action, hpChanges);
      let healStr = `healed ${action.damage_dealt} HP`;
      if (hpChange) {
        healStr += ` (HP ${hpChange.hp_before}→${hpChange.hp_after})`;
      }
      // Show target name from hp_changes if action has no targets
      if (!action.targets?.length && hpChange?.actor_name) {
        fragments.push(`→ <span class="cc-target">${escapeHTML(hpChange.actor_name)}</span>`);
      }
      fragments.push(`<span class="cc-healing">${healStr}</span>`);
    } else {
      const dmgType = action.damage_type ? ` ${escapeHTML(action.damage_type)}` : '';
      let dmgStr = `${action.damage_dealt}${dmgType}`;

      const hpChange = findHPChange(action, hpChanges);
      if (hpDelta !== null && Math.abs(hpDelta) !== action.damage_dealt) {
        const actual = Math.abs(hpDelta);
        const resisted = action.damage_dealt - actual;
        // Show resistance info combined with HP transition
        if (resisted > 0 && hpChange) {
          dmgStr += ` (${resisted} resisted, HP ${hpChange.hp_before}→${hpChange.hp_after})`;
        } else if (resisted > 0) {
          dmgStr += ` (${actual} HP lost, ${resisted} resisted)`;
        } else if (hpChange) {
          dmgStr += ` (HP ${hpChange.hp_before}→${hpChange.hp_after})`;
        } else {
          dmgStr += ` (${actual} HP lost)`;
        }
      } else if (hpChange) {
        // No resistance — just show HP transition
        dmgStr += ` (HP ${hpChange.hp_before}→${hpChange.hp_after})`;
      }

      fragments.push(`<span class="cc-damage">${dmgStr}</span>`);
    }
  }

  // Healing
  if (action.healing_done !== null && action.healing_done !== undefined) {
    let healStr = `healed ${action.healing_done} HP`;
    const hpChange = findHPChange(action, hpChanges);
    if (hpChange) {
      healStr += ` (HP ${hpChange.hp_before}→${hpChange.hp_after})`;
    }
    // Show target name from hp_changes if action has no targets
    if (!action.targets?.length && hpChange?.actor_name) {
      fragments.push(`→ <span class="cc-target">${escapeHTML(hpChange.actor_name)}</span>`);
    }
    fragments.push(`<span class="cc-healing">${healStr}</span>`);
  }

  // Persistent damage
  if (action.applied_damage?.persistent?.length) {
    const persistentParts = action.applied_damage.persistent.map(p => {
      const type = p.damageType ? escapeHTML(p.damageType) : '';
      const formula = p.formula ? escapeHTML(p.formula) : '';
      return `${formula} ${type}`.trim();
    }).filter(Boolean);
    if (persistentParts.length) {
      fragments.push(`<span class="cc-persistent">persistent: ${persistentParts.join(', ')}</span>`);
    }
  }

  // Reaction tag
  if (action.notes === 'reaction') {
    const reactorName = action.actor_id
      ? escapeHTML(actorNames.get(action.actor_id) ?? action.actor_id)
      : 'Reaction';
    fragments.push(`<span class="cc-reaction">${reactorName}</span>`);
  }

  const sep = ` <span class="cc-separator">—</span> `;
  return `<div class="cc-action">${fragments.join(sep)}</div>`;
}

// ── Follow-up (damage-taken) ────────────────────────────────────────────────

/**
 * Format a damage-taken follow-up. Returns HTML string or null if nothing useful to show.
 * Only renders when applied_damage contains extras: shield, persistent, or is_healing.
 */
function formatFollowUp(action, actorNames) {
  if (action.action_name !== 'damage-taken') return null;

  const applied = action.applied_damage;
  if (!applied) return null;

  const parts = [];

  // Shield block info
  if (applied.shield && applied.shield > 0) {
    parts.push(`shield blocked ${applied.shield}`);
  }

  // Persistent damage
  if (applied.persistent?.length) {
    const persistentParts = applied.persistent.map(p => {
      const type = p.damageType ? escapeHTML(p.damageType) : '';
      const formula = p.formula ? escapeHTML(p.formula) : '';
      return `${formula} ${type}`.trim();
    }).filter(Boolean);
    if (persistentParts.length) {
      parts.push(`persistent: ${persistentParts.join(', ')}`);
    }
  }

  // Is healing (unusual for damage-taken, but worth noting)
  if (applied.is_healing) {
    parts.push('healing applied');
  }

  // Nothing extra to show
  if (parts.length === 0) return null;

  return `<div class="cc-follow-up">${parts.join(' · ')}</div>`;
}

// ── HP delta matching ───────────────────────────────────────────────────────

/**
 * Find actual HP delta for a damage action by matching targets against hp_changes.
 */
function findActualHPDelta(action, hpChanges) {
  const hpChange = findHPChange(action, hpChanges);
  return hpChange?.delta ?? null;
}

/**
 * Find the HP change record matching an action's target.
 * If the action has explicit targets, match by name. Otherwise, if there's
 * only one hp_change entry, return it as a best-effort match.
 */
function findHPChange(action, hpChanges) {
  if (!hpChanges?.length) return null;
  if (action.damage_dealt === null && action.healing_done === null) return null;

  if (action.targets?.length) {
    for (const target of action.targets) {
      const targetName = target.name ?? null;
      if (!targetName) continue;
      const match = hpChanges.find(hc => hc.actor_name === targetName);
      if (match) return match;
    }
  }

  // No explicit targets — if there's exactly one hp_change, use it as best-effort
  if (!action.targets?.length && hpChanges.length === 1) {
    return hpChanges[0];
  }

  return null;
}

// ── Active effects at turn start ────────────────────────────────────────────

/**
 * Render active conditions/effects as tags below the turn header.
 */
function formatActiveEffects(effectsStart) {
  if (!effectsStart || effectsStart.length === 0) return null;

  const tags = effectsStart.map(eff => {
    let label = escapeHTML(eff.name);
    if (eff.value !== null && eff.value !== undefined) {
      label += ` ${eff.value}`;
    }
    const typeClass = eff.type === 'condition' ? 'cc-effect-tag--condition' : 'cc-effect-tag--effect';
    return `<span class="cc-effect-tag ${typeClass}">${label}</span>`;
  });

  return `<div class="cc-active-effects">${tags.join(' ')}</div>`;
}

// ── Effect changes (follow-up style) ────────────────────────────────────────

/**
 * Render gained/lost/changed effects as follow-up blocks (same style as damage-taken).
 */
function formatEffectChanges(turn) {
  const gained = turn.effects_gained ?? [];
  const lost = turn.effects_lost ?? [];
  const changed = turn.effects_changed ?? [];
  const effectEvents = turn.effect_events ?? [];
  const turnActorId = turn.actor_id;

  // Collect effect events on OTHER actors (aura effects, etc.)
  const otherActorEvents = effectEvents.filter(
    e => e.actor_id && e.actor_id !== turnActorId
  );

  if (gained.length === 0 && lost.length === 0 && changed.length === 0 && otherActorEvents.length === 0) return null;

  const parts = [];

  // Self-effects (gained/lost/changed)
  for (const name of gained) {
    parts.push(`<div class="cc-follow-up"><span class="cc-effect-gained">+${escapeHTML(name)}</span></div>`);
  }

  for (const name of lost) {
    parts.push(`<div class="cc-follow-up"><span class="cc-effect-lost">-${escapeHTML(name)}</span></div>`);
  }

  for (const change of changed) {
    parts.push(`<div class="cc-follow-up"><span class="cc-effect-changed">${escapeHTML(change.name)} ${change.from}→${change.to}</span></div>`);
  }

  // Effects on OTHER actors (auras, emanations, etc.)
  for (const event of otherActorEvents) {
    const actorLabel = escapeHTML(event.actor_name ?? event.actor_id);
    const effectLabel = escapeHTML(event.effect_name);
    if (event.event_type === 'applied') {
      parts.push(`<div class="cc-follow-up"><span class="cc-effect-gained">${actorLabel} +${effectLabel}</span></div>`);
    } else if (event.event_type === 'removed') {
      parts.push(`<div class="cc-follow-up"><span class="cc-effect-lost">${actorLabel} -${effectLabel}</span></div>`);
    } else if (event.event_type === 'changed') {
      const valStr = event.old_value !== null && event.new_value !== null
        ? ` ${event.old_value}→${event.new_value}`
        : '';
      parts.push(`<div class="cc-follow-up"><span class="cc-effect-changed">${actorLabel} ${effectLabel}${valStr}</span></div>`);
    }
  }

  return `<div class="cc-action-group cc-action-group--other">${parts.join('\n')}</div>`;
}

// ── Turn footer ─────────────────────────────────────────────────────────────

function formatTurnFooter(turn) {
  const parts = [];

  // Movement
  if (turn.total_distance_ft > 0) {
    const speedPart = turn.speed ? `/${turn.speed}ft` : 'ft';
    parts.push(`<span><strong>Move:</strong> ${turn.total_distance_ft}ft${speedPart}</span>`);
  }

  // HP change
  if (turn.hp_start !== null && turn.hp_end !== null && turn.hp_start !== turn.hp_end) {
    const delta = turn.hp_end - turn.hp_start;
    const sign = delta > 0 ? '+' : '';
    const deltaClass = delta < 0 ? 'cc-hp-delta-negative' : 'cc-hp-delta-positive';
    parts.push(`<span class="cc-hp-change"><strong>HP:</strong> ${turn.hp_start} → ${turn.hp_end} (<span class="${deltaClass}">${sign}${delta}</span>)</span>`);
  }

  if (parts.length === 0) return null;
  return `<div class="cc-turn-footer">${parts.join('')}</div>`;
}

// ── Time helpers ────────────────────────────────────────────────────────────

function formatElapsed(start, end) {
  const diffMs = end - start;
  if (diffMs < 0) return '0:00';

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatElapsedTag(combatStart, isoTimestamp) {
  if (!combatStart || !isoTimestamp) return '';
  const ts = new Date(isoTimestamp);
  return `<span class="cc-elapsed">[+${formatElapsed(combatStart, ts)}]</span>`;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function escapeHTML(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
