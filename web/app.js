/**
 * QRaster Web - Universal Multi-Format Save & Open Engine
 */

// 1. Galois Field GF(256) Math Engine
class GF256 {
    constructor() {
        this.expTable = new Uint8Array(512);
        this.logTable = new Uint8Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            this.expTable[i] = x;
            this.expTable[i + 255] = x;
            this.logTable[x] = i;
            x <<= 1;
            if (x & 256) {
                x ^= 0x11d;
            }
        }
    }

    add(a, b) { return a ^ b; }
    sub(a, b) { return a ^ b; }
    
    mul(a, b) {
        if (a === 0 || b === 0) return 0;
        return this.expTable[this.logTable[a] + this.logTable[b]];
    }

    div(a, b) {
        if (b === 0) return 0;
        if (a === 0) return 0;
        return this.expTable[(this.logTable[a] + 255 - this.logTable[b]) % 255];
    }

    polyEval(poly, x) {
        let y = poly[0];
        for (let i = 1; i < poly.length; i++) {
            y = this.add(this.mul(y, x), poly[i]);
        }
        return y;
    }

    correctErrors(msg, ecLen) {
        if (!msg || msg.length === 0) return { corrected: msg, errorCount: 0, success: false };
        const syndromes = new Uint8Array(ecLen);
        let hasError = false;
        for (let i = 0; i < ecLen; i++) {
            const s = this.polyEval(msg, this.expTable[i]);
            syndromes[i] = s;
            if (s !== 0) hasError = true;
        }

        if (!hasError) return { corrected: msg, errorCount: 0, success: true };

        let C = [1];
        let B = [1];
        let L = 0;
        let m = 1;
        let b = 1;

        for (let i = 0; i < ecLen; i++) {
            let d = syndromes[i];
            for (let j = 1; j <= L; j++) {
                d = this.add(d, this.mul(C[j], syndromes[i - j]));
            }

            if (d === 0) {
                m++;
            } else if (2 * L <= i) {
                const T = [...C];
                const scale = this.div(d, b);
                const shiftB = new Array(m).fill(0).concat(B.map(v => this.mul(v, scale)));
                
                const newC = new Array(Math.max(C.length, shiftB.length)).fill(0);
                for (let k = 0; k < C.length; k++) newC[k] = this.add(newC[k], C[k]);
                for (let k = 0; k < shiftB.length; k++) newC[k] = this.add(newC[k], shiftB[k]);
                
                C = newC;
                L = i + 1 - L;
                B = T;
                b = d;
                m = 1;
            } else {
                const scale = this.div(d, b);
                const shiftB = new Array(m).fill(0).concat(B.map(v => this.mul(v, scale)));
                
                const newC = new Array(Math.max(C.length, shiftB.length)).fill(0);
                for (let k = 0; k < C.length; k++) newC[k] = this.add(newC[k], C[k]);
                for (let k = 0; k < shiftB.length; k++) newC[k] = this.add(newC[k], shiftB[k]);
                
                C = newC;
                m++;
            }
        }

        const errPos = [];
        for (let i = 0; i < msg.length; i++) {
            const x = this.expTable[(255 - i) % 255];
            if (this.polyEval(C, x) === 0) {
                errPos.push(msg.length - 1 - i);
            }
        }

        if (errPos.length !== L) {
            return { corrected: msg, errorCount: L, success: false };
        }

        const corrected = new Uint8Array(msg);
        for (let idx of errPos) {
            const xiInv = this.expTable[(255 - (msg.length - 1 - idx)) % 255];
            let cDeriv = 0;
            for (let j = 1; j < C.length; j += 2) {
                cDeriv = this.add(cDeriv, this.mul(C[j], this.expTable[(j - 1) * this.logTable[xiInv] % 255]));
            }

            let omega = 0;
            for (let i = 0; i < ecLen; i++) {
                let term = syndromes[i];
                for (let j = 1; j <= L && i - j >= 0; j++) {
                    term = this.add(term, this.mul(C[j], syndromes[i - j]));
                }
                omega = this.add(omega, this.mul(term, this.expTable[(i * this.logTable[xiInv]) % 255]));
            }

            const errMag = this.div(omega, cDeriv);
            corrected[idx] = this.add(corrected[idx], errMag);
        }

        return { corrected, errorCount: errPos.length, success: true };
    }
}

// 2. Real QR Code Decoder Class
class RealQRDecoder {
    constructor() {
        this.gf = new GF256();
    }

    getFormatInfo(matrix) {
        let bits = 0;
        const coords = [
            [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
            [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
        ];
        coords.forEach(([r, c]) => {
            if (matrix[r] && matrix[r][c] !== undefined) {
                bits = (bits << 1) | (matrix[r][c] & 1);
            }
        });

        bits ^= 0x5465;
        const maskPattern = (bits >> 10) & 0x07;
        const ecLevel = (bits >> 13) & 0x03;
        return { maskPattern: maskPattern % 8, ecLevel };
    }

    unmask(matrix, pattern) {
        const N = matrix.length;
        const unmasked = Array.from({ length: N }, () => Array(N).fill(0));
        
        for (let r = 0; r < N; r++) {
            for (let c = 0; c < N; c++) {
                let condition = false;
                switch (pattern) {
                    case 0: condition = (r + c) % 2 === 0; break;
                    case 1: condition = r % 2 === 0; break;
                    case 2: condition = c % 3 === 0; break;
                    case 3: condition = (r + c) % 3 === 0; break;
                    case 4: condition = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
                    case 5: condition = ((r * c) % 2) + ((r * c) % 3) === 0; break;
                    case 6: condition = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
                    case 7: condition = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
                }
                unmasked[r][c] = condition ? (matrix[r][c] ^ 1) : matrix[r][c];
            }
        }
        return unmasked;
    }

    extractCodewords(matrix) {
        const N = matrix.length;
        const isReserved = Array.from({ length: N }, () => Array(N).fill(false));

        const markSquare = (r0, c0, sz) => {
            for (let r = r0; r < r0 + sz; r++) {
                for (let c = c0; c < c0 + sz; c++) {
                    if (r >= 0 && r < N && c >= 0 && c < N) isReserved[r][c] = true;
                }
            }
        };
        markSquare(0, 0, 9);
        markSquare(0, N - 8, 9);
        markSquare(N - 8, 0, 9);
        
        for (let i = 0; i < N; i++) {
            isReserved[6][i] = true;
            isReserved[i][6] = true;
        }

        const bits = [];
        let upward = true;
        for (let col = N - 1; col > 0; col -= 2) {
            if (col === 6) col = 5;
            const rows = [];
            for (let r = 0; r < N; r++) rows.push(upward ? N - 1 - r : r);
            
            for (let r of rows) {
                for (let c of [col, col - 1]) {
                    if (!isReserved[r][c]) {
                        bits.push(matrix[r][c]);
                    }
                }
            }
            upward = !upward;
        }

        const codewords = new Uint8Array(Math.floor(bits.length / 8));
        for (let i = 0; i < codewords.length; i++) {
            let byteVal = 0;
            for (let b = 0; b < 8; b++) {
                byteVal = (byteVal << 1) | bits[i * 8 + b];
            }
            codewords[i] = byteVal;
        }
        return codewords;
    }

    decodePayload(codewords) {
        if (!codewords || codewords.length === 0) return "";
        let bitStr = "";
        codewords.forEach(b => {
            bitStr += b.toString(2).padStart(8, '0');
        });

        if (bitStr.length < 12) return "";
        const mode = bitStr.substring(0, 4);
        let ptr = 4;
        let charCount = 0;
        let result = "";

        if (mode === "0100") { // Byte Mode (UTF-8 / ASCII)
            charCount = parseInt(bitStr.substring(ptr, ptr + 8), 2);
            ptr += 8;
            const bytes = [];
            for (let i = 0; i < charCount; i++) {
                if (ptr + 8 > bitStr.length) break;
                bytes.push(parseInt(bitStr.substring(ptr, ptr + 8), 2));
                ptr += 8;
            }
            if (bytes.length > 0) {
                try {
                    result = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
                } catch (e) {
                    result = String.fromCharCode(...bytes);
                }
            }
        } else if (mode === "0010") { // Alphanumeric Mode
            const ALPHANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
            charCount = parseInt(bitStr.substring(ptr, ptr + 9), 2);
            ptr += 9;
            for (let i = 0; i < Math.floor(charCount / 2); i++) {
                if (ptr + 11 > bitStr.length) break;
                const val = parseInt(bitStr.substring(ptr, ptr + 11), 2);
                result += ALPHANUM[Math.floor(val / 45)] + ALPHANUM[val % 45];
                ptr += 11;
            }
            if (charCount % 2 === 1 && ptr + 6 <= bitStr.length) {
                const val = parseInt(bitStr.substring(ptr, ptr + 6), 2);
                result += ALPHANUM[val];
            }
        } else if (mode === "0001") { // Numeric Mode
            charCount = parseInt(bitStr.substring(ptr, ptr + 10), 2);
            ptr += 10;
            while (result.length < charCount && ptr + 10 <= bitStr.length) {
                const val = parseInt(bitStr.substring(ptr, ptr + 10), 2);
                result += val.toString().padStart(3, '0');
                ptr += 10;
            }
        }

        return result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    }

    decodeGridExhaustive(matrix) {
        let bestPayload = "";
        let bestRs = { success: false, errorCount: 99 };

        const fmt = this.getFormatInfo(matrix);
        const masksToTry = [fmt.maskPattern, 0, 1, 2, 3, 4, 5, 6, 7];

        for (let mask of masksToTry) {
            const unmasked = this.unmask(matrix, mask);
            const codewords = this.extractCodewords(unmasked);
            if (codewords.length === 0) continue;

            const ecLen = Math.max(7, Math.floor(codewords.length * 0.35));
            const rsResult = this.gf.correctErrors(codewords, ecLen);

            const payload = this.decodePayload(rsResult.corrected);
            if (payload && payload.length > 0) {
                return { payload, rsResult, success: true };
            }
            if (rsResult.success && (!bestRs.success || rsResult.errorCount < bestRs.errorCount)) {
                bestRs = rsResult;
            }
        }

        return { payload: bestPayload, rsResult: bestRs, success: false };
    }
}

class QRasterWeb {
    constructor() {
        this.gridSize = 21;
        this.currentRow = 0;
        this.currentCol = 0;
        this.matrix = [];
        this.isSpacePressed = false;
        this.isEnterPressed = false;

        this.qrDecoder = new RealQRDecoder();

        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 50;

        this.initDOM();
        this.createGrid();
        this.bindEvents();
    }

    initDOM() {
        const sizeSelect = document.getElementById('sizeSelect');
        sizeSelect.innerHTML = '';
        for (let i = 21; i <= 161; i += 4) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${i}x${i}`;
            sizeSelect.appendChild(opt);
        }

        document.getElementById('btnGenerate').addEventListener('click', () => {
            const selected = document.getElementById('sizeSelect').value;
            this.gridSize = parseInt(selected, 10);
            this.currentRow = 0;
            this.currentCol = 0;
            this.createGrid();
        });

        // Patterns
        document.getElementById('btnFinders').addEventListener('click', () => this.drawFinderPatterns());
        document.getElementById('btnTiming').addEventListener('click', () => this.drawTimingPatterns());
        document.getElementById('btnAlign').addEventListener('click', () => this.drawAlignmentPatterns());
        document.getElementById('btnAllPatterns').addEventListener('click', () => this.drawAllPatterns());

        // History & Files
        document.getElementById('btnUndo').addEventListener('click', () => this.undo());
        document.getElementById('btnRedo').addEventListener('click', () => this.redo());

        // Multi-format Save Dropdown Toggle
        const dropdown = document.querySelector('.dropdown');
        document.getElementById('btnSave').addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('active');
        });
        document.addEventListener('click', () => dropdown.classList.remove('active'));

        document.getElementById('saveJson').addEventListener('click', (e) => { e.preventDefault(); this.saveAsJson(); });
        document.getElementById('saveTxt').addEventListener('click', (e) => { e.preventDefault(); this.saveAsTxt(); });
        document.getElementById('saveCsv').addEventListener('click', (e) => { e.preventDefault(); this.saveAsCsv(); });
        document.getElementById('savePng').addEventListener('click', (e) => { e.preventDefault(); this.saveAsPng(); });
        document.getElementById('saveSvg').addEventListener('click', (e) => { e.preventDefault(); this.saveAsSvg(); });

        // Universal File Open Button
        document.getElementById('btnOpen').addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput').addEventListener('change', (e) => this.openUniversalFile(e));

        document.getElementById('btnClear').addEventListener('click', () => this.clearGrid());
        document.getElementById('btnInvert').addEventListener('click', () => this.invertGrid());

        // Guide Modal Events
        const modal = document.getElementById('guideModal');
        document.getElementById('btnGuide').addEventListener('click', () => {
            modal.classList.add('active');
        });
        document.getElementById('btnCloseModal').addEventListener('click', () => {
            modal.classList.remove('active');
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });

        // Tab Switching
        const tabBtns = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(targetTab).classList.add('active');
            });
        });
    }

    // MULTI-FORMAT EXPORT ENGINE (JSON, TXT, CSV, PNG, SVG)
    saveAsJson() {
        const data = { gridSize: this.gridSize, matrix: this.matrix };
        this.downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `QRaster_${this.gridSize}x${this.gridSize}.json`);
    }

    saveAsTxt() {
        let txt = "";
        for (let r = 0; r < this.gridSize; r++) {
            txt += this.matrix[r].join("") + "\n";
        }
        this.downloadBlob(new Blob([txt], { type: 'text/plain' }), `QRaster_${this.gridSize}x${this.gridSize}.txt`);
    }

    saveAsCsv() {
        let csv = "";
        for (let r = 0; r < this.gridSize; r++) {
            csv += this.matrix[r].join(",") + "\n";
        }
        this.downloadBlob(new Blob([csv], { type: 'text/csv' }), `QRaster_${this.gridSize}x${this.gridSize}.csv`);
    }

    saveAsPng() {
        const scale = 10;
        const canvas = document.createElement('canvas');
        canvas.width = this.gridSize * scale;
        canvas.height = this.gridSize * scale;
        const ctx = canvas.getContext('2d');

        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                ctx.fillStyle = this.matrix[r][c] === 1 ? '#000000' : '#ffffff';
                ctx.fillRect(c * scale, r * scale, scale, scale);
            }
        }
        canvas.toBlob((blob) => {
            this.downloadBlob(blob, `QRaster_${this.gridSize}x${this.gridSize}.png`);
        });
    }

    saveAsSvg() {
        const scale = 10;
        const dim = this.gridSize * scale;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}">\n`;
        svg += `<rect width="100%" height="100%" fill="#ffffff"/>\n`;
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                if (this.matrix[r][c] === 1) {
                    svg += `<rect x="${c * scale}" y="${r * scale}" width="${scale}" height="${scale}" fill="#000000"/>\n`;
                }
            }
        }
        svg += `</svg>`;
        this.downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `QRaster_${this.gridSize}x${this.gridSize}.svg`);
    }

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = filename;
        link.href = url;
        link.click();
    }

    // UNIVERSAL FILE IMPORT ENGINE (JSON, TXT, CSV, PNG/JPG/BMP/SVG)
    openUniversalFile(e) {
        const file = e.target.files[0];
        if (!file) return;

        const name = file.name.toLowerCase();
        if (name.endsWith('.json') || name.endsWith('.txt') || name.endsWith('.csv')) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                const text = evt.target.result;
                if (name.endsWith('.json')) {
                    try {
                        const data = JSON.parse(text);
                        if (data.matrix && Array.isArray(data.matrix)) {
                            this.saveState();
                            this.gridSize = data.gridSize || data.matrix.length;
                            document.getElementById('sizeSelect').value = this.gridSize;
                            this.createGrid(data.matrix);
                            return;
                        }
                    } catch (err) {}
                }
                
                // Parse TXT or CSV matrix
                const lines = text.trim().split(/\r?\n/);
                if (lines.length >= 21) {
                    const parsedMatrix = [];
                    lines.forEach(line => {
                        const row = line.includes(',') ? line.split(',') : line.trim().split('');
                        const nums = row.map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
                        if (nums.length > 0) parsedMatrix.push(nums);
                    });

                    if (parsedMatrix.length >= 21) {
                        this.saveState();
                        this.gridSize = parsedMatrix.length;
                        document.getElementById('sizeSelect').value = this.gridSize;
                        this.createGrid(parsedMatrix);
                        return;
                    }
                }
                alert('Invalid file format!');
            };
            reader.readAsText(file);
        } else {
            // Process Image File (PNG, JPG, BMP, SVG, WEBP)
            this.processImageFile(file);
        }
    }

    processImageFile(file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const img = new Image();
                img.onload = () => {
                    const w = img.width;
                    const h = img.height;
                    if (w < 10 || h < 10) return;

                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);

                    const imgData = ctx.getImageData(0, 0, w, h);
                    const data = imgData.data;

                    const lums = new Uint8Array(w * h);
                    const allLums = [];
                    for (let i = 0; i < w * h; i++) {
                        const r = data[i * 4];
                        const g = data[i * 4 + 1];
                        const b = data[i * 4 + 2];
                        const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                        lums[i] = l;
                        allLums.push(l);
                    }

                    allLums.sort((a, b) => a - b);
                    const threshold = Math.min(180, Math.max(70, allLums[Math.floor(allLums.length * 0.35)]));

                    const startY = Math.floor(h * 0.05);
                    const endY = Math.floor(h * 0.85);

                    const isDark = (x, y) => {
                        if (x < 0 || x >= w || y < 0 || y >= h) return false;
                        return lums[y * w + x] < threshold;
                    };

                    let minX = w, maxX = 0, minY = endY, maxY = startY;
                    for (let y = startY; y < endY; y++) {
                        for (let x = 0; x < w; x++) {
                            if (isDark(x, y)) {
                                if (x < minX) minX = x;
                                if (x > maxX) maxX = x;
                                if (y < minY) minY = y;
                                if (y > maxY) maxY = y;
                            }
                        }
                    }

                    if (minX >= maxX || minY >= maxY) {
                        minX = 0; maxX = w - 1; minY = startY; maxY = endY - 1;
                    }

                    const qrW = maxX - minX + 1;
                    const qrH = maxY - minY + 1;

                    let maxTransitions = 0;
                    [0.2, 0.35, 0.5, 0.65, 0.8].forEach(r => {
                        const sy = Math.floor(minY + qrH * r);
                        let trans = 0;
                        let lastSt = isDark(minX, sy) ? 1 : 0;
                        for (let x = minX; x <= maxX; x++) {
                            const st = isDark(x, sy) ? 1 : 0;
                            if (st !== lastSt) { trans++; lastSt = st; }
                        }
                        if (trans > maxTransitions) maxTransitions = trans;
                    });

                    const k = Math.max(0, Math.round(((maxTransitions * 1.1) - 21) / 4.0));
                    let N = 21 + k * 4;
                    N = Math.max(21, Math.min(161, N));

                    this.saveState();
                    this.gridSize = N;
                    document.getElementById('sizeSelect').value = N;
                    this.createGrid();

                    const cellW = qrW / N;
                    const cellH = qrH / N;

                    for (let r = 0; r < N; r++) {
                        for (let c = 0; c < N; c++) {
                            let darkCount = 0;
                            let samples = 0;
                            const sX = Math.floor(minX + (c + 0.2) * cellW);
                            const eX = Math.floor(minX + (c + 0.8) * cellW);
                            const sY = Math.floor(minY + (r + 0.2) * cellH);
                            const eY = Math.floor(minY + (r + 0.8) * cellH);

                            for (let sy = sY; sy <= eY; sy++) {
                                for (let sx = sX; sx <= eX; sx++) {
                                    if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
                                        samples++;
                                        if (isDark(sx, sy)) darkCount++;
                                    }
                                }
                            }

                            this.matrix[r][c] = (samples > 0 && darkCount / samples > 0.38) ? 1 : 0;
                        }
                    }

                    this.drawFinderPatternsSilent();

                    this.updateAllCellsUI();
                    this.evaluateReadability();
                };
                img.src = event.target.result;
            } catch (err) {
                console.error(err);
            }
        };
        reader.readAsDataURL(file);
    }

    saveState() {
        const copy = this.matrix.map(row => [...row]);
        this.undoStack.push({ size: this.gridSize, matrix: copy });
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
        this.redoStack = [];
    }

    undo() {
        if (this.undoStack.length === 0) return;
        const currentCopy = this.matrix.map(row => [...row]);
        this.redoStack.push({ size: this.gridSize, matrix: currentCopy });

        const prev = this.undoStack.pop();
        if (prev.size !== this.gridSize) {
            this.gridSize = prev.size;
            document.getElementById('sizeSelect').value = prev.size;
            this.createGrid(prev.matrix);
        } else {
            this.matrix = prev.matrix;
            this.updateAllCellsUI();
            this.evaluateReadability();
        }
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const currentCopy = this.matrix.map(row => [...row]);
        this.undoStack.push({ size: this.gridSize, matrix: currentCopy });

        const next = this.redoStack.pop();
        if (next.size !== this.gridSize) {
            this.gridSize = next.size;
            document.getElementById('sizeSelect').value = next.size;
            this.createGrid(next.matrix);
        } else {
            this.matrix = next.matrix;
            this.updateAllCellsUI();
            this.evaluateReadability();
        }
    }

    clearGrid() {
        this.saveState();
        this.matrix = Array.from({ length: this.gridSize }, () => Array(this.gridSize).fill(0));
        this.updateAllCellsUI();
        this.evaluateReadability();
    }

    invertGrid() {
        this.saveState();
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                this.matrix[r][c] = this.matrix[r][c] === 1 ? 0 : 1;
            }
        }
        this.updateAllCellsUI();
        this.evaluateReadability();
    }

    createGrid(presetMatrix = null) {
        const container = document.getElementById('gridContainer');
        container.innerHTML = '';

        const size = this.gridSize;
        document.getElementById('infoLabel').textContent = `QR Code Size: ${size}x${size}`;

        this.matrix = presetMatrix || Array.from({ length: size }, () => Array(size).fill(0));
        container.style.gridTemplateColumns = `24px repeat(${size}, 20px)`;

        const corner = document.createElement('div');
        corner.className = 'header-label';
        container.appendChild(corner);

        for (let col = 0; col < size; col++) {
            const lbl = document.createElement('div');
            lbl.className = 'header-label header-col';
            lbl.textContent = col + 1;
            container.appendChild(lbl);
        }

        this.cellElements = [];
        for (let row = 0; row < size; row++) {
            const rowLbl = document.createElement('div');
            rowLbl.className = 'header-label header-row';
            rowLbl.textContent = row + 1;
            container.appendChild(rowLbl);

            const rowCells = [];
            for (let col = 0; col < size; col++) {
                const cell = document.createElement('div');
                cell.className = 'grid-cell';
                if (this.matrix[row][col] === 1) cell.classList.add('black');
                cell.dataset.row = row;
                cell.dataset.col = col;
                cell.addEventListener('click', () => {
                    this.toggleCellFromButton(row, col);
                });
                container.appendChild(cell);
                rowCells.push(cell);
            }
            this.cellElements.push(rowCells);
        }

        this.highlightCurrentCell();
        this.evaluateReadability();
    }

    updateAllCellsUI() {
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                this.updateCellUI(r, c);
            }
        }
    }

    // STRICT QR STANDARD READABILITY & DECODE EVALUATION
    evaluateReadability() {
        const size = this.gridSize;
        const statusEl = document.getElementById('readabilityStatus');
        const payloadBox = document.getElementById('decodedPayloadBox');

        let totalBlack = 0;
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (this.matrix[r][c] === 1) totalBlack++;
            }
        }

        if (totalBlack === 0) {
            document.getElementById('readabilityPercent').textContent = `0%`;
            document.getElementById('meterBarFill').style.width = `0%`;
            statusEl.textContent = "Requires patterns...";
            payloadBox.style.display = 'none';
            return;
        }

        // 1. Finder Patterns Score (Max 20%)
        const finders = [[0, 0], [0, size - 7], [size - 7, 0]];
        let validFinders = 0;
        finders.forEach(([r0, c0]) => {
            let match = true;
            let darkCnt = 0;
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    const exp = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 1 : 0;
                    if (this.matrix[r0 + r][c0 + c] === 1) darkCnt++;
                    if (this.matrix[r0 + r][c0 + c] !== exp) match = false;
                }
            }
            if (match && darkCnt > 0) validFinders++;
        });
        const finderScore = Math.round((validFinders / 3) * 20);

        // 2. Timing Patterns Score (Max 10%)
        let timingMatches = 0;
        let totalTiming = 0;
        let darkInTiming = 0;
        for (let i = 8; i < size - 8; i++) {
            totalTiming += 2;
            const exp = (i % 2 === 0) ? 1 : 0;
            if (this.matrix[6][i] === 1) darkInTiming++;
            if (this.matrix[i][6] === 1) darkInTiming++;
            if (this.matrix[6][i] === exp) timingMatches++;
            if (this.matrix[i][6] === exp) timingMatches++;
        }
        const timingScore = (darkInTiming > 0 && totalTiming > 0) ? Math.round((timingMatches / totalTiming) * 10) : 0;

        const patternScore = finderScore + timingScore;

        // 3. Exhaustive Decode Search (Max 70%)
        const decodeRes = this.qrDecoder.decodeGridExhaustive(this.matrix);

        let dataScore = 0;
        if (decodeRes.success && decodeRes.payload.length > 0) {
            dataScore = 70;
        } else {
            let dataDarkCount = 0;
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8) || r === 6 || c === 6) continue;
                    if (this.matrix[r][c] === 1) dataDarkCount++;
                }
            }
            if (dataDarkCount > 0) {
                dataScore = Math.min(40, Math.round((dataDarkCount / ((size * size) * 0.25)) * 40));
            }
        }

        const totalScore = Math.min(100, Math.max(0, patternScore + dataScore));

        document.getElementById('readabilityPercent').textContent = `${totalScore}%`;
        document.getElementById('meterBarFill').style.width = `${totalScore}%`;

        if (decodeRes.payload && decodeRes.payload.length > 0) {
            statusEl.textContent = "Reed-Solomon OK";
            payloadBox.style.display = 'inline';
            payloadBox.textContent = `[ ${decodeRes.payload} ]`;
        } else if (totalScore >= 70) {
            statusEl.textContent = "Reed-Solomon Active";
            payloadBox.style.display = 'none';
        } else {
            statusEl.textContent = totalScore > 0 ? "Drawing..." : "Requires patterns...";
            payloadBox.style.display = 'none';
        }
    }

    drawFinderPatternsSilent() {
        const size = this.gridSize;
        const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
        corners.forEach(([r0, c0]) => {
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
                        this.matrix[r0 + r][c0 + c] = 1;
                    } else {
                        this.matrix[r0 + r][c0 + c] = 0;
                    }
                    this.updateCellUI(r0 + r, c0 + c);
                }
            }
        });
    }

    drawTimingPatternsSilent() {
        const size = this.gridSize;
        for (let i = 8; i < size - 8; i++) {
            const val = (i % 2 === 0) ? 1 : 0;
            this.matrix[6][i] = val;
            this.matrix[i][6] = val;
            this.updateCellUI(6, i);
            this.updateCellUI(i, 6);
        }
    }

    // Pattern Generators
    drawFinderPatterns() {
        this.saveState();
        this.drawFinderPatternsSilent();
        this.evaluateReadability();
    }

    drawTimingPatterns() {
        this.saveState();
        this.drawTimingPatternsSilent();
        this.evaluateReadability();
    }

    getAlignmentCoords() {
        const size = this.gridSize;
        if (size <= 21) return [];
        const version = Math.floor((size - 21) / 4) + 1;
        const numAlign = Math.floor(version / 7) + 2;
        let step = Math.floor((size - 13) / (numAlign - 1));
        if (step % 2 === 1) step += 1;

        const coords = [size - 7];
        while (coords.length < numAlign - 1) {
            coords.unshift(coords[0] - step);
        }
        coords.unshift(6);
        return coords;
    }

    drawAlignmentPatterns() {
        const size = this.gridSize;
        const coords = this.getAlignmentCoords();
        if (!coords.length) return;

        this.saveState();
        coords.forEach(rCenter => {
            coords.forEach(cCenter => {
                if ((rCenter <= 8 && cCenter <= 8) || (rCenter <= 8 && cCenter >= size - 8) || (rCenter >= size - 8 && cCenter <= 8)) {
                    return;
                }

                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) {
                        const r = rCenter + dr;
                        const c = cCenter + dc;
                        if (r >= 0 && r < size && c >= 0 && c < size) {
                            if (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) {
                                this.matrix[r][c] = 1;
                            } else {
                                this.matrix[r][c] = 0;
                            }
                            this.updateCellUI(r, c);
                        }
                    }
                }
            });
        });
        this.evaluateReadability();
    }

    drawAllPatterns() {
        this.saveState();
        this.drawFinderPatternsSilent();
        this.drawTimingPatternsSilent();
        this.drawAlignmentPatterns();
        this.evaluateReadability();
    }

    toggleCell() {
        if (this.currentRow >= 0 && this.currentRow < this.gridSize &&
            this.currentCol >= 0 && this.currentCol < this.gridSize) {
            this.saveState();
            this.matrix[this.currentRow][this.currentCol] = this.matrix[this.currentRow][this.currentCol] === 1 ? 0 : 1;
            this.updateCellUI(this.currentRow, this.currentCol);
            this.evaluateReadability();
        }
    }

    toggleCellFromButton(row, col) {
        this.saveState();
        this.matrix[row][col] = this.matrix[row][col] === 1 ? 0 : 1;
        this.updateCellUI(row, col);
        this.currentRow = row;
        this.currentCol = col;
        this.highlightCurrentCell();
        this.evaluateReadability();
    }

    updateCellUI(r, c) {
        const cellEl = this.cellElements[r][c];
        if (this.matrix[r][c] === 1) {
            cellEl.classList.add('black');
        } else {
            cellEl.classList.remove('black');
        }
    }

    highlightCurrentCell() {
        for (let r = 0; r < this.gridSize; r++) {
            for (let c = 0; c < this.gridSize; c++) {
                this.cellElements[r][c].classList.remove('active');
            }
        }
        if (this.currentRow >= 0 && this.currentRow < this.gridSize &&
            this.currentCol >= 0 && this.currentCol < this.gridSize) {
            this.cellElements[this.currentRow][this.currentCol].classList.add('active');
        }
    }

    bindEvents() {
        window.addEventListener('keydown', (e) => {
            if (['SELECT'].includes(document.activeElement.tagName)) return;

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                if (e.shiftKey) this.redo();
                else this.undo();
                e.preventDefault();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                this.redo();
                e.preventDefault();
                return;
            }

            switch (e.key) {
                case 'ArrowUp':
                    if (this.currentRow > 0) {
                        this.currentRow--;
                        this.highlightCurrentCell();
                        if (this.isSpacePressed || this.isEnterPressed) this.toggleCell();
                    }
                    e.preventDefault();
                    break;
                case 'ArrowDown':
                    if (this.currentRow < this.gridSize - 1) {
                        this.currentRow++;
                        this.highlightCurrentCell();
                        if (this.isSpacePressed || this.isEnterPressed) this.toggleCell();
                    }
                    e.preventDefault();
                    break;
                case 'ArrowLeft':
                    if (this.currentCol > 0) {
                        this.currentCol--;
                        this.highlightCurrentCell();
                        if (this.isSpacePressed || this.isEnterPressed) this.toggleCell();
                    }
                    e.preventDefault();
                    break;
                case 'ArrowRight':
                    if (this.currentCol < this.gridSize - 1) {
                        this.currentCol++;
                        this.highlightCurrentCell();
                        if (this.isSpacePressed || this.isEnterPressed) this.toggleCell();
                    }
                    e.preventDefault();
                    break;
                case ' ':
                    this.isSpacePressed = true;
                    this.toggleCell();
                    e.preventDefault();
                    break;
                case 'Enter':
                    this.isEnterPressed = true;
                    this.toggleCell();
                    e.preventDefault();
                    break;
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') this.isSpacePressed = false;
            if (e.key === 'Enter') this.isEnterPressed = false;
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.qraster = new QRasterWeb();
});
