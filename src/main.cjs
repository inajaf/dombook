const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DomBookDatabase } = require("./database.cjs");

let mainWindow;
let database;

app.setName("ДомБук");

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
    title: "ДомБук",
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

function createMenu() {
  const appMenu = process.platform === "darwin"
    ? [
        { role: "about", label: "О программе" },
        { type: "separator" },
        { role: "quit", label: "Выйти" },
      ]
    : [{ role: "quit", label: "Выйти" }];
  const template = [
    {
      label: process.platform === "darwin" ? "ДомБук" : "Файл",
      submenu: appMenu,
    },
    {
      label: "Правка",
      submenu: [
        { role: "undo", label: "Отменить" },
        { role: "redo", label: "Повторить" },
        { type: "separator" },
        { role: "cut", label: "Вырезать" },
        { role: "copy", label: "Копировать" },
        { role: "paste", label: "Вставить" },
        { role: "selectAll", label: "Выбрать всё" },
      ],
    },
    {
      label: "Вид",
      submenu: [
        { role: "reload", label: "Перезагрузить" },
        { role: "togglefullscreen", label: "Полный экран" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools", label: "Инструменты разработчика" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  const iconPath = path.join(__dirname, "assets", "dombook-icon.png");
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
