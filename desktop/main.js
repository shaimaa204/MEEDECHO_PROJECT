// ==================================================
// main.js — Unified + Cleaned + Fully Working
// ==================================================

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const NotesHandler = require("./notes-handler");

let mainWindow;
let notesHandler;
global.sharedReportId = null;

// -----------------------------------------
// CREATE WINDOW
// -----------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile("index.html");
}

// -----------------------------------------
// ELECTRON LIFECYCLE
// -----------------------------------------
app.whenReady().then(() => {
  notesHandler = new NotesHandler();
  registerNotesHandlers();
  registerAppHandlers();
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// --------------------------------------------------
// REGISTER NOTES / CHECKLIST IPC
// --------------------------------------------------
function registerNotesHandlers() {
  ipcMain.handle("notes:load", () => notesHandler.loadData());
  ipcMain.handle("notes:saveNotes", (e, text) => notesHandler.updateNotes(text));
  ipcMain.handle("notes:addChecklistItem", (e, text) =>
    notesHandler.addChecklistItem(text)
  );
  ipcMain.handle("notes:toggleChecklistItem", (e, id) =>
    notesHandler.toggleChecklistItem(id)
  );
  ipcMain.handle("notes:deleteChecklistItem", (e, id) =>
    notesHandler.deleteChecklistItem(id)
  );
}

// --------------------------------------------------
// APP NAVIGATION + PYTHON EXECUTION + PHASES
// --------------------------------------------------
function registerAppHandlers() {
  // Open Phase 1
  ipcMain.on("open-phase1", () => {
    if (mainWindow) mainWindow.loadFile("phase1.html");
  });

  // Open Phase 2
  ipcMain.on("open-phase2", (e, reportId) => {
    global.sharedReportId = reportId;
    if (mainWindow) mainWindow.loadFile("phase2.html");
  });

  // Python runner
  ipcMain.handle("run-python", async (event, args) => {
    return new Promise((resolve) => {
      const pythonProcess = spawn("python", args);

      let output = "";
      let errorOutput = "";

      pythonProcess.stdout.on("data", (data) => {
        output += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      pythonProcess.on("close", () => {
        if (errorOutput) {
          resolve("ERROR: " + errorOutput);
        } else {
          resolve(output);
        }
      });
    });
  });

  // Shared ID (Phase 2)
  ipcMain.handle("get-shared-id", () => global.sharedReportId);
}

