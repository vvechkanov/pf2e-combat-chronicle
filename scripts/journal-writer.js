import { formatEncounterHTML } from './journal-formatter.js';

const MODULE_ID = 'pf2e-combat-chronicle';

export class JournalWriter {
  /** @type {string|null} */
  #folderId = null;

  /**
   * Find or create the Chronicle folder for storing encounter journals.
   * @returns {Promise<string>} folder ID
   */
  async #ensureFolder() {
    // Check cached folder still exists
    if (this.#folderId && game.folders.get(this.#folderId)) {
      return this.#folderId;
    }

    // Search for existing folder by module flag
    const existing = game.folders.find(
      f => f.type === 'JournalEntry' && f.getFlag(MODULE_ID, 'chronicleFolder'),
    );
    if (existing) {
      this.#folderId = existing.id;
      return this.#folderId;
    }

    // Create a new folder
    const folderName = game.i18n.localize(`${MODULE_ID}.journal.folderName`);
    const folder = await Folder.create({
      name: folderName,
      type: 'JournalEntry',
    });
    await folder.setFlag(MODULE_ID, 'chronicleFolder', true);
    this.#folderId = folder.id;
    console.log(`${MODULE_ID} | Created journal folder: ${folderName}`);
    return this.#folderId;
  }

  /**
   * Save encounter data to a new JournalEntry.
   * @param {object} encounterData — full encounter object
   * @returns {Promise<JournalEntry|null>} the created JournalEntry, or null on failure
   */
  async saveEncounter(encounterData) {
    if (!encounterData?.encounter_id) {
      console.warn(`${MODULE_ID} | ${game.i18n.localize(`${MODULE_ID}.journal.noData`)}`);
      return null;
    }

    try {
      const folderId = await this.#ensureFolder();

      // Build entry name: "Encounter — Scene Name — 2026-03-24 15:30"
      const prefix = game.i18n.localize(`${MODULE_ID}.journal.entryPrefix`);
      const date = new Date(encounterData.started_at).toLocaleString();
      const entryName = `${prefix} — ${encounterData.scene_name} — ${date}`;

      const entry = await JournalEntry.create({
        name: entryName,
        folder: folderId,
      });

      await entry.setFlag(MODULE_ID, 'encounterData', encounterData);
      await entry.setFlag(MODULE_ID, 'encounterId', encounterData.encounter_id);

      const pageName = game.i18n.localize(`${MODULE_ID}.journal.pageName`);
      const jsonContent = JSON.stringify(encounterData, null, 2);
      // Escape HTML entities in JSON to prevent rendering issues
      const escaped = jsonContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      await entry.createEmbeddedDocuments('JournalEntryPage', [{
        name: pageName,
        type: 'text',
        text: { content: `<pre>${escaped}</pre>` },
      }]);

      const readablePageName = game.i18n.localize(`${MODULE_ID}.journal.readablePageName`);
      const readableContent = formatEncounterHTML(encounterData);
      await entry.createEmbeddedDocuments('JournalEntryPage', [{
        name: readablePageName,
        type: 'text',
        text: { content: readableContent },
      }]);

      const successMsg = game.i18n.format(`${MODULE_ID}.journal.saveSuccess`, { name: entryName });
      console.log(`${MODULE_ID} | ${successMsg}`);
      return entry;
    } catch (err) {
      console.error(`${MODULE_ID} | ${game.i18n.localize(`${MODULE_ID}.journal.saveError`)}`, err);
      return null;
    }
  }
}
