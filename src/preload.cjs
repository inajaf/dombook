const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("domBook", {
  dashboard: {
    get: () => invoke("dashboard:get"),
  },
  calendar: {
    get: (days) => invoke("calendar:get", { days }),
  },
  places: {
    list: (options) => invoke("places:list", options),
    create: (data) => invoke("places:create", data),
    update: (id, data) => invoke("places:update", { id, data }),
    archive: (id) => invoke("places:archive", { id }),
    restore: (id) => invoke("places:restore", { id }),
  },
  properties: {
    list: (options) => invoke("properties:list", options),
    create: (data) => invoke("properties:create", data),
    update: (id, data) => invoke("properties:update", { id, data }),
    archive: (id) => invoke("properties:archive", { id }),
    restore: (id) => invoke("properties:restore", { id }),
  },
  reservations: {
    list: () => invoke("reservations:list"),
    create: (data) => invoke("reservations:create", data),
    update: (id, data) => invoke("reservations:update", { id, data }),
    cancel: (id) => invoke("reservations:cancel", { id }),
    delete: (id) => invoke("reservations:delete", { id }),
    earlyCheckout: (id, data) => invoke("reservations:earlyCheckout", { id, data }),
  },
  backups: {
    list: () => invoke("backups:list"),
    create: () => invoke("backups:create"),
  },
  system: {
    info: () => invoke("system:info"),
    openBackupDirectory: () => invoke("system:openBackupDirectory"),
  },
});
