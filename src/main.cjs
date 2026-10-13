const { app, BrowserWindow, ipcMain, Menu, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { DomBookDatabase } = require("./database.cjs");
const { createAuthApi } = require("./main/auth.cjs");
const { createAuthSessionStore } = require("./main/auth-session.cjs");
const { createSyncEngine } = require("./main/sync.cjs");
const { nowIso } = require("./database.cjs");

let mainWindow;
let database;
let authApi;
let syncEngine;
// Serialises sync attempts and schedules the periodic one.
let syncTimer = null;

app.setName("DomBook");
app.setPath("userData", path.join(app.getPath("appData"), "dombook-desktop"));

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

function handle(channel, action) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return ok(await action(payload));
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
  handle("bookingPolicy:get", async (_payload, ) => {
    try {
      const policy = await authApi.bookingPolicy();
      database.setBookingPolicy(policy);
      const cached = database.bookingPolicy();
      return ok({ ...policy, ...cached });
    } catch (error) {
      // Offline is a normal state, not a failure: report the cached window so the UI keeps
      // working and say that it is cached.
      return ok({ ...database.bookingPolicy(), stale: true, error: error?.message ?? String(error) });
    }
  });

  handle("bookingPolicy:set", async (payload) => {
    const policy = await authApi.setBookingPolicy(payload ?? {});
    database.setBookingPolicy(policy);
    return ok({ ...policy, ...database.bookingPolicy() });
  });

  // Cached locally so the client can explain the account's limits without a round trip, and
  // so an offline device keeps working.
  handle("entitlements:get", async () => {
    try {
      const entitlements = await authApi.entitlements();
      database.setEntitlements(entitlements);
      return ok({ ...entitlements, stale: false, allowance: database.unitAllowanceStatus() });
    } catch (error) {
      // Offline is expected, not an error: report the cached copy and say it is cached.
      const cached = database.entitlements();
      return ok({
        ...(cached ?? { paid: false, planName: "Бесплатный", unitLimit: 1, features: [] }),
        stale: true,
        error: error?.message ?? String(error),
        allowance: database.unitAllowanceStatus(),
      });
    }
  });

  handle("sync:now", async () => {
    if (!syncEngine) return { ok: false, error: "Синхронизация не настроена" };
    return syncEngine.sync();
  });
  handle("sync:status", async () => ({
    pending: database?.pendingSyncCount?.() ?? 0,
    lastResult: syncEngine?.lastResult?.() ?? null,
    cursor: syncEngine?.readWatermark?.() ?? 0,
  }));

  handle("dashboard:get", () => database.dashboard());
  handle("calendar:get", (payload) => database.calendar(payload?.days ?? 14));

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

  handle("reservations:list", () => database.listReservations());
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
  const rendererUrl = pathToFileURL(rendererPath).href;
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f7f5",
    title: "DomBook",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault();
  });
  mainWindow.loadFile(rendererPath);
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function createMenu(language = database?.getLanguage() || "ru") {
  const labels = {
    ru: {
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
  }[language] || null;
  const appMenu = process.platform === "darwin"
    ? [
        { role: "about", label: labels.about },
        { type: "separator" },
        { role: "quit", label: labels.quit },
      ]
    : [{ role: "quit", label: labels.quit }];
  const template = [
    {
      label: process.platform === "darwin" ? "DomBook" : "Файл",
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
  const iconPath = path.join(__dirname, "assets", "dombook-icon-transparent.png");
  if (process.platform === "darwin") app.dock.setIcon(iconPath);
  const userData = app.getPath("userData");
  database = await new DomBookDatabase({
    filePath: path.join(userData, "dombook.sqlite"),
    backupDir: path.join(userData, "backups"),
    seed: true,
  }).init();
  const baseUrl = process.env.DOMBOOK_API_URL || "http://127.0.0.1:8787";
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (syncTimer) clearInterval(syncTimer);
  database?.close();
});
