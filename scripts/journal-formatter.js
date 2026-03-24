/**
 * Formats encounter data into human-readable HTML for a JournalEntryPage.
 * Pure function — no Foundry API dependencies, operates only on the data object.
 */

const DEGREE_LABELS = {
  'critical-success': 'Critical Success',
  'success': 'Success',
  'failure': 'Failure',
  'critical-failure': 'Critical Failure',
};

/**
 * Format encounter data as human-readable HTML.
 * @param {object} data — full encounter data object
 * @returns {string} HTML string
 */
export function formatEncounterHTML(data) {
  if (!data) return '';
  const parts = [];
  const combatStart = data.started_at ? new Date(data.started_at) : null;

  parts.push(formatHeader(data, combatStart));
  parts.push(formatInitiativeTable(data.initiative_order));

  for (const round of data.rounds ?? []) {
    parts.push(formatRound(round, combatStart));
  }

  return parts.join('\n');
}

// ── Header ───────────────────────────────────────────────────────────────────

function formatHeader(data, combatStart) {
  const scene = escapeHTML(data.scene_name ?? 'Unknown Scene');
  const rounds = data.rounds?.length ?? 0;

  let durationStr = '';
  if (combatStart && data.ended_at) {
    const combatEnd = new Date(data.ended_at);
    durationStr = ` (${formatElapsed(combatStart, combatEnd)}, ${rounds} round${rounds !== 1 ? 's' : ''})`;
  }

  return `<h2>${scene}</h2>\n<p><strong>Duration:</strong>${durationStr}</p>`;
}

// ── Initiative ───────────────────────────────────────────────────────────────

function formatInitiativeTable(order) {
  if (!order || order.length === 0) return '';

  const rows = order.map((entry, i) => {
    const name = escapeHTML(entry.name ?? 'Unknown');
    const init = entry.initiative_total ?? '—';
    return `  <tr><td>${i + 1}.</td><td>${name}</td><td>${init}</td></tr>`;
  });

  return `<h3>Initiative</h3>\n<table>\n${rows.join('\n')}\n</table>`;
}

// ── Round ────────────────────────────────────────────────────────────────────

function formatRound(round, combatStart) {
  const elapsed = formatElapsedTag(combatStart, round.started_at);
  const parts = [`<h3>Round ${round.round_number}${elapsed}</h3>`];

  for (const turn of round.turns ?? []) {
    parts.push(formatTurn(turn, combatStart));
  }

  return parts.join('\n');
}

// ── Turn ─────────────────────────────────────────────────────────────────────

function formatTurn(turn, combatStart) {
  const name = escapeHTML(turn.combatant_name ?? 'Unknown');
  const hpLabel = turn.hp_start !== null && turn.hp_max !== null
    ? ` (HP: ${turn.hp_start}/${turn.hp_max})`
    : '';
  const elapsed = formatElapsedTag(combatStart, turn.started_at);

  const parts = [`<h4>${name}${hpLabel}${elapsed}</h4>`];

  // Actions (skip move-type actions — we show aggregated movement separately)
  const displayActions = (turn.actions ?? []).filter(a => a.action_type !== 'move');
  if (displayActions.length > 0) {
    const items = displayActions.map(a => `  <li>${formatAction(a, turn.hp_changes)}</li>`);
    parts.push(`<ul>\n${items.join('\n')}\n</ul>`);
  }

  // Movement
  if (turn.total_distance_ft > 0) {
    const speedPart = turn.speed ? `/${turn.speed}ft` : 'ft';
    parts.push(`<p><strong>Move:</strong> ${turn.total_distance_ft}ft${speedPart}</p>`);
  }

  // HP change summary
  if (turn.hp_start !== null && turn.hp_end !== null && turn.hp_start !== turn.hp_end) {
    const delta = turn.hp_end - turn.hp_start;
    const sign = delta > 0 ? '+' : '';
    parts.push(`<p><strong>HP:</strong> ${turn.hp_start} → ${turn.hp_end} (${sign}${delta})</p>`);
  }

  // Effects diff
  const effectLines = formatEffectsDiff(turn);
  if (effectLines) {
    parts.push(`<p><strong>Effects:</strong> ${effectLines}</p>`);
  }

  return parts.join('\n');
}

// ── Action formatting ────────────────────────────────────────────────────────

function formatAction(action, hpChanges) {
  const parts = [];

  // Action name with item name
  let label = escapeHTML(action.action_name ?? 'Unknown');
  if (action.item_name && action.item_name !== action.action_name) {
    label += ` (${escapeHTML(action.item_name)}`;
    if (action.map_penalty) label += `, MAP -${action.map_penalty * 5}`;
    label += ')';
  } else if (action.map_penalty) {
    label += ` (MAP -${action.map_penalty * 5})`;
  }
  parts.push(label);

  // Targets
  if (action.targets?.length) {
    parts.push(`→ ${action.targets.map(escapeHTML).join(', ')}`);
  }

  // Roll result
  if (action.roll_result !== null && action.roll_result !== undefined) {
    // Only show "vs AC" for attack-type actions
    if (action.action_type === 'strike' || action.action_type === 'spell') {
      parts.push(`${action.roll_result} vs AC`);
    } else {
      parts.push(`${action.roll_result}`);
    }
  }

  // Degree of success
  if (action.degree_of_success) {
    parts.push(DEGREE_LABELS[action.degree_of_success] ?? action.degree_of_success);
  }

  // Damage
  if (action.damage_dealt !== null && action.damage_dealt !== undefined) {
    const dmgType = action.damage_type ? ` ${escapeHTML(action.damage_type)}` : '';
    let dmgStr = `${action.damage_dealt}${dmgType}`;

    // Cross-reference with actual HP changes
    const actualDelta = findActualHPDelta(action, hpChanges);
    if (actualDelta !== null && Math.abs(actualDelta) !== action.damage_dealt) {
      const actual = Math.abs(actualDelta);
      const resisted = action.damage_dealt - actual;
      if (resisted > 0) {
        dmgStr += ` (${actual} HP lost, ${resisted} resisted)`;
      } else {
        dmgStr += ` (${actual} HP lost)`;
      }
    }

    parts.push(dmgStr);
  }

  // Healing
  if (action.healing_done !== null && action.healing_done !== undefined) {
    parts.push(`healed ${action.healing_done} HP`);
  }

  // Reaction tag
  if (action.notes === 'reaction') {
    parts.push('[Reaction]');
  }

  return parts.join(' — ');
}

/**
 * Try to find the actual HP delta for a damage action by matching targets
 * against hp_changes on the same turn.
 * @returns {number|null} the HP delta (negative for damage), or null if not found
 */
function findActualHPDelta(action, hpChanges) {
  if (!hpChanges?.length || !action.targets?.length) return null;
  if (action.damage_dealt === null && action.healing_done === null) return null;

  // Find an HP change whose actor_name matches one of the action's targets
  for (const target of action.targets) {
    const match = hpChanges.find(hc => hc.actor_name === target);
    if (match) return match.delta;
  }

  return null;
}

// ── Effects diff ─────────────────────────────────────────────────────────────

function formatEffectsDiff(turn) {
  const parts = [];

  for (const name of turn.effects_gained ?? []) {
    parts.push(`+${escapeHTML(name)}`);
  }

  for (const name of turn.effects_lost ?? []) {
    parts.push(`-${escapeHTML(name)}`);
  }

  for (const change of turn.effects_changed ?? []) {
    parts.push(`${escapeHTML(change.name)} ${change.from}→${change.to}`);
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Format elapsed time between two Date objects as M:SS or H:MM:SS.
 */
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

/**
 * Format an elapsed-time tag like " [+1:23]" from combatStart and an ISO timestamp.
 * Returns empty string if either value is missing.
 */
function formatElapsedTag(combatStart, isoTimestamp) {
  if (!combatStart || !isoTimestamp) return '';
  const ts = new Date(isoTimestamp);
  return ` <em>[+${formatElapsed(combatStart, ts)}]</em>`;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
