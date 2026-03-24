const MODULE_ID = 'pf2e-combat-chronicle';

export class MovementTracker {
  /** @type {Map<string, {x: number, y: number}>} — last known position per token ID */
  #previousPosition = new Map();

  /** @type {Array} — movement events accumulated during the current turn */
  #pendingMovements = [];

  /**
   * Store the token's current position as the baseline for movement tracking.
   * Called at turn start for the active combatant's token.
   * @param {TokenDocument} token
   */
  initBaseline(token) {
    if (!token) return;
    this.#previousPosition.set(token.id, { x: token.x, y: token.y });
  }

  /**
   * Handle a token position change from the updateToken hook.
   * Computes distance and records the movement event.
   * @param {TokenDocument} token — token after update (already has new position)
   * @param {object} changes — the diff object from Foundry
   */
  onTokenMove(token, changes) {
    const hasPositionChange = ('x' in changes) || ('y' in changes);
    if (!hasPositionChange) return;

    const tokenId = token.id;
    const prev = this.#previousPosition.get(tokenId);
    if (!prev) {
      // No baseline — token wasn't tracked; set baseline now
      this.#previousPosition.set(tokenId, { x: token.x, y: token.y });
      return;
    }

    const newX = token.x;
    const newY = token.y;

    // Skip if position hasn't actually changed
    if (prev.x === newX && prev.y === newY) return;

    const scene = token.parent;
    const distanceFt = this.#calculateDistance(prev.x, prev.y, newX, newY, scene);

    const movement = {
      token_name: token.name,
      actor_id: token.actorId ?? null,
      timestamp: new Date().toISOString(),
      from: { x: prev.x, y: prev.y },
      to: { x: newX, y: newY },
      distance_ft: distanceFt,
    };

    this.#pendingMovements.push(movement);

    // Update baseline to current position for next movement
    this.#previousPosition.set(tokenId, { x: newX, y: newY });

    console.log(`${MODULE_ID} | Movement: ${token.name} (${prev.x},${prev.y})→(${newX},${newY}) ${distanceFt} ft`);
  }

  /**
   * Calculate distance in feet between two pixel positions using scene grid settings.
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {Scene} scene
   * @returns {number} distance in feet (rounded to 1 decimal)
   */
  #calculateDistance(x1, y1, x2, y2, scene) {
    const gridSize = scene?.grid?.size ?? 100;
    const gridDistance = scene?.grid?.distance ?? 5;

    const pixelDist = Math.hypot(x2 - x1, y2 - y1);
    const gridSquares = pixelDist / gridSize;
    const distanceFt = Math.round(gridSquares * gridDistance * 10) / 10;

    return distanceFt;
  }

  /**
   * Drain and return all accumulated movement events since last call.
   * @returns {Array}
   */
  drainMovements() {
    const movements = this.#pendingMovements;
    this.#pendingMovements = [];
    return movements;
  }

  /**
   * Clear all tracked state (call when combat ends).
   */
  reset() {
    this.#previousPosition.clear();
    this.#pendingMovements = [];
  }
}
