window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("fileInput").value = "";
    document.getElementById("speedInput").value = 1.3;
    document.getElementById("log").innerHTML = "";
});

function log(msg) {
    const box = document.getElementById("log");
    box.innerHTML += msg + "<br>";
    box.scrollTop = box.scrollHeight;
}

document.getElementById("convertBtn").addEventListener("click", start);

async function start() {
    const files = document.getElementById("fileInput").files;
    if (!files.length) {
        alert("Choose files");
        return;
    }

    const speed = parseFloat(document.getElementById("speedInput").value);
    if (!speed || speed <= 0) {
        alert("Invalid speed");
        return;
    }

    const { FFmpeg } = window.ffmpegModule;

    const ffmpeg = new FFmpeg();

    log("Loading FFmpeg...");
    await ffmpeg.load({
        coreURL: "./ffmpeg-core.js"
    });
    log("Loaded.");

    for (const file of files) {
        const inputName = file.name;
        const outputName = inputName.replace(/\.mp3$/i, `-x${speed}.mp3`);

	ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

        const filter = atempoChain(speed);

        log("Converting: " + inputName);

        await ffmpeg.exec([
            "-i", inputName,
            "-af", filter,
            "-codec:a", "libmp3lame",
            "-b:a", "128k",
            outputName
        ]);

        const data = await ffmpeg.readFile(outputName);

        downloadBlob(data.buffer, outputName);

        ffmpeg.deleteFile(inputName);
        ffmpeg.deleteFile(outputName);
    }

    log("Done!");
}

function atempoChain(speed) {
    const filters = [];
    let rest = speed;

    while (rest > 2.0) {
        filters.push("atempo=2.0");
        rest /= 2.0;
    }
    filters.push(`atempo=${rest}`);

    return filters.join(",");
}

function downloadBlob(buffer, name) {
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}
