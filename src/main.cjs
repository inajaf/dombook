const { app, BrowserWindow, ipcMain, Menu, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
// The synchronous API, needed for the one-time data migration below: it must finish before
// the database path is resolved, and `app.getPath("userData")` is read synchronously later.
const fsSync = require("node:fs");
const { RentKeeperDatabase } = require("./database.cjs");
const { createAuthApi } = require("./main/auth.cjs");
const { createAuthSessionStore } = require("./main/auth-session.cjs");
const { createSyncEngine } = require("./main/sync.cjs");
const { wholeMonthsBetween } = require("./domain/booking/booking-policy.cjs");
const { nowIso } = require("./database.cjs");

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
  handle("auth:verify", (payload) => authApi.verify(payload?.email, payload?.code));
  handle("auth:setPlan", (payload) => authApi.setPlan(payload?.plan));
    handle("auth:checkout", async (payload) => {
      const checkout = await authApi.checkout(payload?.plan);
      if (!checkout?.checkoutUrl) throw new Error("Paddle не вернул ссылку на оплату");
      await shell.openExternal(checkout.checkoutUrl);
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
        database.setBookingPolicy(policy);
        return { ...policy, ...database.bookingPolicy() };
      } catch (error) {
        // Offline is a normal state, not a failure: report the cached window so the UI keeps
        // working and say that it is cached.
        return { ...database.bookingPolicy(), stale: true, error: error?.message ?? String(error) };
      }
    });

    handle("bookingPolicy:set", async (payload) => {
      const response = await authApi.setBookingPolicy(payload ?? {});
      const policy = response?.data ?? response ?? {};
      database.setBookingPolicy(policy);
      return { ...policy, ...database.bookingPolicy() };
    });


    handle("entitlements:get", async () => {
      try {
        // Same envelope as the policy call: the licence sits one level in, and spreading the
        // envelope would have made `paid` undefined so a licensed account read as unlicensed.
        const response = await authApi.entitlements();
        const entitlements = response?.data ?? response ?? {};
        database.setEntitlements(entitlements);
        return { ...entitlements, stale: false, allowance: database.unitAllowanceStatus() };
      } catch (error) {
        // Offline is expected, not an error: report the cached copy and say it is cached.
        const cached = database.entitlements();
        return {
          ...(cached ?? { paid: false, planName: "Бесплатный", unitLimit: 1, features: [] }),
          stale: true,
          error: error?.message ?? String(error),
          allowance: database.unitAllowanceStatus(),
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

    handle("dashboard:get", () => database.dashboard());
    handle("calendar:get", (payload) => database.calendar(payload?.days ?? 14));
  // The renderer is sandboxed and cannot load modules, so the month count a tenancy displays
  // is computed here, where the shared booking-policy module already lives. One
  // implementation, pinned in both languages by fixtures/rental-terms-cases.json.
  handle("reservations:list", () => database.listReservations().map((reservation) => ({
    ...reservation,
    rental_months: reservation.booking_kind === "rental"
      ? wholeMonthsBetween(reservation.check_in_date, reservation.check_out_date)
      : 0,
  })));

    handle("places:list", (payload) => database.listPlaces(payload));
    handle("places:create", (payload) => database.createPlace(payload));
    handle("places:update", (payload) => database.updatePlace(payload.id, payload.data));
    handle("places:archive", (payload) => database.archivePlace(payload.id));
    handle("places:restore", (payload) => database.restorePlace(payload.id));

    handle("properties:list", (payload) => database.listProperties(payload));
    handle("properties:create", (payload) => database.createProperty(payload));
    handle("properties:update", (payload) => database.updateProperty(payload.id, payload.data));
    handle("properties:archive", (payload) => database.archiveProperty(payload.id));
    handle("properties:restore", (payload) => database.restoreProperty(payload.id));

    handle("reservations:create", (payload) => database.createReservation(payload));
    handle("reservations:update", (payload) => database.updateReservation(payload.id, payload.data));
    handle("reservations:cancel", (payload) => database.cancelReservation(payload.id));
    handle("reservations:delete", (payload) => database.deleteReservation(payload.id));
    handle("reservations:earlyCheckout", (payload) => database.earlyCheckout(payload.id, payload.data));

    handle("backups:list", () => database.listBackups());
    handle("backups:create", () => database.createBackup());
    handle("system:info", () => database.systemInfo());
    handle("system:setLanguage", (payload) => {
      const language = database.setLanguage(payload?.language);
      createMenu(language);
      return language;
    });
    handle("system:openBackupDirectory", async () => {
      const error = await shell.openPath(database.systemInfo().backupDir);
      if (error) throw new Error(error);
      return true;
    });
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

  function createMenu(language = database?.getLanguage() || "ru") {
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
