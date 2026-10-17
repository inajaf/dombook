/**
 * Backup files on disk, and the limit on how many of them exist.
 *
 * These three were already a closed group inside `RentKeeperDatabase`: they touch the two paths the
 * store was constructed with, and nothing else in the class calls them. They are file operations
 * first and database operations only incidentally, which is why they read better here than among
 * the booking commands.
 *
 * `store` gives them `db`, `filePath`, `backupDir`, `persist` and `nowIso`, and that is the whole
 * interface. A backup that needed a domain operation would be a sign the split is wrong.
 */

const BACKUP_LIMIT = 10;

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { nowIso } = require("./clock.cjs");

function createBackup(store) {
    store.persist();
    const stamp = nowIso().replace(/[:.]/g, "-");
    // The backup is named after the product the user knows. It is a file THEY see and
    // may copy elsewhere, unlike the database filename beside it, which is kept as
    // dombook.sqlite because renaming it would orphan every existing install (AGENTS.md).
    const backupPath = path.join(store.backupDir, `rentkeeper-${stamp}.sqlite`);
    fs.copyFileSync(store.filePath, backupPath);
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
    store.audit("backup", null, "created", { file: path.basename(backupPath), checksum });
    const removed = pruneBackups(store, );
    store.persist();
    return { file: path.basename(backupPath), path: backupPath, checksum, createdAt: nowIso(), removed };
  }

  /**
   * Keep the newest BACKUP_LIMIT copies and delete the rest.
   *
   * Nothing removed old backups, and each one is a full copy of the database. A daily backup on a
   * database that grows is a disk that fills quietly, and the failure arrives as a write error in
   * the middle of somebody's booking rather than as anything that mentions backups.
   *
   * A LIMIT, not a size budget: the number of files is what an owner can reason about, and the
   * newest ten are the ones a bad week is recovered from. Documents are deliberately NOT covered
   * by store. A contract is a legal record and deleting one automatically would trade a few
   * hundred kilobytes for the paper a tax inspection asks for, which is the wrong trade at any
   * size (AGENTS.md records the same reasoning for the documents folder).
   */

function pruneBackups(store) {
    if (!fs.existsSync(store.backupDir)) return [];
    const files = fs.readdirSync(store.backupDir)
      .filter((name) => /^rentkeeper-.*\.sqlite$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(store.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const doomed = files.slice(BACKUP_LIMIT);
    for (const entry of doomed) {
      try {
        fs.rmSync(path.join(store.backupDir, entry.name));
      } catch {
        // A backup that cannot be removed is not a reason to fail the backup that was just made.
      }
    }
    if (doomed.length) {
      store.audit("backup", null, "pruned", { files: doomed.map((entry) => entry.name) });
    }
    return doomed.map((entry) => entry.name);
  }


function listBackups(store) {
    if (!fs.existsSync(store.backupDir)) return [];
    return fs.readdirSync(store.backupDir)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => {
        const fullPath = path.join(store.backupDir, name);
        const stats = fs.statSync(fullPath);
        return { file: name, path: fullPath, size: stats.size, createdAt: stats.birthtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }


module.exports = { createBackup, pruneBackups, listBackups, BACKUP_LIMIT };

