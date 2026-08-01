const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DomBookDatabase } = require("./database.cjs");

let mainWindow;
let database;

app.setName("DomBook");
app.setPath("userData", path.join(app.getPath("appData"), "dombook-desktop"));

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
  registerIpc();
  createMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => database?.close());
