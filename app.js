// ===== GLOBAL =====
let ffmpeg = null;
let currentFiles = [];
let convertedCache = {};
let probeCache = {};
let zipInstance = new JSZip();
let globalProcessed = 0;
let isProcessing = false;

// ===== DOM =====
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const dropZone = document.getElementById("dropZone");
const logEl = document.getElementById("log");
const speedInput = document.getElementById("speedInput");
const speedValue = document.getElementById("speedValue");
const timeSummaryEl = document.getElementById("timeSummary");
const convertBtn = document.getElementById("convertBtn");
const zipBtn = document.getElementById("zipBtn");
const clearBtn = document.getElementById("clearBtn");
const statusSmall = document.getElementById("statusSmall");
const controlsTime = document.querySelector(".controls-time");
const controlsButtons = document.querySelector(".controls-buttons");
const globalProgressWrap = document.getElementById("globalProgressWrap");
const globalProgress = document.getElementById("globalProgress");
const filesPanel = document.querySelector(".files-panel");
const globalStatus = document.getElementById("globalStatus");
const panels = [dropZone, filesPanel, controlsTime, controlsButtons, document.querySelector(".log-panel")];

// HELPERS
function log(msg) {
    const t = new Date().toLocaleTimeString();
    logEl.innerHTML += `[${t}] ${msg}<br>`;
    logEl.scrollTop = logEl.scrollHeight;
}
function escapeHtml(s){ 
    return String(s||"").replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); 
}
function safeCopy(u8){ return new Uint8Array(u8.buffer.slice(0)); }
function formatTime(sec){
    if(!sec||sec<=0) return "00:00:00";
    const h=Math.floor(sec/3600);
    const m=Math.floor((sec%3600)/60);
    const s=Math.floor(sec%60);
    return `${h.toString().padStart(2,"0")}:${m.toString().padStart(2,"0")}:${s.toString().padStart(2,"0")}`;
}
function formatSize(b){ return (b/1024/1024).toFixed(2)+" MB"; }

// FFMPEG LOADING
async function loadFFmpeg(){ 
    if(ffmpeg) return ffmpeg;
    log("Loading FFmpeg...");
    const { FFmpeg } = window.ffmpegModule;
    ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL: "./ffmpeg-core.js" });
    log("FFmpeg ready.");
    return ffmpeg;
}

// ID3v2 parser (v2.2/2.3/2.4)
function parseID3Tags(arrayBuffer){
    const u8 = new Uint8Array(arrayBuffer);
    if(u8.length < 10) return {};
    if(u8[0]!==0x49||u8[1]!==0x44||u8[2]!==0x33) return {};
    const ver = u8[3];
    const size = ((u8[6]&0x7f)<<21)|((u8[7]&0x7f)<<14)|((u8[8]&0x7f)<<7)|(u8[9]&0x7f);
    let offset = 10;
    const end = 10+size;
    const tags = {};

    while(offset+10 <= Math.min(u8.length,end)){
        let id = String.fromCharCode(u8[offset],u8[offset+1],u8[offset+2],u8[offset+3]);
        let frameSize = (u8[offset+4]<<24)|(u8[offset+5]<<16)|(u8[offset+6]<<8)|(u8[offset+7]);
        let headerLen = 10;

        if(ver===2){
            id = String.fromCharCode(u8[offset],u8[offset+1],u8[offset+2]);
            frameSize = (u8[offset+3]<<16)|(u8[offset+4]<<8)|(u8[offset+5]);
            headerLen = 6;
        }

        if(!id.trim()) break;
        const frameOffset = offset + headerLen;
        if(frameOffset + frameSize > u8.length) break;
        const frameData = u8.slice(frameOffset, frameOffset + frameSize);

        if(id[0]==="T"){
            let text = "";
            if(frameData.length>0){
                const enc = frameData[0];
                try{
                    if(enc===0 || enc===3) 
                        text = new TextDecoder(enc===3?"utf-8":"iso-8859-1").decode(frameData.slice(1));
                    else 
                        text = new TextDecoder("utf-16").decode(frameData.slice(1));
                }catch(e){}
            }
            const clean = text.replace(/\0/g,"").trim();

            if(id==="TIT2"||id==="TT2") tags.title = tags.title || clean;
            if(id==="TPE1"||id==="TP1") tags.artist = tags.artist || clean;
            if(id==="TALB"||id==="TAL") tags.album = tags.album || clean;
        }
        offset = frameOffset + frameSize;
    }
    return { title: tags.title||"", artist: tags.artist||"", album: tags.album||"" };
}

// PROBE MP3 (duration, bitrate, title, author)
async function probeFile(file){
    if(probeCache[file.name]) return probeCache[file.name];

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const id3 = parseID3Tags(buf);

    let offset = 0;
    if(bytes[0]===0x49&&bytes[1]===0x44&&bytes[2]===0x33){
        const size = (bytes[6]&0x7F)*0x200000 + (bytes[7]&0x7F)*0x4000 + (bytes[8]&0x7F)*0x80 + (bytes[9]&0x7F);
        offset = 10 + size;
    }

    let duration = 0;
    let bitrate = 0;
    const bitrateTable = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
    const sampleRateTable = [44100,48000,32000,0];

    while(offset < bytes.length - 4){
        if(bytes[offset]===0xFF && (bytes[offset+1]&0xE0)===0xE0){
            const ver = (bytes[offset+1]>>3)&0x03;
            const layer = (bytes[offset+1]>>1)&0x03;
            const bitrateIdx = (bytes[offset+2]>>4)&0x0F;
            const sampleIdx = (bytes[offset+2]>>2)&0x03;
            if(ver===3 && layer===1){
                const br = bitrateTable[bitrateIdx];
                const sr = sampleRateTable[sampleIdx];
                if(br>0 && sr>0){
                    const frameDuration = 1152 / sr;
                    duration += frameDuration;
                    bitrate = br;
                    offset += Math.floor(144000 * br / sr);
                    continue;
                }
            }
        }
        offset++;
    }

    const meta = {
        duration,
        bitrate: bitrate||128,
        title: id3.title || file.name.replace(/\.mp3$/i,""),
        author: id3.artist || "",
        album: id3.album || ""
    };

    probeCache[file.name] = meta;
    return meta;
}

// RENDER FILE LIST
async function renderFileList(){
    if(!currentFiles.length){
        fileListEl.innerHTML = `<div class="muted">No files selected</div>`;
        filesPanel.style.display = "none";
        clearBtn.style.display = "none";
        updateTimeSummary();
        updateUIState();
        return;
    }

    filesPanel.style.display = "block";
    clearBtn.style.display = "inline-block";

    fileListEl.innerHTML = "";
    let totalOriginal = 0;

    for(const file of currentFiles){
        const info = await probeFile(file);
        totalOriginal += info.duration;

        const item = document.createElement("div");
        item.className = "file-item";

        item.innerHTML = `
            <div style="display:flex; width:100%; align-items:flex-start;">
                <div class="file-meta" style="flex:1;">
                    <div class="filename">${escapeHtml(file.name)}</div>
                    <div class="small-muted"><b>Author</b>: ${escapeHtml(info.author || "Unknown")}</div>
                    <div class="small-muted"><b>Album</b>: ${escapeHtml(info.album || "Unknown")}</div>
                    <div class="small-muted"><b>Title</b>: ${escapeHtml(info.title || "Unknown")}</div>
                    <div class="small-muted">
                        <b>Duration</b>: ${formatTime(info.duration)} |
                        <b>Size</b>: ${formatSize(file.size)} |
                        <b>Bitrate</b>: ${info.bitrate} kbps
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end;">
                    <div class="file-delete" data-name="${escapeHtml(file.name)}" title="Remove file">×</div>
                </div>
            </div>
            <div class="progress-wrap"><div class="progress"></div></div>
            <div class="small-muted file-status">Ready</div>
        `;

        const deleteBtn = item.querySelector(".file-delete");
        deleteBtn.addEventListener("click", () => {
            currentFiles = currentFiles.filter(f => f.name !== file.name);
            delete probeCache[file.name];
            delete convertedCache[file.name];
            renderFileList();
            updateUIState();
            log(`Removed ${file.name}`);
            // ensure file input cleared if no files left
            if(currentFiles.length === 0) fileInput.value = "";
        });

        fileListEl.appendChild(item);
    }

    updateTimeSummary();
    updateUIState();
}

// TIME SUMMARY
function updateTimeSummary(){
    let totalBefore = 0;
    for(const f of currentFiles){
        const p = probeCache[f.name];
        if(p) totalBefore += p.duration;
    }

    const speed = parseFloat(speedInput.value);
    const totalBeforeSeconds = Math.floor(totalBefore);
    const totalAfterSeconds = Math.floor(totalBeforeSeconds / speed);
    const diff = totalAfterSeconds - totalBeforeSeconds;
    const diffClass = diff > 0 ? "diff-positive" : diff < 0 ? "diff-negative" : "diff-zero";
    const diffLabel = diff > 0 ? "+" + formatTime(diff) : diff < 0 ? "-" + formatTime(Math.abs(diff)) : formatTime(0);

    timeSummaryEl.innerHTML =
        `<strong>Total before conversion:</strong> ${formatTime(totalBeforeSeconds)} | ` +
        `<strong>Total after conversion:</strong> ${formatTime(totalAfterSeconds)} | ` +
        `<strong>Difference:</strong> <span class="${diffClass}">${diffLabel}</span>`;
}

function updateSpeedDisplay(){
    const val = parseFloat(speedInput.value);
    const min = parseFloat(speedInput.min);
    const max = parseFloat(speedInput.max);
    const pct = Math.min(1, Math.max(0, (val - min) / (max - min)));

    speedValue.textContent = "x" + val.toFixed(2);
    speedValue.style.left = `${pct * 100}%`;
}

// ADD FILES
async function addFiles(files){
    const existing = new Set(currentFiles.map(f=>f.name));
    const addedNames = [];

    for(const f of files){
        if(!existing.has(f.name)){
            currentFiles.push(f);
            addedNames.push(f.name);
        }
    }

    if(addedNames.length){
        const count = addedNames.length;
        const word = count === 1 ? "file" : "files";
        log(`${count} ${word} added: ${addedNames.join(", ")}`);
    }

    await renderFileList();
    updateUIState();
}

// DRAG & DROP
["dragenter","dragover"].forEach(ev=>{
    dropZone.addEventListener(ev,e=>{
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add("dragover");
    });
});
["dragleave","drop"].forEach(ev=>{
    dropZone.addEventListener(ev,e=>{
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove("dragover");
    });
});
dropZone.addEventListener("drop", e=>{
    const files = Array.from(e.dataTransfer.files).filter(f=>f.name.toLowerCase().endsWith(".mp3"));
    if(!files.length) return alert("Only MP3 files allowed");
    addFiles(files);
});

// FILE INPUT
fileInput.addEventListener("change", e=>{
    addFiles(Array.from(e.target.files));
    // clear the input value to avoid browser caching selection (we still store File objects in currentFiles)
    fileInput.value="";
});

// SPEED SLIDER
speedInput.addEventListener("input", ()=>{
    updateSpeedDisplay();
    updateTimeSummary();
});

// atempo builder
function buildAtempo(speed){
    const parts=[];
    let s=speed;
    while(s>2.0){
        parts.push("atempo=2.0");
        s/=2.0;
    }
    parts.push(`atempo=${s}`);
    return parts.join(",");
}

// CONVERT SINGLE
// added onProgress callback: function(percent) where percent is 0..100 representing progress for this file
async function convertSingle(file, progressBar, statusEl, onProgress){
    const info = await probeFile(file);
    const speed = parseFloat(speedInput.value);
    const inputName = file.name;
    const outputName = inputName.replace(/\.mp3$/i, `-x${speed}.mp3`);

    const buf = await file.arrayBuffer();
    const inputData = safeCopy(new Uint8Array(buf));
    await ffmpeg.writeFile(inputName, inputData);

    let fallbackInterval = null;
    let loggerWasSet = false;
    let lastPct = 0;

    function parseTimeFromLine(line){
        const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if(!m) return null;
        const h=Number(m[1]), mm=Number(m[2]), ss=Number(m[3]);
        return h*3600+mm*60+ss;
    }

    if(ffmpeg && typeof ffmpeg.setProgress === "function"){
        try{
            ffmpeg.setProgress(({ratio})=>{
                const p=Math.max(0,Math.min(100,Math.round(ratio*100)));
                lastPct=p;
                progressBar.style.width=p+"%";
                statusEl.textContent=`Converting... ${p}%`;
                if(typeof onProgress === "function") onProgress(p);
            });
        }catch(e){}
    }

    if((!ffmpeg || typeof ffmpeg.setProgress !== "function") && ffmpeg && typeof ffmpeg.setLogger === "function"){
        try{
            ffmpeg.setLogger(({type,message})=>{
                const t=parseTimeFromLine(message);
                if(t!==null && info.duration>0){
                    let pct=Math.round((t/info.duration)*100);
                    pct=Math.max(0,Math.min(100,pct));
                    lastPct=pct;
                    progressBar.style.width=pct+"%";
                    statusEl.textContent=`Converting... ${pct}%`;
                    if(typeof onProgress === "function") onProgress(pct);
                }
            });
            loggerWasSet = true;
        }catch(e){}
    }

    if((!ffmpeg || typeof ffmpeg.setProgress !== "function") && !loggerWasSet){
        let fake = lastPct || 0;
        fallbackInterval = setInterval(()=>{
            fake = Math.min(95, fake + Math.floor(Math.random()*6)+2);
            progressBar.style.width = fake + "%";
            statusEl.textContent = `Converting... ${fake}%`;
            lastPct = fake;
            if(typeof onProgress === "function") onProgress(fake);
        }, 500);
    }

    try{
        await ffmpeg.exec([
            "-i", inputName,
            "-af", buildAtempo(speed),
            "-codec:a", "libmp3lame",
            "-b:a", (info.bitrate||128)+"k",
            "-map_metadata", "0",
            "-id3v2_version", "3",
            outputName
        ]);
    } finally {
        try{ if(typeof ffmpeg.setProgress === "function") ffmpeg.setProgress(()=>{}); }catch(e){}
        if(loggerWasSet && typeof ffmpeg.setLogger === "function"){
            try{ ffmpeg.setLogger(()=>{}); }catch(e){}
        }
        if(fallbackInterval){
            clearInterval(fallbackInterval);
            fallbackInterval = null;
        }
    }

    const out = await ffmpeg.readFile(outputName);

    try{ ffmpeg.deleteFile(inputName); }catch(e){}
    try{ ffmpeg.deleteFile(outputName); }catch(e){}

    progressBar.style.width = "100%";
    statusEl.textContent = `Done (${formatSize(out.length)})`;
    if(typeof onProgress === "function") onProgress(100);

    return out;
}

// MAIN CONVERT
convertBtn.addEventListener("click", async () => {
    if (!currentFiles.length) return alert("No files selected");
    await loadFFmpeg();
    log("Starting conversion...");

    setProcessingState(true);

    try {
        const items = Array.from(fileListEl.querySelectorAll(".file-item"));
        for (const item of items) {
            const bar = item.querySelector(".progress");
            const statusEl = item.querySelector(".file-status");
            bar.style.width = "0%";
            statusEl.textContent = "Ready";
        }
        convertedCache = {};
        globalProcessed = 0;

        const totalFiles = currentFiles.length;
        const perFilePct = 100 / totalFiles;

        globalProgressWrap.style.display = "block";
        globalProgress.style.width = "0%";
        globalStatus.textContent = `Ready`;

        let idx = 0;
        for (const file of currentFiles) {
            const item = items[idx++];
            const statusEl = item.querySelector(".file-status");
            const wrap = item.querySelector(".progress-wrap");
            const bar = item.querySelector(".progress");

            wrap.style.display = "block";
            bar.style.width = "0%";
            statusEl.textContent = "Preparing...";

            const basePct = Math.round(globalProcessed * perFilePct);
            globalProgress.style.width = basePct + "%";
            globalStatus.textContent = `${globalProcessed + 1}/${totalFiles} Converting... ${basePct}%`;

            try {
                const result = await convertSingle(file, bar, statusEl, (localPct) => {
                    const combined = Math.round((globalProcessed * perFilePct) + (localPct / 100) * perFilePct);
                    globalProgress.style.width = combined + "%";
                    globalStatus.textContent = `${globalProcessed + 1}/${totalFiles} Converting... ${combined}%`;
                });

                statusEl.textContent = "Done";
                bar.style.width = "100%";

                const blob = new Blob([result.buffer], { type: "audio/mpeg" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = file.name.replace(/\.mp3$/i, `-x${speedInput.value}.mp3`);
                a.click();
                URL.revokeObjectURL(url);

                convertedCache[file.name] = result;

                globalProcessed++;
                const newBasePct = Math.round(globalProcessed * perFilePct);
                globalProgress.style.width = newBasePct + "%";

                if (globalProcessed < totalFiles) {
                    globalStatus.textContent = `${globalProcessed}/${totalFiles} Converting... ${newBasePct}%`;
                } else {
                    globalStatus.textContent = `Done – 100%`;
                }

            } catch (e) {
                console.error(e);
                statusEl.textContent = "ERROR";
                globalStatus.textContent = `ERROR converting ${file.name}`;
                log("Error converting " + file.name + ": " + (e.message || e));
            }
        }

        log("All conversions finished.");
        globalProgress.style.width = "100%";
        globalStatus.textContent = "Done";
    } finally {
        setProcessingState(false);
    }
});


// DOWNLOAD ZIP
zipBtn.addEventListener("click", async ()=>{
    if(!currentFiles.length) return alert("No files selected");
    await loadFFmpeg();

    setProcessingState(true);

    try {
        zipInstance = new JSZip();
        log("Creating ZIP...");

        const items = Array.from(fileListEl.querySelectorAll(".file-item"));
        for (const item of items) {
            const bar = item.querySelector(".progress");
            const statusEl = item.querySelector(".file-status");
            bar.style.width = "0%";
            statusEl.textContent = "Ready";
        }
        globalProcessed = 0;

        const totalFiles = currentFiles.length;
        const perFilePct = 100 / totalFiles;

        globalProgressWrap.style.display = "block";
        globalProgress.style.width = "0%";
        globalStatus.textContent = "Ready";

        let idx = 0;
        for (const file of currentFiles) {
            const item = items[idx++];
            const statusEl = item.querySelector(".file-status");
            const wrap = item.querySelector(".progress-wrap");
            const bar = item.querySelector(".progress");

            wrap.style.display = "block";
            bar.style.width = "0%";
            statusEl.textContent = "Preparing...";

            const basePct = Math.round(globalProcessed * perFilePct);
            globalProgress.style.width = basePct + "%";
            globalStatus.textContent = `${globalProcessed + 1}/${totalFiles} Converting... ${basePct}%`;

            try {
                const result = await convertSingle(file, bar, statusEl, (localPct) => {
                    const combined = Math.round((globalProcessed * perFilePct) + (localPct / 100) * perFilePct);
                    globalProgress.style.width = combined + "%";
                    globalStatus.textContent = `${globalProcessed + 1}/${totalFiles} Converting... ${combined}%`;
                });

                statusEl.textContent = "Done";
                bar.style.width = "100%";

                const outName = file.name.replace(/\.mp3$/i, `-x${speedInput.value}.mp3`);
                zipInstance.file(outName, result);

                globalProcessed++;
                const newBasePct = Math.round(globalProcessed * perFilePct);
                globalProgress.style.width = newBasePct + "%";

                if (globalProcessed < totalFiles) {
                    globalStatus.textContent = `${globalProcessed}/${totalFiles} Converting... ${newBasePct}%`;
                } else {
                    globalStatus.textContent = `Done – 100%`;
                }
            } catch (e) {
                console.error(e);
                statusEl.textContent = "ERROR";
                globalStatus.textContent = `ERROR converting ${file.name}`;
                log("Error converting " + file.name + ": " + (e.message || e));
            }
        }

        try {
            const blob = await zipInstance.generateAsync({type:"blob"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "converted.zip";
            a.click();
            URL.revokeObjectURL(url);
            log("ZIP ready.");
        } catch (e) {
            log("Error generating ZIP: " + (e.message || e));
        }

        globalStatus.textContent = "Done";
        globalProgress.style.width = "100%";
    } finally {
        setProcessingState(false);
    }
});


// CLEAR ALL FILES
clearBtn.addEventListener("click", ()=>{
    currentFiles = [];
    probeCache = {};
    convertedCache = {};
    zipInstance = new JSZip();

    fileListEl.innerHTML = `<div class="muted">No files selected</div>`;
    filesPanel.style.display = "none";
    clearBtn.style.display = "none";

    // IMPORTANT: actually clear file input value so browser forgets selected files
    try { fileInput.value = ""; } catch(e){ /* ignore */ }

    // reset global progress/status
    globalProgress.style.width = "0%";
    globalProgressWrap.style.display = "none";
    globalStatus.textContent = "Ready";

    updateTimeSummary();
    updateUIState();
    log("Cleared all files.");
});

// UI state helper
function updateUIState() {
    const hasFiles = currentFiles.length > 0;

    convertBtn.disabled = isProcessing || !hasFiles;
    zipBtn.disabled = isProcessing || !hasFiles;

    globalProgressWrap.style.display = hasFiles ? "block" : "none";
    globalProgress.style.width = "0%";

    clearBtn.style.display = hasFiles ? "inline-block" : "none";
    controlsTime.classList.toggle("hidden", !hasFiles);
    controlsButtons.classList.toggle("hidden", !hasFiles);
}

function setProcessingState(processing) {
    isProcessing = processing;
    const toggle = processing ? "add" : "remove";

    panels.forEach(p => {
        if (p) p.classList[toggle]("panel-disabled");
    });

    [fileInput, speedInput, convertBtn, zipBtn, clearBtn].forEach(el => {
        if (el) el.disabled = processing || (el === convertBtn || el === zipBtn ? !currentFiles.length : false);
    });

    updateUIState();
}

// INIT
window.addEventListener("DOMContentLoaded", async () => {
    // ensure all internal state is clean on page load
    currentFiles = [];
    probeCache = {};
    convertedCache = {};
    zipInstance = new JSZip();
    fileInput.value = "";

    speedInput.value = 1.30;
    updateSpeedDisplay();
    updateTimeSummary();
    updateUIState();
    await loadFFmpeg();

    // set initial global status
    globalStatus.textContent = "Ready";
});
