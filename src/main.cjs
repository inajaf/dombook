const { app, BrowserWindow, dialog, ipcMain, Menu, shell, safeStorage } = require("electron");
const {
  bookingPolicy, getLanguage, setBookingPolicy, setEntitlements, setLanguage, unitAllowanceStatus,
} = require("./domain/settings.cjs");
const { createBackup, listBackups } = require("./domain/backups.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
// The synchronous API, needed for the one-time data migration below: it must finish before
// the database path is resolved, and `app.getPath("userData")` is read synchronously later.
const fsSync = require("node:fs");
const { RentKeeperDatabase } = require("./database.cjs");
const { assertCheckoutUrl } = require("./main/checkout-url.cjs");
const { createAuthApi } = require("./main/auth.cjs");
const { createAuthSessionStore } = require("./main/auth-session.cjs");
const { createSyncEngine } = require("./main/sync.cjs");
const { wholeMonthsBetween } = require("./domain/booking/booking-policy.cjs");
const { quoteReservation } = require("./domain/booking/pricing.cjs");
const {
  dashboard, entitlements, listReservations, documentRequisites,
  calendar, listProperties, listPlaces,
} = require("./domain/reports.cjs");
const { nowIso } = require("./database.cjs");
const { DOCUMENT_KINDS, documentFileName } = require("./main/documents.cjs");
const { renderHtmlToPdf } = require("./main/pdf.cjs");

let mainWindow;
let database;
let authApi;
let syncEngine;
// Serialises sync attempts and schedules the periodic one.
let syncTimer = null;

app.setName("RentKeeper");
app.setPath("userData", path.join(app.getPath("appData"), "rentkeeper-desktop"));

/**
 * Carry an existing installation's data across the rename.
 *
 * Electron derives the userData path from the app name, so renaming the product moves where
 * the app looks for its database, logs and encrypted session. Without this, every existing
 * user opens the renamed app and finds it EMPTY — their bookings, their licence and their
 * login all appear to have vanished, which is the worst possible outcome of a cosmetic
 * change. The old directory is moved only when the new one does not exist, so a user who has
 * already run the renamed build is never overwritten.
 */
function migrateLegacyUserData() {
  const appData = app.getPath("appData");
  const next = path.join(appData, "rentkeeper-desktop");
  const legacy = path.join(appData, "dombook-desktop");
  if (fsSync.existsSync(next) || !fsSync.existsSync(legacy)) return;
  try {
    fsSync.renameSync(legacy, next);
    console.log(`[migration] moved user data from ${legacy} to ${next}`);
  } catch (error) {
    // A cross-device rename cannot work; copy instead, and leave the original in place so
    // nothing is lost if the copy is interrupted.
    console.error(`[migration] could not move user data: ${error.message}`);
    try {
      fsSync.cpSync(legacy, next, { recursive: true });
      console.log(`[migration] copied user data to ${next}`);
    } catch (copyError) {
      console.error(`[migration] copy failed, continuing with an empty profile: ${copyError.message}`);
    }
  }
}
migrateLegacyUserData();

function electronEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function createAuthStore(filePath) {
  return createAuthSessionStore({
    filePath,
    readFile: (p) => fs.readFile(p),
    writeFile: (p, data) => fs.writeFile(p, data),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
    isEncryptionAvailable: electronEncryptionAvailable,
  });
}

function ok(data) {
  return { ok: true, data };
}

function fail(error) {
  console.error(error);
  return { ok: false, error: error?.message || "Неизвестная ошибка" };
}

/**
 * IPC channels that must work while signed out.
 *
 * Everything else is refused without a session. The renderer hides the workspace behind the
 * login screen, but hiding is presentation: without a gate here, anything that can reach the
 * bridge — a compromised renderer, DevTools, or simply a stale window — could read and write
 * the whole local database without signing in.
 */
const SIGNED_OUT_CHANNELS = new Set([
  "auth:status",
  "auth:send",
  "auth:setup",
  "auth:verify",
  "auth:setPlan",
  "auth:checkout",
  "auth:logout",
  // The login screen shows the language selector and reads app paths before anyone signs in.
  "system:info",
  "system:setLanguage",
]);

// The session is cached rather than read from disk per call: every data channel would
// otherwise decrypt the stored session, and the cache is refreshed on sign-in and sign-out.
let sessionCache;
let sessionCacheAt = 0;
const SESSION_CACHE_MS = 5_000;

async function hasSession() {
  if (!authApi) return false;
  const now = Date.now();
  if (sessionCache !== undefined && now - sessionCacheAt < SESSION_CACHE_MS) return sessionCache;
  try {
    sessionCache = Boolean(await authApi.restore());
  } catch {
    // Unreachable server or a rejected token both mean no usable session.
    sessionCache = false;
  }
  sessionCacheAt = now;
  return sessionCache;
}

/** Drop the cached session so the next check re-reads it. */
function invalidateSessionCache() {
  sessionCache = undefined;
  sessionCacheAt = 0;
}

function handle(channel, action) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      if (!SIGNED_OUT_CHANNELS.has(channel) && !(await hasSession())) {
        // A distinct code, so the renderer can return to the login screen rather than
        // showing a generic failure for what is really "you are not signed in".
        return fail(Object.assign(new Error("Требуется вход в аккаунт"), { code: "unauthenticated", status: 401 }));
      }
      const result = await action(payload);
      // Signing in or out changes the answer, so the cache must not outlive it.
      if (channel === "auth:verify" || channel === "auth:logout" || channel === "auth:checkout") {
        invalidateSessionCache();
      }
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  });
}

function registerIpc() {
  handle("auth:status", async () => {
    try {
      const session = await authApi.restore();
      await adoptAccount(session);
      return {
        authenticated: Boolean(session),
        session,
        baseUrl: authApi.baseUrl,
      };
    } catch (error) {
      // Backend unreachable / session rejected: report a signed-out state so
      // the renderer shows only the login screen (app data is gated behind
      // authentication).
      return { authenticated: false, session: null, baseUrl: authApi.baseUrl, offline: true };
    }
  });
  handle("auth:send", (payload) => authApi.send(payload?.email));
  handle("auth:setup", (payload) => authApi.setup(payload?.email));
  handle("auth:verify", async (payload) => {
    const session = await authApi.verify(payload?.email, payload?.code);
    const adopted = await adoptAccount(session, { accountCreated: payload?.accountCreated === true });
    // The renderer needs to say so when someone else's local data has just been removed: it is
    // the one consequence of signing in that a user can lose work to.
    return { ...session, accountSwitched: adopted.switched };
  });
  handle("auth:setPlan", (payload) => authApi.setPlan(payload?.plan));
    handle("auth:checkout", async (payload) => {
      const checkout = await authApi.checkout(payload?.plan);
      if (!checkout?.checkoutUrl) throw new Error("Paddle не вернул ссылку на оплату");
      await shell.openExternal(assertCheckoutUrl(checkout.checkoutUrl));
      return checkout;
    });
    handle("auth:logout", () => authApi.logout());

    // Sync. The renderer only triggers and observes; the merge itself happens in the main
    // process, where the local database and the session token both live.
    // The booking window is fetched on demand and cached locally, so the client validates
    // against the same rule the server will apply.
    handle("bookingPolicy:get", async (_payload) => {
      try {
        // authApi returns the whole response envelope, so the policy sits one level in.
        // Spreading the envelope made the renderer read `data.data.maximumTenancyMonths`,
        // which is undefined — the settings panel then showed nothing for the field while
        // the value was present.
        const response = await authApi.bookingPolicy();
        const policy = response?.data ?? response ?? {};
        setBookingPolicy(database, policy);
        return { ...policy, ...bookingPolicy(database) };
      } catch (error) {
        // Offline is a normal state, not a failure: report the cached window so the UI keeps
        // working and say that it is cached.
        return { ...bookingPolicy(database), stale: true, error: error?.message ?? String(error) };
      }
    });

    handle("bookingPolicy:set", async (payload) => {
      const response = await authApi.setBookingPolicy(payload ?? {});
      const policy = response?.data ?? response ?? {};
      setBookingPolicy(database, policy);
      return { ...policy, ...bookingPolicy(database) };
    });


    handle("entitlements:get", async () => {
      try {
        // Same envelope as the policy call: the licence sits one level in, and spreading the
        // envelope would have made `paid` undefined so a licensed account read as unlicensed.
        const response = await authApi.entitlements();
        const entitlements = response?.data ?? response ?? {};
        setEntitlements(database, entitlements);
        return { ...entitlements, stale: false, allowance: unitAllowanceStatus(database) };
      } catch (error) {
        // Offline is expected, not an error: report the cached copy and say it is cached.
        const cached = entitlements(database);
        return {
          ...(cached ?? { paid: false, planName: "Бесплатный", unitLimit: 1, features: [] }),
          stale: true,
          error: error?.message ?? String(error),
          allowance: unitAllowanceStatus(database),
        };
      }
    });

    handle("sync:now", async () => {
      if (!syncEngine) return { ok: false, error: "Синхронизация не настроена" };
      return syncEngine.sync();
    });
    handle("sync:status", async () => {
      const pending = database?.pendingSyncCount?.() ?? 0;
      // Entries the server refused for good. They stay queued so nothing is lost, but they
      // will never drain, and a user watching "N unsynced" forever would reasonably think the
      // app was broken. Reported separately so the UI can say what is actually wrong.
      const stuck = database?.failedSyncCount?.() ?? 0;
      return {
        pending,
        stuck,
        lastResult: syncEngine?.lastResult?.() ?? null,
        cursor: syncEngine?.readWatermark?.() ?? 0,
      };
    });

    handle("dashboard:get", () => dashboard(database));
    handle("calendar:get", (payload) => calendar(database, payload?.days ?? 14, payload?.startDate ?? null));
  // The renderer is sandboxed and cannot load modules, so the month count a tenancy displays
  // is computed here, where the shared booking-policy module already lives. One
  // implementation, pinned in both languages by fixtures/rental-terms-cases.json.
  handle("reservations:list", () => listReservations(database).map((reservation) => ({
    ...reservation,
    rental_months: reservation.booking_kind === "rental"
      ? wholeMonthsBetween(reservation.check_in_date, reservation.check_out_date)
      : 0,
  })));

    handle("places:list", (payload) => listPlaces(database, payload));
    handle("places:create", (payload) => database.createPlace(payload));
    handle("places:update", (payload) => database.updatePlace(payload.id, payload.data));
    handle("places:archive", (payload) => database.archivePlace(payload.id));
    handle("places:restore", (payload) => database.restorePlace(payload.id));

    handle("properties:list", (payload) => listProperties(database, payload));
    handle("properties:create", (payload) => database.createProperty(payload));
    handle("properties:update", (payload) => database.updateProperty(payload.id, payload.data));
    handle("properties:archive", (payload) => database.archiveProperty(payload.id));
    handle("properties:restore", (payload) => database.restoreProperty(payload.id));

  // A price for a booking that has not been saved yet.
  //
  // The dialog has to show what the guest will pay while the owner is still choosing dates, and
  // the renderer is sandboxed: it cannot load the pricing module, and a second copy of the
  // arithmetic there is the drift the shared fixtures exist to prevent. So the preview asks the
  // process that owns the rule. Nothing is written — this is a quote, not a booking.
  handle("pricing:quote", (payload) => {
    const property = database.getProperty(payload?.propertyId);
    if (!property) throw new Error("Дом не найден");
    const bookingKind = payload?.bookingKind === "rental" ? "rental" : "stay";
    const reservation = payload?.reservationId ? database.getReservation(payload.reservationId) : null;
    // An edit keeps the rate the booking was taken at, the same way saving it does: a preview
    // that quotes today's price would disagree with the amount the save then stores.
    const nightlyRateMinor = reservation && reservation.property_id === property.id
      ? reservation.nightly_rate_minor
      : property.base_price_minor;
    const monthlyRateMinor = reservation && reservation.property_id === property.id && reservation.monthly_rate_minor > 0
      ? reservation.monthly_rate_minor
      : property.monthly_rate_minor || 0;
    return quoteReservation({
      kind: bookingKind,
      checkInDate: payload?.checkInDate,
      checkOutDate: payload?.checkOutDate,
      baseNightlyRateMinor: nightlyRateMinor,
      monthlyRateMinor,
      rateRules: property.rate_rules,
    });
  });

    handle("reservations:create", (payload) => database.createReservation(payload));
    handle("reservations:update", (payload) => database.updateReservation(payload.id, payload.data));
    handle("reservations:cancel", (payload) => database.cancelReservation(payload.id));
    handle("reservations:delete", (payload) => database.deleteReservation(payload.id));
    handle("reservations:earlyCheckout", (payload) => database.earlyCheckout(payload.id, payload.data));

    // Where generated contracts and invoices are kept.
    //
    // A folder inside the app's own data directory rather than a file dialog every time: an owner
    // producing a contract for a guest standing in front of them should not have to navigate a
    // filesystem to do it, and the folder is one click away in Settings. "Сохранить как…" is
    // still offered for the times the document has to land somewhere specific.
    handle("documents:folder", async () => {
      const folder = path.join(app.getPath("userData"), "documents");
      await fs.mkdir(folder, { recursive: true });
      return folder;
    });

    /**
     * `shell.openPath` with a deadline.
     *
     * It resolves with an error STRING, or with "" on success — and on a machine with no handler
     * for the file type it does neither, it simply never settles. The renderer awaits the IPC
     * reply, so the promise that never settles is a UI that hangs with no message: on a headless
     * Linux box the "open the document" button waits forever. Found by running the document suite
     * in CI, where there is no PDF viewer at all.
     *
     * A deadline turns that into the failure the renderer already knows how to report.
     */
    const openPathWithDeadline = async (target) => {
      const DEADLINE_MS = 5000;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("__deadline__"), DEADLINE_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        shell.openPath(target).then((error) => error || ""),
        timeout,
      ]);
      clearTimeout(timer);
      if (outcome === "__deadline__") {
        return `система не открыла файл за ${DEADLINE_MS / 1000} с — похоже, для него нет приложения`;
      }
      return outcome;
    };

    handle("documents:openFolder", async () => {
      const folder = path.join(app.getPath("userData"), "documents");
      await fs.mkdir(folder, { recursive: true });
      const error = await openPathWithDeadline(folder);
      if (error) throw new Error(error);
      return folder;
    });

    /**
     * Hand a generated document to the system's viewer.
     *
     * The path is REFUSED unless it is inside the documents folder. The renderer is sandboxed and
     * this is the one channel that takes a path from it, so without the check a compromised view
     * would have a general "open any file on this machine" primitive. The folder is the only place
     * this app writes documents, so nothing legitimate is excluded by the restriction.
     */
    handle("documents:open", async (payload) => {
      const target = await resolveDocumentPath(payload?.filePath);
      const error = await openPathWithDeadline(target);
      if (error) throw new Error(error);
      return target;
    });

    handle("documents:reveal", async (payload) => {
      const target = await resolveDocumentPath(payload?.filePath);
      shell.showItemInFolder(target);
      return target;
    });

    // What has already been produced for a booking, so a document from last week is reachable
    // without knowing where the folder is. Filtered by the document number, which is derived from
    // the booking — the same number that is in the file name.
    /**
     * How much disk the documents folder uses.
     *
     * Nothing deletes a document, on purpose: a contract is a legal record and an automatic
     * deletion would trade a few hundred kilobytes for the paper a tax inspection asks for. The
     * consequence is a folder that only grows, so its size is reported and the owner decides.
     */
    handle("documents:usage", async () => {
      const folder = path.join(app.getPath("userData"), "documents");
      let names = [];
      try {
        names = await fs.readdir(folder);
      } catch {
        return { folder, count: 0, bytes: 0 };
      }
      let count = 0;
      let bytes = 0;
      for (const name of names) {
        if (!name.toLowerCase().endsWith(".pdf")) continue;
        try {
          const stats = await fs.stat(path.join(folder, name));
          count += 1;
          bytes += stats.size;
        } catch {
          // A file that vanished between the listing and the stat is not a reason to fail.
        }
      }
      return { folder, count, bytes };
    });

    handle("documents:list", async (payload) => {
      const folder = path.join(app.getPath("userData"), "documents");
      const reservation = database.getReservation(payload?.reservationId);
      const number = reservation ? documentFileName("invoice", reservation).split("-").slice(1, 3).join("-") : "";
      let names = [];
      try {
        names = await fs.readdir(folder);
      } catch {
        // No folder yet simply means nothing has been produced.
        return [];
      }
      const files = [];
      for (const name of names) {
        if (!name.toLowerCase().endsWith(".pdf")) continue;
        if (number && !name.includes(number)) continue;
        const filePath = path.join(folder, name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) continue;
        files.push({ name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
      return files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    });

    // The document, built but not written. Kept separate from the save so the wording and the
    // arithmetic can be asserted without producing a file, and so a preview is possible.
    handle("documents:html", (payload) => {
      const { reservation, unit, place } = documentContext(payload?.reservationId);
      const kind = DOCUMENT_KINDS[payload?.kind] ? payload.kind : "invoice";
      return DOCUMENT_KINDS[kind].build({
        reservation,
        unit,
        place,
        requisites: documentRequisites(database),
        generatedAt: documentDate(),
      });
    });

    handle("documents:create", async (payload) => {
      const { reservation, unit, place } = documentContext(payload?.reservationId);
      const kind = DOCUMENT_KINDS[payload?.kind] ? payload.kind : "invoice";
      const fileName = documentFileName(kind, reservation);
      const html = DOCUMENT_KINDS[kind].build({
        reservation,
        unit,
        place,
        requisites: documentRequisites(database),
        generatedAt: documentDate(),
      });

      let target = path.join(app.getPath("userData"), "documents", fileName);
      if (payload?.choose) {
        const picked = await dialog.showSaveDialog(mainWindow, {
          title: DOCUMENT_KINDS[kind].label,
          defaultPath: target,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (picked.canceled || !picked.filePath) return { canceled: true };
        target = picked.filePath;
      }
      await renderHtmlToPdf(html, target);
      return { canceled: false, path: target, fileName: path.basename(target), folder: path.dirname(target) };
    });

    handle("backups:list", () => listBackups(database));
    handle("backups:create", () => createBackup(database));
    handle("system:info", () => database.systemInfo());
    handle("system:setLanguage", (payload) => {
      const language = setLanguage(database, payload?.language);
      createMenu(language);
      return language;
    });
    // Team and invitations. Passed straight through to the server, which decides by role:
    // nothing about who may see what is decided here.
    handle("team:members", () => authApi.members());
    handle("team:invites", () => authApi.invites());
    handle("team:invite", (payload) => authApi.invite(payload?.email, payload?.role));
    handle("team:revokeInvite", (payload) => authApi.revokeInvite(payload?.inviteId));

    handle("system:setDocumentRequisites", (payload) => database.setDocumentRequisites(payload));
    handle("system:openBackupDirectory", async () => {
      const error = await shell.openPath(database.systemInfo().backupDir);
      if (error) throw new Error(error);
      return true;
    });
  }

  /**
   * The rows a document is built from.
   *
   * Loaded here rather than passed in from the renderer: a document states what the account's own
   * records say, and a view that could hand in its own figures could produce a contract the
   * database does not agree with.
   */
  /**
   * Today, in the account's own time zone.
   *
   * The same value the booking window is judged against, taken from the same place: a contract
   * dated by the machine's clock rather than the account's would be dated a day out for anyone
   * signing it in the evening on the other side of a border.
   */
  function documentDate() {
    return database.systemInfo().bookingPolicy.today;
  }

  /**
   * Which account this device's local database belongs to.
   *
   * A file rather than a row, deliberately: the local database is the thing being identified, so a
   * marker inside it would be replaced along with it, and `app_settings` replicates to the very
   * account we are trying to tell apart from the last one.
   */
  function accountMarkerPath() {
    return path.join(app.getPath("userData"), "account.json");
  }

  function storedAccountId() {
    try {
      return JSON.parse(fsSync.readFileSync(accountMarkerPath(), "utf8")).accountId || "";
    } catch {
      return "";
    }
  }

  /**
   * Make the local database belong to the account that just signed in.
   *
   * The desktop is single-tenant: its database has no tenant column and no notion of an owner, so
   * without this a second account signing in on the same device reads the first account's
   * bookings and then fails to sync — the pull collides with rows that are already there
   * ("UNIQUE constraint failed: places.name"), and any row still queued from the previous account
   * is waiting to be pushed INTO the new one.
   *
   * No marker means an install that predates this check. Nothing is thrown away on a guess: it is
   * adopted as-is, and the marker is written so the next switch is caught.
   */
  async function adoptAccount(session, { accountCreated = false } = {}) {
    const accountId = session?.accountId || "";
    if (!accountId) return { switched: false };
    const stored = storedAccountId();
    const switched = Boolean(stored) && stored !== accountId;
    // Nothing but the demo seed, no marker, and an account that already existed: this device has
    // never talked to the server, so there is nothing of the account's to keep and nothing of the
    // user's to lose. It is discarded for the same reason a switch is — see hasNeverSynced() for
    // what the seed costs when it is pushed at an account that already holds one.
    //
    // `accountCreated` is the whole difference between a SECOND DEVICE and a SIGNUP, which look
    // identical from here: both are an empty database and an address that was just typed. A signup
    // must keep the sample — it is the only data the new account has — and a second device must
    // throw it away and take the account's.
    const pristine = !switched && !stored && !accountCreated && database.hasNeverSynced();
    if (switched || pristine) {
      database.reset();
    }
    try {
      fsSync.writeFileSync(accountMarkerPath(), JSON.stringify({ accountId, at: nowIso() }));
    } catch (error) {
      // Losing the marker costs the NEXT account switch, not this session; refusing the sign-in
      // over it would be worse.
      console.error("Could not record the account marker:", error);
    }
    return { switched: switched || pristine };
  }

  /**
   * A path the renderer asked us to open, confirmed to be a document this app produced.
   *
   * `path.resolve` first, so `..` segments are collapsed before the prefix test — comparing the
   * raw string would accept `<documents>/../../.ssh/id_rsa`.
   */
  async function resolveDocumentPath(filePath) {
    const folder = path.join(app.getPath("userData"), "documents");
    const resolved = path.resolve(String(filePath || ""));
    if (!resolved.startsWith(path.resolve(folder) + path.sep)) {
      throw new Error("Можно открыть только документы, созданные приложением");
    }
    await fs.access(resolved);
    return resolved;
  }

  function documentContext(reservationId) {
    const reservation = database.getReservation(reservationId);
    if (!reservation) throw new Error("Бронь не найдена");
    const unit = database.getProperty(reservation.property_id);
    const place = unit?.place_id ? database.getPlace(unit.place_id) : null;
    return { reservation, unit, place };
  }

  function createWindow() {
    const rendererPath = path.join(__dirname, "renderer", "index.html");
    const iconPath = path.join(__dirname, "assets", "rentkeeper-icon.png");
    mainWindow = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 980,
      minHeight: 680,
      backgroundColor: "#f4f7f5",
      title: "RentKeeper",
      icon: iconPath,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
      if (!navigationUrl.startsWith("file://")) {
        event.preventDefault();
      }
    });
    mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      console.error("Failed to load:", errorCode, errorDescription, validatedURL);
    });
    mainWindow.loadFile(rendererPath).then(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }).catch((err) => {
      console.error("loadFile error:", err);
    });
  }

  function createMenu(language = (database ? getLanguage(database) : "ru") || "ru") {
    const labels = {
      ru: {
        file: "Файл",
        about: "О программе",
        quit: "Выйти",
        edit: "Правка",
        view: "Вид",
        undo: "Отменить",
        redo: "Повторить",
        cut: "Вырезать",
        copy: "Копировать",
        paste: "Вставить",
        selectAll: "Выбрать всё",
        reload: "Перезагрузить",
        fullscreen: "Полный экран",
        devTools: "Инструменты разработчика",
      },
      az: {
        file: "Fayl",
        about: "Proqram haqqında",
        quit: "Çıxış",
        edit: "Düzəliş",
        view: "Görünüş",
        undo: "Geri al",
        redo: "Təkrar et",
        cut: "Kəs",
        copy: "Kopyala",
        paste: "Yapışdır",
        selectAll: "Hamısını seç",
        reload: "Yenilə",
        fullscreen: "Tam ekran",
        devTools: "Tərtibatçı alətləri",
      },
      en: {
        file: "File",
        about: "About",
        quit: "Quit",
        edit: "Edit",
        view: "View",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        selectAll: "Select All",
        reload: "Reload",
        fullscreen: "Full Screen",
        devTools: "Developer Tools",
      },
    }[language] || {
      file: "File",
      about: "About",
      quit: "Quit",
      edit: "Edit",
      view: "View",
      undo: "Undo",
      redo: "Redo",
      cut: "Cut",
      copy: "Copy",
      paste: "Paste",
      selectAll: "Select All",
      reload: "Reload",
      fullscreen: "Full Screen",
      devTools: "Developer Tools",
    };
    const appMenu = process.platform === "darwin"
      ? [
          { role: "about", label: labels.about },
          { type: "separator" },
          { role: "quit", label: labels.quit },
        ]
      : [{ role: "quit", label: labels.quit }];
    const template = [
      {
        label: process.platform === "darwin" ? "RentKeeper" : labels.file,
        submenu: appMenu,
      },
      {
        label: labels.edit,
        submenu: [
          { role: "undo", label: labels.undo },
          { role: "redo", label: labels.redo },
          { type: "separator" },
          { role: "cut", label: labels.cut },
          { role: "copy", label: labels.copy },
          { role: "paste", label: labels.paste },
          { role: "selectAll", label: labels.selectAll },
        ],
      },
      {
        label: labels.view,
        submenu: [
          { role: "reload", label: labels.reload },
          { role: "togglefullscreen", label: labels.fullscreen },
          ...(app.isPackaged ? [] : [{ role: "toggleDevTools", label: labels.devTools }]),
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.whenReady().then(async () => {
  try {
    const iconPath = path.join(__dirname, "assets", "rentkeeper-icon-transparent.png");
    if (process.platform === "darwin") app.dock.setIcon(iconPath);
    const userData = app.getPath("userData");
    database = await new RentKeeperDatabase({
      filePath: path.join(userData, "dombook.sqlite"),
      backupDir: path.join(userData, "backups"),
      seed: true,
    }).init();
    // RENTKEEPER_API_URL is the current name; DOMBOOK_API_URL is kept working for an
    // existing launcher or e2e script that still exports it.
    const baseUrl = process.env.RENTKEEPER_API_URL || process.env.DOMBOOK_API_URL
      || "http://127.0.0.1:8787";
    const store = createAuthStore(path.join(userData, "auth-session.bin"));
    authApi = createAuthApi({ baseUrl, storage: store });

    // The engine is wired to the local database and the authenticated transport. Nothing in
    // it runs until asked, so a signed-out or offline app simply never syncs.
    syncEngine = createSyncEngine({
      db: database,
      transport: {
        push: (payload) => authApi.syncPush(payload),
        pull: (since) => authApi.syncPull(since),
      },
      nowIso,
      deviceId: () => database.writerId || "unknown",
      onStateChange: (state) => {
        // The renderer shows an unsynced indicator; pushing it rather than making it poll
        // keeps a failed sync visible instead of silent.
        mainWindow?.webContents?.send("sync:changed", state);
      },
    });

    registerIpc();
    createMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Periodic sync. Local-first means the app is fully usable without it, so this is a
    // background convenience rather than a dependency: a failure is recorded and retried on
    // the next tick, and the queued changes stay queued.
    const SYNC_INTERVAL_MS = 60_000;
    syncTimer = setInterval(async () => {
      if (!authApi || !syncEngine) return;
      try {
        const session = await authApi.restore();
        if (!session) return; // signed out: nothing to sync against
        await syncEngine.sync();
      } catch {
        // Already recorded on the queue entry; a periodic failure must not spam the UI.
      }
    }, SYNC_INTERVAL_MS);
    if (syncTimer.unref) syncTimer.unref();
  } catch (error) {
    // A startup failure must be visible. Without this the process stayed alive with no
    // window and no message, which is indistinguishable from a hang.
    console.error("App startup error:", error);
  }
}).catch((error) => {
  console.error("Electron whenReady error:", error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (syncTimer) clearInterval(syncTimer);
  database?.close();
});
