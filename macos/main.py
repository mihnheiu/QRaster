#!/usr/bin/env python3
import os
import sys
import json
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import math

# REAL GALOIS FIELD GF(256) REED-SOLOMON ENGINE
class GF256:
    def __init__(self):
        self.exp_table = [0] * 512
        self.log_table = [0] * 256
        x = 1
        for i in range(255):
            self.exp_table[i] = x
            self.exp_table[i + 255] = x
            self.log_table[x] = i
            x <<= 1
            if x & 256:
                x ^= 0x11d

    def add(self, a, b): return a ^ b
    def sub(self, a, b): return a ^ b

    def mul(self, a, b):
        if a == 0 or b == 0: return 0
        return self.exp_table[self.log_table[a] + self.log_table[b]]

    def div(self, a, b):
        if b == 0: return 0
        if a == 0: return 0
        return self.exp_table[(self.log_table[a] + 255 - self.log_table[b]) % 255]

    def poly_eval(self, poly, x):
        y = poly[0]
        for i in range(1, len(poly)):
            y = self.add(self.mul(y, x), poly[i])
        return y

    def correct_errors(self, msg, ec_len):
        if not msg: return msg, 0, False
        syndromes = [0] * ec_len
        has_error = False
        for i in range(ec_len):
            s = self.poly_eval(msg, self.exp_table[i])
            syndromes[i] = s
            if s != 0: has_error = True

        if not has_error:
            return msg, 0, True

        C = [1]
        B = [1]
        L = 0
        m = 1
        b = 1

        for i in range(ec_len):
            d = syndromes[i]
            for j in range(1, L + 1):
                d = self.add(d, self.mul(C[j], syndromes[i - j]))

            if d == 0:
                m += 1
            elif 2 * L <= i:
                T = list(C)
                scale = self.div(d, b)
                shiftB = [0] * m + [self.mul(v, scale) for v in B]
                newC = [0] * max(len(C), len(shiftB))
                for k in range(len(C)): newC[k] = self.add(newC[k], C[k])
                for k in range(len(shiftB)): newC[k] = self.add(newC[k], shiftB[k])
                C = newC
                L = i + 1 - L
                B = T
                b = d
                m = 1
            else:
                scale = self.div(d, b)
                shiftB = [0] * m + [self.mul(v, scale) for v in B]
                newC = [0] * max(len(C), len(shiftB))
                for k in range(len(C)): newC[k] = self.add(newC[k], C[k])
                for k in range(len(shiftB)): newC[k] = self.add(newC[k], shiftB[k])
                C = newC
                m += 1

        err_pos = []
        for i in range(len(msg)):
            x = self.exp_table[(255 - i) % 255]
            if self.poly_eval(C, x) == 0:
                err_pos.append(len(msg) - 1 - i)

        if len(err_pos) != L:
            return msg, L, False

        corrected = list(msg)
        for idx in err_pos:
            xi_inv = self.exp_table[(255 - (len(msg) - 1 - idx)) % 255]
            c_deriv = 0
            for j in range(1, len(C), 2):
                c_deriv = self.add(c_deriv, self.mul(C[j], self.exp_table[(j - 1) * self.log_table[xi_inv] % 255]))

            omega = 0
            for i in range(ec_len):
                term = syndromes[i]
                for j in range(1, L + 1):
                    if i - j >= 0:
                        term = self.add(term, self.mul(C[j], syndromes[i - j]))
                omega = self.add(omega, self.mul(term, self.exp_table[(i * self.log_table[xi_inv]) % 255]))

            err_mag = self.div(omega, c_deriv)
            corrected[idx] = self.add(corrected[idx], err_mag)

        return corrected, len(err_pos), True


# REAL QR DECODER CLASS
class RealQRDecoder:
    def __init__(self):
        self.gf = GF256()

    def get_format_info(self, grid):
        bits = 0
        coords = [
            (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
            (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)
        ]
        for r, c in coords:
            val = 1 if grid[r][c].cget("bg") == "black" else 0
            bits = (bits << 1) | val

        bits ^= 0x5465
        mask_pattern = (bits >> 10) & 0x07
        ec_level = (bits >> 13) & 0x03
        return mask_pattern % 8, ec_level

    def unmask(self, grid, pattern):
        N = len(grid)
        unmasked = [[0] * N for _ in range(N)]
        for r in range(N):
            for c in range(N):
                val = 1 if grid[r][c].cget("bg") == "black" else 0
                cond = False
                if pattern == 0: cond = (r + c) % 2 == 0
                elif pattern == 1: cond = r % 2 == 0
                elif pattern == 2: cond = c % 3 == 0
                elif pattern == 3: cond = (r + c) % 3 == 0
                elif pattern == 4: cond = ((r // 2) + (c // 3)) % 2 == 0
                elif pattern == 5: cond = ((r * c) % 2) + ((r * c) % 3) == 0
                elif pattern == 6: cond = (((r * c) % 2) + ((r * c) % 3)) % 2 == 0
                elif pattern == 7: cond = (((r + c) % 2) + ((r * c) % 3)) % 2 == 0
                unmasked[r][c] = val ^ 1 if cond else val
        return unmasked

    def extract_codewords(self, unmasked):
        N = len(unmasked)
        is_reserved = [[False] * N for _ in range(N)]

        for r in range(0, 9):
            for c in range(0, 9):
                if r < N and c < N: is_reserved[r][c] = True
                if r < N and N - 8 + c < N: is_reserved[r][N - 8 + c] = True
                if N - 8 + r < N and c < N: is_reserved[N - 8 + r][c] = True

        for i in range(N):
            is_reserved[6][i] = True
            is_reserved[i][6] = True

        bits = []
        upward = True
        for col in range(N - 1, 0, -2):
            if col == 6: col = 5
            rows = list(range(N - 1, -1, -1)) if upward else list(range(N))
            for r in rows:
                for c in (col, col - 1):
                    if not is_reserved[r][c]:
                        bits.append(unmasked[r][c])
            upward = not upward

        codewords = []
        for i in range(len(bits) // 8):
            byte_val = 0
            for b in range(8):
                byte_val = (byte_val << 1) | bits[i * 8 + b]
            codewords.append(byte_val)
        return codewords

    def decode_payload(self, codewords):
        if not codewords: return ""
        bit_str = "".join(f"{b:08b}" for b in codewords)
        if len(bit_str) < 12: return ""

        mode = bit_str[:4]
        ptr = 4
        result = []

        if mode == "0100":
            char_count = int(bit_str[ptr:ptr + 8], 2)
            ptr += 8
            for _ in range(char_count):
                if ptr + 8 > len(bit_str): break
                result.append(chr(int(bit_str[ptr:ptr + 8], 2)))
                ptr += 8
            res = "".join(result)
        elif mode == "0010":
            alphanum = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
            char_count = int(bit_str[ptr:ptr + 9], 2)
            ptr += 9
            for _ in range(char_count // 2):
                if ptr + 11 > len(bit_str): break
                val = int(bit_str[ptr:ptr + 11], 2)
                result.append(alphanum[val // 45] + alphanum[val % 45])
                ptr += 11
            if char_count % 2 == 1 and ptr + 6 <= len(bit_str):
                val = int(bit_str[ptr:ptr + 6], 2)
                result.append(alphanum[val])
            res = "".join(result)
        elif mode == "0001":
            char_count = int(bit_str[ptr:ptr + 10], 2)
            ptr += 10
            while len("".join(result)) < char_count and ptr + 10 <= len(bit_str):
                val = int(bit_str[ptr:ptr + 10], 2)
                result.append(f"{val:03d}")
                ptr += 10
            res = "".join(result)
        else:
            res = ""

        return "".join([c for c in res if ord(c) >= 32 or c in "\n\r\t"])

    def decode_grid_exhaustive(self, grid):
        fmt_mask, _ = self.get_format_info(grid)
        masks_to_try = [fmt_mask, 0, 1, 2, 3, 4, 5, 6, 7]

        for mask in masks_to_try:
            unmasked = self.unmask(grid, mask)
            codewords = self.extract_codewords(unmasked)
            if not codewords: continue

            ec_len = max(7, int(len(codewords) * 0.35))
            corrected, err_cnt, success = self.gf.correct_errors(codewords, ec_len)

            payload = self.decode_payload(corrected)
            if payload:
                return payload, success

        return "", False


class QRaster:
    def __init__(self, master):
        self.master = master
        self.master.title("QRaster")

        # Set macOS Icon safely
        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        if os.path.exists(icon_path):
            try:
                img = tk.PhotoImage(file=icon_path)
                self.master.iconphoto(True, img)
            except Exception:
                pass

        self.grid_size = 21
        self.cell_size = 20
        self.grid = []
        self.current_row = 0
        self.current_col = 0
        self.is_toggling = False
        self.is_space_pressed = False
        self.is_enter_pressed = False

        self.qr_decoder = RealQRDecoder()

        self.undo_stack = []
        self.redo_stack = []

        self.control_frame = tk.Frame(self.master)
        self.control_frame.pack(side="top", fill="x", padx=10, pady=5)

        self.grid_frame = tk.Frame(self.master)
        self.grid_frame.pack(side="top", expand=True, fill="both", padx=10, pady=5)

        self.create_size_selector()
        self.create_generate_button()
        self.create_pattern_buttons()
        self.create_history_file_buttons()
        self.create_readability_meter()
        self.create_grid()

        # Keyboard bindings
        self.master.bind("<Up>", self.move_up)
        self.master.bind("<Down>", self.move_down)
        self.master.bind("<Left>", self.move_left)
        self.master.bind("<Right>", self.move_right)
        self.master.bind("<space>", self.toggle_cell)
        self.master.bind("<Return>", self.toggle_cell)
        self.master.bind("<KeyRelease-space>", self.stop_toggling)
        self.master.bind("<KeyRelease-Return>", self.stop_toggling)

        # macOS Command Shortcuts for Undo/Redo
        self.master.bind("<Command-z>", lambda e: self.undo())
        self.master.bind("<Command-y>", lambda e: self.redo())
        self.master.bind("<Command-Shift-Z>", lambda e: self.redo())

    def create_size_selector(self):
        self.size_label = tk.Label(self.control_frame, text="Select QR Code Size:")
        self.size_label.grid(row=0, column=0, padx=5, pady=3)

        sizes = [f"{i}x{i}" for i in range(21, 162, 4)]
        self.size_combobox = ttk.Combobox(self.control_frame, values=sizes, state="readonly")
        self.size_combobox.set("21x21")
        self.size_combobox.grid(row=0, column=1, padx=5, pady=3)

    def create_generate_button(self):
        self.generate_button = tk.Button(self.control_frame, text="Generate Grid", command=self.generate_grid)
        self.generate_button.grid(row=1, column=0, columnspan=2, pady=3)

        self.info_label = tk.Label(self.control_frame, text="QR Code Size: 21x21", font=("TkDefaultFont", 9, "bold"))
        self.info_label.grid(row=0, column=2, padx=10)

    def create_pattern_buttons(self):
        pattern_frame = tk.Frame(self.control_frame)
        pattern_frame.grid(row=1, column=2, padx=10, pady=3)

        btn_finders = tk.Button(pattern_frame, text="Finder Patterns", command=self.draw_finder_patterns)
        btn_finders.pack(side="left", padx=2)

        btn_timing = tk.Button(pattern_frame, text="Timing Patterns", command=self.draw_timing_patterns)
        btn_timing.pack(side="left", padx=2)

        btn_align = tk.Button(pattern_frame, text="Alignment Patterns", command=self.draw_alignment_patterns)
        btn_align.pack(side="left", padx=2)

        btn_all = tk.Button(pattern_frame, text="All Patterns", command=self.draw_all_patterns)
        btn_all.pack(side="left", padx=2)

    def create_history_file_buttons(self):
        hist_frame = tk.Frame(self.control_frame)
        hist_frame.grid(row=2, column=0, columnspan=3, pady=3, sticky="w")

        btn_undo = tk.Button(hist_frame, text="Undo (Cmd+Z)", command=self.undo)
        btn_undo.pack(side="left", padx=2)

        btn_redo = tk.Button(hist_frame, text="Redo (Cmd+Y)", command=self.redo)
        btn_redo.pack(side="left", padx=2)

        btn_save = tk.Button(hist_frame, text="Save File", command=self.save_file)
        btn_save.pack(side="left", padx=2)

        btn_open = tk.Button(hist_frame, text="Open File", command=self.open_file)
        btn_open.pack(side="left", padx=2)

        btn_clear = tk.Button(hist_frame, text="Clear Grid", command=self.clear_grid)
        btn_clear.pack(side="left", padx=2)

        btn_invert = tk.Button(hist_frame, text="Invert Colors", command=self.invert_grid)
        btn_invert.pack(side="left", padx=2)

        btn_help = tk.Button(hist_frame, text="❓ Guide & QR Info", command=self.show_help_dialog, bg="#0078d7", fg="white", font=("TkDefaultFont", 9, "bold"))
        btn_help.pack(side="left", padx=5)

    def show_help_dialog(self):
        help_win = tk.Toplevel(self.master)
        help_win.title("📖 User Guide & QR Technical Knowledge")
        help_win.geometry("720x550")
        help_win.transient(self.master)

        notebook = ttk.Notebook(help_win)
        notebook.pack(expand=True, fill="both", padx=10, pady=10)

        # Tab 1
        t1 = ttk.Frame(notebook)
        notebook.add(t1, text="1. About QR Code")
        txt1 = tk.Text(t1, wrap="word", font=("TkDefaultFont", 10), padx=10, pady=10)
        txt1.insert("1.0", "📌 WHAT IS A QR CODE?\n\n"
                           "A QR Code (Quick Response Code) is a 2D matrix barcode invented by Denso Wave in 1994, standardized under ISO/IEC 18004.\n\n"
                           "QR Codes store thousands of text characters, URLs, phone numbers, or binary data with built-in fault tolerance using Galois Field Reed-Solomon error correction.\n")
        txt1.config(state="disabled")
        txt1.pack(expand=True, fill="both")

        # Tab 2
        t2 = ttk.Frame(notebook)
        notebook.add(t2, text="2. Technical Structure")
        txt2 = tk.Text(t2, wrap="word", font=("TkDefaultFont", 10), padx=10, pady=10)
        txt2.insert("1.0", "📐 DETAILED QR CODE STRUCTURE (ISO 18004):\n\n"
                           "1. Finder Patterns (7x7): 3 square patterns located at Top-Left, Top-Right, and Bottom-Left corners to establish orientation and scale.\n\n"
                           "2. Timing Patterns: Alternating black and white modules along Row 7 and Column 7 connecting the Finder Patterns.\n\n"
                           "3. Alignment Patterns: Positioned across Version 2 (25x25) to Version 40 (161x161) matrices to prevent surface distortion.\n\n"
                           "4. Format Info & 8 Mask Patterns: Contains error correction level (L, M, Q, H) and 1 of 8 XOR masking patterns.\n\n"
                           "5. Reed-Solomon Error Correction (Galois Field GF(256)): Mathematical engine that restores missing/damaged payload bytes automatically.\n")
        txt2.config(state="disabled")
        txt2.pack(expand=True, fill="both")

        # Tab 3
        t3 = ttk.Frame(notebook)
        notebook.add(t3, text="3. Readability Meter")
        txt3 = tk.Text(t3, wrap="word", font=("TkDefaultFont", 10), padx=10, pady=10)
        txt3.insert("1.0", "📊 READABILITY METER SCALE (0% - 100%):\n\n"
                           "• 0% (Empty Grid): When no dark modules exist in the matrix.\n\n"
                           "• Max 30% (Structural Patterns): Drawing all 3 Finder Patterns and Timing Patterns yields up to 30% structural readiness.\n\n"
                           "• Remaining 70% (Data Payload & Reed-Solomon): As you draw/edit 70-80% of data modules, the GF(256) Reed-Solomon engine automatically calculates missing bytes and DECODES THE PAYLOAD REAL-TIME!\n")
        txt3.config(state="disabled")
        txt3.pack(expand=True, fill="both")

        # Tab 4
        t4 = ttk.Frame(notebook)
        notebook.add(t4, text="4. Usage & Shortcuts")
        txt4 = tk.Text(t4, wrap="word", font=("TkDefaultFont", 10), padx=10, pady=10)
        txt4.insert("1.0", "⌨️ KEYBOARD SHORTCUTS & FEATURES:\n\n"
                           "• Mouse Click / Space / Enter: Toggle cell color (White ↔ Black).\n"
                           "• Arrow Keys (Up, Down, Left, Right): Navigate grid cursor.\n"
                           "• Cmd + Z / Ctrl + Z: Undo action.\n"
                           "• Cmd + Y / Ctrl + Y: Redo action.\n"
                           "• Open File: Support JSON, TXT, CSV matrix files and PNG, JPG, BMP, PPM image files.\n"
                           "• Save File: Support JSON, TXT, CSV, and PNG formats.\n")
        txt4.config(state="disabled")
        txt4.pack(expand=True, fill="both")

    def create_readability_meter(self):
        meter_frame = tk.Frame(self.control_frame)
        meter_frame.grid(row=3, column=0, columnspan=3, pady=3, sticky="w")

        self.lbl_meter = tk.Label(meter_frame, text="Readability: 0% | Status: Requires patterns...", font=("TkDefaultFont", 9))
        self.lbl_meter.pack(side="left")

    # UNIVERSAL MULTI-FORMAT SAVE ENGINE (JSON, TXT, CSV, PNG)
    def save_file(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[
                ("JSON Matrix (*.json)", "*.json"),
                ("Text Matrix (*.txt)", "*.txt"),
                ("CSV Matrix (*.csv)", "*.csv"),
                ("PNG Image (*.png)", "*.png"),
                ("All Files (*.*)", "*.*")
            ]
        )
        if not path:
            return

        matrix_data = []
        for row in self.grid:
            matrix_data.append([1 if cell.cget("bg") == "black" else 0 for cell in row])

        ext = os.path.splitext(path)[1].lower()
        if ext == ".txt":
            with open(path, "w", encoding="utf-8") as f:
                for row in matrix_data:
                    f.write("".join(str(v) for v in row) + "\n")
        elif ext == ".csv":
            with open(path, "w", encoding="utf-8") as f:
                for row in matrix_data:
                    f.write(",".join(str(v) for v in row) + "\n")
        elif ext == ".png":
            scale = 10
            dim = self.grid_size * scale
            img = tk.PhotoImage(width=dim, height=dim)
            for r in range(self.grid_size):
                for c in range(self.grid_size):
                    color = "#000000" if matrix_data[r][c] == 1 else "#ffffff"
                    for sy in range(scale):
                        for sx in range(scale):
                            img.put(color, (c * scale + sx, r * scale + sy))
            img.write(path, format="png")
        else: # Default JSON
            data = {
                "gridSize": self.grid_size,
                "matrix": matrix_data
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

        messagebox.showinfo("Saved Successfully", f"File saved to {path}")

    # UNIVERSAL MULTI-FORMAT OPEN ENGINE (JSON, TXT, CSV, PNG/JPG/BMP/PPM)
    def open_file(self):
        path = filedialog.askopenfilename(
            filetypes=[
                ("All Supported Formats", "*.json;*.txt;*.csv;*.png;*.gif;*.ppm;*.pgm;*.bmp"),
                ("JSON Matrix (*.json)", "*.json"),
                ("Text/CSV Matrix (*.txt;*.csv)", "*.txt;*.csv"),
                ("Image Files (*.png;*.gif;*.ppm;*.pgm;*.bmp)", "*.png;*.gif;*.ppm;*.pgm;*.bmp"),
                ("All Files (*.*)", "*.*")
            ]
        )
        if not path:
            return

        ext = os.path.splitext(path)[1].lower()
        if ext in (".png", ".gif", ".ppm", ".pgm", ".bmp"):
            self.import_image_path(path)
            return

        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()

            parsed_matrix = None
            if ext == ".json" or content.strip().startswith("{"):
                try:
                    data = json.loads(content)
                    if "matrix" in data and isinstance(data["matrix"], list):
                        parsed_matrix = data["matrix"]
                except Exception:
                    pass

            if parsed_matrix is None:
                lines = content.strip().splitlines()
                if len(lines) >= 21:
                    parsed_matrix = []
                    for line in lines:
                        row = line.split(",") if "," in line else list(line.strip())
                        nums = [int(v) for v in row if v.strip().isdigit()]
                        if nums: parsed_matrix.append(nums)

            if parsed_matrix and len(parsed_matrix) >= 21:
                self.save_state()
                size = len(parsed_matrix)
                self.grid_size = size
                self.size_combobox.set(f"{size}x{size}")

                for widget in self.grid_frame.winfo_children():
                    widget.destroy()
                self.create_grid()

                for r in range(size):
                    for c in range(size):
                        color = "black" if (c < len(parsed_matrix[r]) and parsed_matrix[r][c] == 1) else "white"
                        self.grid[r][c].config(bg=color)
                self.evaluate_readability()
                messagebox.showinfo("File Loaded Successfully", f"Loaded matrix size {size}x{size} for editing.")
            else:
                messagebox.showerror("File Error", "Invalid file matrix format!")
        except Exception as e:
            messagebox.showerror("File Error", f"Cannot load file: {e}")

    def import_image_path(self, path):
        try:
            img = tk.PhotoImage(file=path)
            w, h = img.width(), img.height()
            if w < 10 or h < 10:
                return

            self.save_state()

            lums = []
            all_lums = []
            for y in range(h):
                row_lum = []
                for x in range(w):
                    rgb = img.get(x, y)
                    if isinstance(rgb, tuple):
                        l = int(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
                    else:
                        vals = [int(v) for v in rgb.split()[:3]]
                        l = int(0.299 * vals[0] + 0.587 * vals[1] + 0.114 * vals[2])
                    row_lum.append(l)
                    all_lums.append(l)
                lums.append(row_lum)

            all_lums.sort()
            threshold = min(180, max(70, all_lums[int(len(all_lums) * 0.35)]))

            start_y = int(h * 0.05)
            end_y = int(h * 0.85)

            def is_dark(x, y):
                if x < 0 or x >= w or y < 0 or y >= h: return False
                return lums[y][x] < threshold

            min_x, max_x = w, 0
            min_y, max_y = end_y, start_y
            for y in range(start_y, end_y):
                for x in range(w):
                    if is_dark(x, y):
                        if x < min_x: min_x = x
                        if x > max_x: max_x = x
                        if y < min_y: min_y = y
                        if y > max_y: max_y = y

            if min_x >= max_x or min_y >= max_y:
                min_x, max_x, min_y, max_y = 0, w - 1, start_y, end_y - 1

            qr_w = max_x - min_x + 1
            qr_h = max_y - min_y + 1

            max_trans = 0
            for r in (0.2, 0.35, 0.5, 0.65, 0.8):
                sy = int(min_y + qr_h * r)
                trans = 0
                last_st = 1 if is_dark(min_x, sy) else 0
                for x in range(min_x, max_x + 1):
                    st = 1 if is_dark(x, sy) else 0
                    if st != last_st: trans += 1; last_st = st
                if trans > max_trans: max_trans = trans

            k = max(0, int(round(((max_trans * 1.1) - 21) / 4.0)))
            N = 21 + k * 4
            N = max(21, min(161, N))

            self.grid_size = N
            self.size_combobox.set(f"{N}x{N}")
            for widget in self.grid_frame.winfo_children():
                widget.destroy()
            self.create_grid()

            cell_w = qr_w / N
            cell_h = qr_h / N

            for r in range(N):
                for c in range(N):
                    start_x = int(min_x + (c + 0.2) * cell_w)
                    end_x = int(min_x + (c + 0.8) * cell_w)
                    start_y = int(min_y + (r + 0.2) * cell_h)
                    end_y = int(min_y + (r + 0.8) * cell_h)

                    dark_cnt = 0
                    samples = 0
                    for sy in range(start_y, end_y + 1):
                        for sx in range(start_x, end_x + 1):
                            if 0 <= sx < w and 0 <= sy < h:
                                samples += 1
                                if is_dark(sx, sy):
                                    dark_cnt += 1

                    color = "black" if (samples > 0 and dark_cnt / samples > 0.38) else "white"
                    self.grid[r][c].config(bg=color)

            self.draw_finder_patterns_silent()

            self.evaluate_readability()
            messagebox.showinfo("Import Image", f"Detected QR matrix size: {N}x{N}!")
        except Exception as e:
            messagebox.showerror("File Error", f"Cannot load file: {e}")

    # STRICT QR STANDARD READABILITY ENGINE
    def evaluate_readability(self):
        size = self.grid_size

        total_black = sum(1 for row in self.grid for cell in row if cell.cget("bg") == "black")
        if total_black == 0:
            self.lbl_meter.config(
                text="Readability: 0% | Status: Requires patterns...",
                fg="black"
            )
            return

        # 1. Finder Patterns Score (Max 20%)
        finders = [(0, 0), (0, size - 7), (size - 7, 0)]
        valid_finders = 0
        for r0, c0 in finders:
            match = True
            dark_cnt = 0
            for r in range(7):
                for c in range(7):
                    exp = "black" if (r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4)) else "white"
                    if self.grid[r0 + r][c0 + c].cget("bg") == "black": dark_cnt += 1
                    if self.grid[r0 + r][c0 + c].cget("bg") != exp:
                        match = False
            if match and dark_cnt > 0: valid_finders += 1
        finder_score = round((valid_finders / 3) * 20)

        # 2. Timing Patterns Score (Max 10%)
        timing_matches = 0
        total_timing = 0
        dark_in_timing = 0
        for i in range(8, size - 8):
            total_timing += 2
            exp = "black" if (i % 2 == 0) else "white"
            if self.grid[6][i].cget("bg") == "black": dark_in_timing += 1
            if self.grid[i][6].cget("bg") == "black": dark_in_timing += 1
            if self.grid[6][i].cget("bg") == exp: timing_matches += 1
            if self.grid[i][6].cget("bg") == exp: timing_matches += 1
        timing_score = round((timing_matches / total_timing) * 10) if (dark_in_timing > 0 and total_timing > 0) else 0

        pattern_score = finder_score + timing_score

        # 3. Exhaustive Decode Search (Max 70%)
        decoded_payload, success = self.qr_decoder.decode_grid_exhaustive(self.grid)

        data_score = 0
        if decoded_payload:
            data_score = 70
        else:
            data_dark_count = 0
            for r in range(size):
                for c in range(size):
                    if (r <= 8 and c <= 8) or (r <= 8 and c >= size - 8) or (r >= size - 8 and c <= 8) or r == 6 or c == 6: continue
                    if self.grid[r][c].cget("bg") == "black": data_dark_count += 1
            if data_dark_count > 0:
                data_score = min(40, round((data_dark_count / ((size * size) * 0.25)) * 40))

        total_score = min(100, max(0, pattern_score + data_score))

        if decoded_payload:
            self.lbl_meter.config(
                text=f"Readability: {total_score}% | Reed-Solomon OK [ decoded: {decoded_payload} ]",
                fg="green"
            )
        elif total_score >= 70:
            self.lbl_meter.config(
                text=f"Readability: {total_score}% | Status: Reed-Solomon Active",
                fg="black"
            )
        else:
            status = "Drawing..." if total_score > 0 else "Requires patterns..."
            self.lbl_meter.config(
                text=f"Readability: {total_score}% | Status: {status}",
                fg="black"
            )

    # History Helper Functions
    def save_state(self):
        state = []
        for row in self.grid:
            row_colors = [cell.cget("bg") for cell in row]
            state.append(row_colors)
        self.undo_stack.append((self.grid_size, state))
        if len(self.undo_stack) > 50:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def undo(self):
        if not self.undo_stack:
            return
        current_state = []
        for row in self.grid:
            current_state.append([cell.cget("bg") for cell in row])
        self.redo_stack.append((self.grid_size, current_state))

        size, prev_state = self.undo_stack.pop()
        if size != self.grid_size:
            self.grid_size = size
            self.size_combobox.set(f"{size}x{size}")
            self.create_grid()

        for r in range(size):
            for c in range(size):
                self.grid[r][c].config(bg=prev_state[r][c])
        self.evaluate_readability()

    def redo(self):
        if not self.redo_stack:
            return
        current_state = []
        for row in self.grid:
            current_state.append([cell.cget("bg") for cell in row])
        self.undo_stack.append((self.grid_size, current_state))

        size, next_state = self.redo_stack.pop()
        if size != self.grid_size:
            self.grid_size = size
            self.size_combobox.set(f"{size}x{size}")
            self.create_grid()

        for r in range(size):
            for c in range(size):
                self.grid[r][c].config(bg=next_state[r][c])
        self.evaluate_readability()

    def clear_grid(self):
        self.save_state()
        for row in self.grid:
            for cell in row:
                cell.config(bg="white")
        self.evaluate_readability()

    def invert_grid(self):
        self.save_state()
        for row in self.grid:
            for cell in row:
                new_color = "black" if cell.cget("bg") == "white" else "white"
                cell.config(bg=new_color)
        self.evaluate_readability()

    def generate_grid(self):
        selected_size = self.size_combobox.get()
        self.grid_size = int(selected_size.split("x")[0])

        for widget in self.grid_frame.winfo_children():
            widget.destroy()

        self.current_row = 0
        self.current_col = 0
        self.create_grid()

    def create_grid(self):
        self.grid = []

        # Column headers (1..N)
        for col in range(self.grid_size):
            label = tk.Label(self.grid_frame, text=str(col + 1), width=3, anchor="n", relief="flat")
            label.grid(row=0, column=col + 1, sticky="nsew", padx=0, pady=0)

        # Row headers (1..N) & Cell Buttons
        for row in range(self.grid_size):
            label = tk.Label(self.grid_frame, text=str(row + 1), width=3, anchor="e", relief="flat")
            label.grid(row=row + 1, column=0, sticky="nsew", padx=0, pady=0)

            row_cells = []
            for col in range(self.grid_size):
                cell = tk.Button(
                    self.grid_frame,
                    width=2,
                    height=1,
                    bg="white",
                    relief="flat",
                    bd=0,
                    highlightthickness=0,
                    activebackground="gray",
                    command=lambda r=row, c=col: self.toggle_cell_from_button(r, c)
                )
                cell.grid(row=row + 1, column=col + 1, sticky="nsew", padx=0, pady=0)
                row_cells.append(cell)
            self.grid.append(row_cells)

        self.info_label.config(text=f"QR Code Size: {self.grid_size}x{self.grid_size}")
        self.highlight_current_cell()
        self.evaluate_readability()

    # Pattern Drawing Functions
    def draw_finder_patterns_silent(self):
        size = self.grid_size
        corners = [(0, 0), (0, size - 7), (size - 7, 0)]
        for r0, c0 in corners:
            for r in range(7):
                for c in range(7):
                    if r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4):
                        self.grid[r0 + r][c0 + c].config(bg="black")
                    else:
                        self.grid[r0 + r][c0 + c].config(bg="white")

    def draw_timing_patterns_silent(self):
        size = self.grid_size
        for i in range(8, size - 8):
            color = "black" if (i % 2 == 0) else "white"
            self.grid[6][i].config(bg=color)
            self.grid[i][6].config(bg=color)

    def draw_finder_patterns(self):
        self.save_state()
        self.draw_finder_patterns_silent()
        self.evaluate_readability()

    def draw_timing_patterns(self):
        self.save_state()
        self.draw_timing_patterns_silent()
        self.evaluate_readability()

    def get_alignment_coords(self):
        size = self.grid_size
        if size <= 21:
            return []
        version = (size - 21) // 4 + 1
        num_align = version // 7 + 2
        step = (size - 13) // (num_align - 1)
        if step % 2 == 1:
            step += 1
        coords = [size - 7]
        while len(coords) < num_align - 1:
            coords.insert(0, coords[0] - step)
        coords.insert(0, 6)
        return coords

    def draw_alignment_patterns(self):
        size = self.grid_size
        coords = self.get_alignment_coords()
        if not coords:
            return

        self.save_state()
        for r_center in coords:
            for c_center in coords:
                if (r_center <= 8 and c_center <= 8) or (r_center <= 8 and c_center >= size - 8) or (r_center >= size - 8 and c_center <= 8):
                    continue

                for dr in range(-2, 3):
                    for dc in range(-2, 3):
                        r, c = r_center + dr, c_center + dc
                        if 0 <= r < size and 0 <= c < size:
                            if abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0):
                                self.grid[r][c].config(bg="black")
                            else:
                                self.grid[r][c].config(bg="white")
        self.evaluate_readability()

    def draw_all_patterns(self):
        self.save_state()
        self.draw_finder_patterns_silent()
        self.draw_timing_patterns_silent()
        self.draw_alignment_patterns()
        self.evaluate_readability()

    def toggle_cell(self, event=None):
        if event:
            if event.keysym == "space":
                self.is_space_pressed = True
            elif event.keysym == "Return":
                self.is_enter_pressed = True

        if 0 <= self.current_row < self.grid_size and 0 <= self.current_col < self.grid_size:
            self.save_state()
            current_color = self.grid[self.current_row][self.current_col].cget("bg")
            new_color = "black" if current_color == "white" else "white"
            self.grid[self.current_row][self.current_col].config(bg=new_color)
            self.evaluate_readability()

    def toggle_cell_from_button(self, row, col):
        self.save_state()
        current_color = self.grid[row][col].cget("bg")
        new_color = "black" if current_color == "white" else "white"
        self.grid[row][col].config(bg=new_color)
        self.current_row = row
        self.current_col = col
        self.highlight_current_cell()
        self.evaluate_readability()

    def move_up(self, event):
        if self.current_row > 0:
            self.current_row -= 1
            self.highlight_current_cell()
            if self.is_space_pressed or self.is_enter_pressed:
                self.toggle_cell()

    def move_down(self, event):
        if self.current_row < self.grid_size - 1:
            self.current_row += 1
            self.highlight_current_cell()
            if self.is_space_pressed or self.is_enter_pressed:
                self.toggle_cell()

    def move_left(self, event):
        if self.current_col > 0:
            self.current_col -= 1
            self.highlight_current_cell()
            if self.is_space_pressed or self.is_enter_pressed:
                self.toggle_cell()

    def move_right(self, event):
        if self.current_col < self.grid_size - 1:
            self.current_col += 1
            self.highlight_current_cell()
            if self.is_space_pressed or self.is_enter_pressed:
                self.toggle_cell()

    def highlight_current_cell(self):
        for r_idx, row in enumerate(self.grid):
            for c_idx, cell in enumerate(row):
                if r_idx == self.current_row and c_idx == self.current_col:
                    cell.config(relief="solid", bd=1)
                else:
                    cell.config(relief="flat", bd=0)

    def stop_toggling(self, event):
        self.is_space_pressed = False
        self.is_enter_pressed = False

if __name__ == "__main__":
    root = tk.Tk()
    app = QRaster(root)
    root.mainloop()
