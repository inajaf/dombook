const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "src", "renderer");
const outputDir = path.join(projectRoot, "release", "web");

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outputDir), { recursive: true });
fs.cpSync(sourceDir, outputDir, { recursive: true });

fs.writeFileSync(path.join(outputDir, "WEB-README.txt"), [
  "DomBook Web 0.2.0",
  "",
  "Run this folder through a local static web server.",
  "Example: python3 -m http.server 8080 --directory web",
  "Then open http://127.0.0.1:8080/",
  "",
  "Web data is stored in this browser only. Export JSON backups regularly.",
  "For SQLite storage and automatic local backups use the desktop edition.",
  "",
].join("\n"));

console.log(`Web build created at ${outputDir}`);
