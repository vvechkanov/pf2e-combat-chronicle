/**
 * Pure function that computes encounter summary statistics from a finalized encounter object.
 * No Foundry API calls — operates entirely on encounter data.
 */

const XP_TABLE = {
  '-4': 10, '-3': 15, '-2': 20, '-1': 30, '0': 40,
  '1': 60, '2': 80, '3': 120, '4': 160,
};

/**
 * Generate encounter summary statistics.
 * @param {object} encounter — finalized encounter object
 * @returns {object} summary with global and per_actor stats
 */
export function generateSummary(encounter) {
  const actorInfo = buildActorInfo(encounter.initiative_order);
  const allTurns = flattenTurns(encounter.rounds);
  const allActions = flattenActions(allTurns);
  const allHpChanges = flattenHpChanges(allTurns);

  const totalRounds = encounter.rounds.length;

  // Pre-compute damage aggregates needed by multiple metrics
  const damageDealtByActor = computeDamageDealt(allActions, actorInfo);
  const damageTakenByActor = computeDamageTaken(allHpChanges, actorInfo);
  const totalDamageDealt = sumValues(damageDealtByActor);
  const totalDamageTakenByParty = sumValuesFiltered(damageTakenByActor, actorInfo, 'pc');

  const global = computeGlobalStats(encounter, actorInfo, allTurns);

  const per_actor = {};
  for (const [actorId, info] of actorInfo) {
    const actorActions = allActions.filter(a => a.actor_id === actorId);
    const actorHpChanges = allHpChanges.filter(c => c.actor_id === actorId);
    const dealt = damageDealtByActor.get(actorId) ?? 0;
    const taken = damageTakenByActor.get(actorId) ?? 0;

    per_actor[actorId] = {
      name: info.name,
      actor_type: info.type,
      level: info.level,
      damage_dealt: dealt,
      damage_taken: taken,
      damage_dealt_per_round: totalRounds > 0 ? round1(dealt / totalRounds) : 0,
      max_single_hit: computeMaxSingleHit(actorActions),
      damage_share_percent: totalDamageDealt > 0 ? round1(dealt / totalDamageDealt * 100) : null,
      hp_efficiency: taken > 0 ? round2(dealt / taken) : null,
      healing_done: sumField(actorActions, 'healing_done'),
      healing_received: computeHealingReceived(actorHpChanges),
      clutch_heal_count: computeClutchHeals(actorActions, allTurns, actorId, 0.25),
      revive_count: computeRevives(actorActions, allTurns, actorId),
      hit_rate_percent: computeHitRate(actorActions),
      times_downed: computeTimesDowned(allHpChanges, actorId),
      tank_score: totalDamageTakenByParty > 0 && info.type === 'pc'
        ? round1(taken / totalDamageTakenByParty * 100)
        : null,
      times_targeted: computeTimesTargeted(allActions, info.name, actorId),
      dodge_master_percent: computeDodgeMaster(allActions, info.name, actorId),
      one_shots: computeOneShots(actorActions, allTurns, actorId),
    };
  }

  return { global, per_actor };
}

// ── Index builders ──────────────────────────────────────────

function buildActorInfo(initiativeOrder) {
  const map = new Map();
  for (const entry of initiativeOrder) {
    if (!entry.actor_id) continue;
    map.set(entry.actor_id, {
      name: entry.name,
      level: entry.actor_level ?? null,
      type: entry.actor_type ?? 'npc',
      base_actor_id: entry.base_actor_id ?? entry.actor_id,
    });
  }
  return map;
}

function flattenTurns(rounds) {
  const result = [];
  for (const round of rounds) {
    for (const turn of round.turns) {
      result.push({ ...turn, round_number: round.round_number });
    }
  }
  return result;
}

function flattenActions(allTurns) {
  const result = [];
  for (const turn of allTurns) {
    for (const action of turn.actions) {
      result.push({
        ...action,
        // Use action.actor_id if available (reaction attribution), fall back to turn owner
        actor_id: action.actor_id ?? turn.actor_id,
        _turn: turn,
      });
    }
  }
  return result;
}

function flattenHpChanges(allTurns) {
  const result = [];
  for (const turn of allTurns) {
    for (const change of turn.hp_changes) {
      result.push({ ...change, _turn: turn });
    }
  }
  return result;
}

// ── Global stats ────────────────────────────────────────────

function computeGlobalStats(encounter, actorInfo, allTurns) {
  const totalRounds = encounter.rounds.length;
  const combatDuration = computeDurationSeconds(encounter.started_at, encounter.ended_at);
  const xpResult = computeXP(actorInfo);
  const turnDurations = computeTurnDurations(allTurns, actorInfo);

  return {
    total_rounds: totalRounds,
    combat_duration_seconds: combatDuration,
    total_xp: xpResult.total_xp,
    xp_per_player: xpResult.xp_per_player,
    party_level: xpResult.party_level,
    avg_turn_duration_gm_seconds: turnDurations.avg_gm,
    avg_turn_duration_per_npc_type: turnDurations.per_npc_type,
    avg_turn_duration_per_player: turnDurations.per_player,
  };
}

function computeDurationSeconds(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  return round1((new Date(endedAt) - new Date(startedAt)) / 1000);
}

function computeXP(actorInfo) {
  const pcs = [];
  const npcs = [];
  for (const [, info] of actorInfo) {
    if (info.type === 'pc' && info.level !== null) pcs.push(info.level);
    if (info.type === 'npc' && info.level !== null) npcs.push(info.level);
  }

  if (pcs.length === 0) return { total_xp: 0, xp_per_player: 0, party_level: null };

  const partyLevel = Math.round(pcs.reduce((s, l) => s + l, 0) / pcs.length);
  let totalXp = 0;

  for (const npcLevel of npcs) {
    const diff = Math.max(-4, Math.min(4, npcLevel - partyLevel));
    totalXp += XP_TABLE[String(diff)] ?? 0;
  }

  return {
    total_xp: totalXp,
    xp_per_player: pcs.length > 0 ? Math.floor(totalXp / pcs.length) : 0,
    party_level: partyLevel,
  };
}

function computeTurnDurations(allTurns, actorInfo) {
  const npcDurations = [];
  const npcTypeMap = new Map(); // base_actor_id → { name, durations[] }
  const playerMap = new Map(); // actor_id → { name, durations[] }

  for (const turn of allTurns) {
    const duration = computeDurationSeconds(turn.started_at, turn.ended_at);
    if (duration === null || duration < 0) continue;

    const info = actorInfo.get(turn.actor_id);
    if (!info) continue;

    if (info.type === 'npc') {
      npcDurations.push(duration);
      const baseId = turn.base_actor_id ?? info.base_actor_id ?? turn.actor_id;
      if (!npcTypeMap.has(baseId)) {
        npcTypeMap.set(baseId, { name: info.name, durations: [] });
      }
      npcTypeMap.get(baseId).durations.push(duration);
    } else {
      if (!playerMap.has(turn.actor_id)) {
        playerMap.set(turn.actor_id, { name: info.name, durations: [] });
      }
      playerMap.get(turn.actor_id).durations.push(duration);
    }
  }

  const avgGm = npcDurations.length > 0
    ? round1(npcDurations.reduce((s, d) => s + d, 0) / npcDurations.length)
    : null;

  const perNpcType = {};
  for (const [baseId, data] of npcTypeMap) {
    perNpcType[baseId] = {
      name: data.name,
      avg_seconds: round1(data.durations.reduce((s, d) => s + d, 0) / data.durations.length),
      turn_count: data.durations.length,
    };
  }

  const perPlayer = {};
  for (const [actorId, data] of playerMap) {
    perPlayer[actorId] = {
      name: data.name,
      avg_seconds: round1(data.durations.reduce((s, d) => s + d, 0) / data.durations.length),
      turn_count: data.durations.length,
    };
  }

  return { avg_gm: avgGm, per_npc_type: perNpcType, per_player: perPlayer };
}

// ── Per-actor metrics ───────────────────────────────────────

function computeDamageDealt(allActions, actorInfo) {
  const map = new Map();
  for (const [actorId] of actorInfo) map.set(actorId, 0);
  for (const action of allActions) {
    if (action.damage_dealt && action.actor_id) {
      map.set(action.actor_id, (map.get(action.actor_id) ?? 0) + action.damage_dealt);
    }
  }
  return map;
}

function computeDamageTaken(allHpChanges, actorInfo) {
  const map = new Map();
  for (const [actorId] of actorInfo) map.set(actorId, 0);
  for (const change of allHpChanges) {
    if (change.delta < 0 && change.actor_id) {
      map.set(change.actor_id, (map.get(change.actor_id) ?? 0) + Math.abs(change.delta));
    }
  }
  return map;
}

function computeMaxSingleHit(actorActions) {
  let max = { value: 0, item_name: null };
  for (const action of actorActions) {
    if (action.damage_dealt && action.damage_dealt > max.value) {
      max = { value: action.damage_dealt, item_name: action.item_name ?? null };
    }
  }
  return max;
}

function computeHealingReceived(actorHpChanges) {
  let total = 0;
  for (const change of actorHpChanges) {
    if (change.delta > 0) total += change.delta;
  }
  return total;
}

function computeHitRate(actorActions) {
  let hits = 0;
  let total = 0;
  for (const action of actorActions) {
    if (!action.degree_of_success) continue;
    total++;
    if (action.degree_of_success === 'success' || action.degree_of_success === 'critical-success') {
      hits++;
    }
  }
  return total > 0 ? round1(hits / total * 100) : null;
}

function computeTimesDowned(allHpChanges, actorId) {
  let count = 0;
  for (const change of allHpChanges) {
    if (change.actor_id === actorId && change.hp_after === 0 && change.hp_before > 0) {
      count++;
    }
  }
  return count;
}

function computeTimesTargeted(allActions, actorName, actorId) {
  let count = 0;
  for (const action of allActions) {
    if (action.actor_id === actorId) continue; // don't count self-targeting
    if (action.targets && action.targets.includes(actorName)) {
      count++;
    }
  }
  return count;
}

function computeDodgeMaster(allActions, actorName, actorId) {
  let misses = 0;
  let total = 0;
  for (const action of allActions) {
    if (action.actor_id === actorId) continue;
    if (!action.targets || !action.targets.includes(actorName)) continue;
    if (!action.degree_of_success) continue;
    total++;
    if (action.degree_of_success === 'failure' || action.degree_of_success === 'critical-failure') {
      misses++;
    }
  }
  return total > 0 ? round1(misses / total * 100) : null;
}

/**
 * Count clutch heals: healing actions where a target was at or below a HP threshold.
 */
function computeClutchHeals(actorActions, allTurns, actorId, threshold) {
  let count = 0;
  for (const action of actorActions) {
    if (!action.healing_done || !action.targets) continue;
    const turn = action._turn;
    if (!turn) continue;

    for (const targetName of action.targets) {
      const matchingChange = turn.hp_changes.find(
        c => c.actor_name === targetName && c.delta > 0 && c.hp_max > 0 && c.hp_before / c.hp_max <= threshold
      );
      if (matchingChange) count++;
    }
  }
  return count;
}

/**
 * Count revives: healing actions where a target was at 0 HP.
 */
function computeRevives(actorActions, allTurns, actorId) {
  let count = 0;
  for (const action of actorActions) {
    if (!action.healing_done || !action.targets) continue;
    const turn = action._turn;
    if (!turn) continue;

    for (const targetName of action.targets) {
      const matchingChange = turn.hp_changes.find(
        c => c.actor_name === targetName && c.delta > 0 && c.hp_before === 0
      );
      if (matchingChange) count++;
    }
  }
  return count;
}

/**
 * Find one-shot kills: a single hit that took a target from full HP to 0.
 */
function computeOneShots(actorActions, allTurns, actorId) {
  const results = [];
  for (const action of actorActions) {
    if (!action.damage_dealt || !action.targets) continue;
    const turn = action._turn;
    if (!turn) continue;

    for (const targetName of action.targets) {
      const matchingChange = turn.hp_changes.find(
        c => c.actor_name === targetName && c.hp_after === 0 && c.hp_before === c.hp_max && c.hp_before > 0
      );
      if (matchingChange) {
        results.push({
          target_name: targetName,
          damage: action.damage_dealt,
          item_name: action.item_name ?? null,
        });
      }
    }
  }
  return results;
}

// ── Utilities ───────────────────────────────────────────────

function sumField(actions, field) {
  let total = 0;
  for (const a of actions) {
    if (a[field]) total += a[field];
  }
  return total;
}

function sumValues(map) {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

function sumValuesFiltered(map, actorInfo, type) {
  let total = 0;
  for (const [actorId, v] of map) {
    const info = actorInfo.get(actorId);
    if (info && info.type === type) total += v;
  }
  return total;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
