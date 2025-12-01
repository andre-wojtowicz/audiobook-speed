const fs = require("fs");
const path = require("path");

function cp(src, dst) {
    if (!fs.existsSync(src)) {
        console.log("❌ brak", src);
        return;
    }
    fs.copyFileSync(src, dst);
    console.log("✓", dst);
}

const out = "public/libs/ffmpeg";
fs.mkdirSync(out, { recursive: true });

// z @ffmpeg/ffmpeg
const ffmpegESM = "node_modules/@ffmpeg/ffmpeg/dist/esm";

[
    "classes.js",
    "types.js",
    "utils.js",
    "const.js",
    "errors.js",
    "worker.js"
].forEach(f =>
    cp(path.join(ffmpegESM, f), path.join(out, f))
);

// z @ffmpeg/core
cp("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js",  `${out}/ffmpeg-core.js`);
cp("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", `${out}/ffmpeg-core.wasm`);

console.log("\nFFmpeg WASM gotowe.");
