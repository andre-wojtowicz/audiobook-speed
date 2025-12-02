const fs = require("fs");
const path = require("path");

function cp(src, dst) {
    if (!fs.existsSync(src)) {
        console.log("❌ not found", src);
        return;
    }
    fs.copyFileSync(src, dst);
    console.log("✓", dst);
}

const out = "public/libs";
fs.mkdirSync(out, { recursive: true });

const src = "node_modules/jszip/dist";

cp(path.join(src, "jszip.min.js"), path.join(out, "jszip.min.js"));

console.log("\nJSZip ready.");
