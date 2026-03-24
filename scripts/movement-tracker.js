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
    const src = changes._source ?? changes;
    const hasPositionChange = ('x' in changes) || ('y' in changes) || ('x' in src) || ('y' in src);
    if (!hasPositionChange) return;

    const tokenId = token.id;
    const prev = this.#previousPosition.get(tokenId);
    if (!prev) {
      // No baseline — token wasn't tracked; set baseline now
      console.log(`${MODULE_ID} | Movement: no baseline for ${token.name} (${tokenId}), setting now`);
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
   * Uses grid-based calculation (Manhattan with 5-10-5 diagonal rule for square grids)
   * to match PF2e movement rules. Falls back to Euclidean for gridless/hex scenes.
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
    const gridType = scene?.grid?.type ?? 1; // 0 = gridless, 1 = square, 2+ = hex

    if (gridType === 0) {
      // Gridless: use Euclidean distance
      const pixelDist = Math.hypot(x2 - x1, y2 - y1);
      return Math.round(pixelDist / gridSize * gridDistance * 10) / 10;
    }

    if (gridType >= 2) {
      // Hex grids: use Euclidean as reasonable approximation
      const pixelDist = Math.hypot(x2 - x1, y2 - y1);
      return Math.round(pixelDist / gridSize * gridDistance * 10) / 10;
    }

    // Square grid: use PF2e 5-10-5 diagonal rule (Chebyshev-like)
    const dx = Math.round(Math.abs(x2 - x1) / gridSize);
    const dy = Math.round(Math.abs(y2 - y1) / gridSize);
    const straight = Math.abs(dx - dy);
    const diag = Math.min(dx, dy);

    // 5-10-5 rule: odd diagonals cost 1 square, even diagonals cost 2 squares
    const diagCost = Math.floor(diag / 2) * 3 + Math.ceil(diag / 2);
    const totalSquares = straight + diagCost;

    return Math.round(totalSquares * gridDistance * 10) / 10;
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
   * Calculate distance from start to end position as a fallback when no movement events
   * were captured via the hook. Uses the same grid-based calculation.
   * @param {{x: number, y: number}} from
   * @param {{x: number, y: number}} to
   * @param {Scene|null} scene
   * @returns {number} distance in feet
   */
  calculateFallbackDistance(from, to, scene) {
    if (!from || !to) return 0;
    if (from.x === to.x && from.y === to.y) return 0;
    return this.#calculateDistance(from.x, from.y, to.x, to.y, scene);
  }

  /**
   * Serialize internal state for persistence.
   * @returns {{previousPosition: Array, pendingMovements: Array}}
   */
  serialize() {
    return {
      previousPosition: Array.from(this.#previousPosition.entries()),
      pendingMovements: [...this.#pendingMovements],
    };
  }

  /**
   * Restore internal state from serialized data.
   * @param {object} data — output of serialize()
   */
  restoreState(data) {
    if (!data) return;
    this.#previousPosition = new Map(data.previousPosition ?? []);
    this.#pendingMovements = data.pendingMovements ?? [];
  }

  /**
   * Clear all tracked state (call when combat ends).
   */
  reset() {
    this.#previousPosition.clear();
    this.#pendingMovements = [];
  }
}
