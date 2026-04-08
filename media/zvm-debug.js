/* zvm-debug.js — bgl-debug ZVM patch
 *
 * Monkey-patches ZVM.prototype.run and ZVM.prototype.resume to add
 * breakpoint and step-over support, mirroring quixe-debug.js.
 * Loaded after zvm.js, before the inline startGame handler.
 *
 * run() checks window._bglBP / _bglStepMode at every basic-block
 * boundary (one outer while-loop iteration = one JIT dispatch in ZVM).
 * On a hit it:
 *   • sets this._bglDebugBreak = true  (signals resume() to skip Glk setup)
 *   • sets this.stop = 1               (exits the while-loop)
 *   • calls window._bglOnBreak / _bglOnStep(pc)
 *
 * resume() checks _bglDebugBreak after run() returns; if set it flushes
 * output via Glk.update() and returns without arming glk_select.
 *
 * _bglContinue() is called from the continue/step message handlers.
 * It re-enters run() directly; if run() stops for a normal Glk-wait
 * reason it restores the Glk event listener so player input still works.
 */
(function() {
    var _origRun     = ZVM.prototype.run;
    var _origResume  = ZVM.prototype.resume;
    var _origCompile = ZVM.prototype.compile;
    var _origPrint   = ZVM.prototype._print;

    /* ── Debug output capture ────────────────────────────────────────── */
    /* Wraps ZVM._print to mirror game text to the extension host in
     * real-time (via DAP output event) so it appears in the Debug Console
     * immediately, without waiting for Glk.update() to flush the panel. */
    ZVM.prototype._print = function(text) {
        _origPrint.call(this, text);
        if (window._bglDebugOutput) {
            window._bglDebugOutput(text);
        }
    };
    /* ── Patched start() ─────────────────────────────────────────────── */
    /* ZVM's init() is a bootstrap that sets this.init = this.start.
     * The real work (restart + run + Glk setup) happens in start().
     * start() uses var Glk = this.Glk (set by prepare()).
     * If run() fires a debug break, the Glk.glk_select + Glk.update
     * calls afterwards pollute GlkOte's state before the game has real output.
     * Fix: wrap Glk.glk_select and Glk.update with no-op guards. */
    var _origStart = ZVM.prototype.start;
    ZVM.prototype.start = function() {
        var self = this;
        var Glk  = this.Glk;
        if (Glk) {
            /* Suppress Glk.glk_select and Glk.update during debug break
             * to prevent GlkOte state pollution (gen counter / stale events). */
            var origSelect = Glk.glk_select;
            var origUpdate = Glk.update;
            Glk.glk_select = function(ref) {
                if (self._bglDebugBreak) { return; }
                return origSelect.call(this, ref);
            };
            Glk.update = function() {
                if (self._bglDebugBreak) { return; }
                return origUpdate.apply(this, arguments);
            };
            try { _origStart.call(this); } finally {
                Glk.glk_select = origSelect;
                Glk.update     = origUpdate;
            }
        } else {
            _origStart.call(this);
        }
    };

    /* ── JIT block splitter ─────────────────────────────────────────── */
    /* ZVM JIT-compiles multi-instruction "blocks". Our step check only
     * fires at block-start PCs. If a bgl-mapped address (e.g. 0x12827)
     * sits inside a block (e.g. 0x12820-0x1282c), it is never a block
     * start and the step check never fires there.
     *
     * Fix: patch compile() to split blocks at bgl seq-pt boundaries.
     * After a normal compile, if a seq-pt address falls inside the block,
     * recompile with a fake rtrue (0xB0) at that address to force the
     * disassembler to stop there. Then fix the generated "return 1" to
     * "e.pc=splitAddr; e.stop=1" so the run loop resumes from real code. */
    /* ── Patched compile() — inject step/bp checks into compiled blocks ─
     * Instead of truncating blocks (which breaks branch targets), we inject
     * inline checks at every seq-pt/bp address inside the block. When a
     * check fires, it sets e.pc and e.stop=1 to exit the run loop. */
    ZVM.prototype.compile = function() {
        var seqPts = window._bglAllSeqPtAddrs;
        var bps    = window._bglBP;
        var log = window._bglLog || function(){};

        var startPc = this.pc;
        _origCompile.call(this);
        var endPc = this.pc;

        if ((!seqPts || !seqPts.size) && (!bps || !bps.size)) return;

        /* Collect all addresses inside this block that need a step/bp check. */
        var checkAddrs = [];
        var addIfInside = function(addr) {
            if (addr > startPc && addr < endPc) checkAddrs.push(addr);
        };
        if (seqPts) seqPts.forEach(addIfInside);
        if (bps) bps.forEach(addIfInside);

        if (checkAddrs.length === 0) return;

        /* Get the compiled function source and inject checks at each address.
         * ZVM's compiled blocks have label comments: / * ADDR/opcode * /
         * We insert a check BEFORE each label that can exit the block. */
        var fn = this.jit[startPc];
        if (!fn) return;
        var src = fn.toString();
        var body = src.replace(/^[^{]*\{([\s\S]*)\}[^}]*$/, '$1');

        /* Sort descending so insertions don't shift later positions. */
        checkAddrs.sort(function(a,b){ return b - a; });
        var modified = false;
        for (var i = 0; i < checkAddrs.length; i++) {
            var addr = checkAddrs[i];
            var marker = '/* ' + addr + '/';
            var idx = body.indexOf(marker);
            if (idx === -1) continue;

            /* The marker may be inside an expression (e.g. setUint16(x, /* PC/ val)).
             * Scan backward to find a statement boundary so we insert valid JS. */
            var insertAt = idx;
            while (insertAt > 0 &&
                   body[insertAt - 1] !== ';' &&
                   body[insertAt - 1] !== '{') {
                insertAt--;
            }

            /* Only set e.pc and exit when a check actually matches.
             * Previously e.pc=addr ran unconditionally, corrupting e.pc
             * for the rest of the block even when no check fired. */
            var check =
                'if(window._bglBP&&window._bglBP.has(' + addr + ')&&' + addr + '!==window._bglSkipPC){' +
                  'e.pc=' + addr + ';window._bglSkipPC=null;e._bglDebugBreak=true;e.stop=1;window._bglBreakPausing=true;' +
                  'if(window._bglOnBreak)window._bglOnBreak(' + addr + ');return;}' +
                'if(window._bglStepMode){' +
                  'var _s=!window._bglStepStopAt||window._bglStepStopAt.has(' + addr + ');' +
                  'var _k=window._bglStepSkipAddrs&&window._bglStepSkipAddrs.has(' + addr + ');' +
                  'if(_s&&!_k){' +
                  'e.pc=' + addr + ';window._bglSkipPC=null;window._bglStepMode=false;' +
                  'e._bglDebugBreak=true;e.stop=1;window._bglBreakPausing=true;' +
                  'if(window._bglOnStep)window._bglOnStep(' + addr + ');return;}}' +
                'window._bglSkipPC=null;';
            body = body.slice(0, insertAt) + check + body.slice(insertAt);
            modified = true;
        }

        if (modified) {
            try {
                this.jit[startPc] = new Function('e', body);
            } catch(e2) {
                log('[zvm] inject compile FAILED at 0x' + startPc.toString(16) + ': ' + e2);
            }
        }
    };

    /* ── Patched run() ──────────────────────────────────────────────── */
    ZVM.prototype.run = function() {
        window._bglZvmInstance = this;
        this.stop = 0;
        try {
        while (!this.stop) {
            var pc = this.pc;

            /* Breakpoint check */
            if (window._bglBP && window._bglBP.has(pc) && pc !== window._bglSkipPC) {
                window._bglSkipPC = null;
                this._bglDebugBreak = true;
                this.stop = 1;
                window._bglBreakPausing = true;
                if (window._bglOnBreak) window._bglOnBreak(pc);
                return;
            }

            /* Step check */
            if (window._bglStepMode) {
                var _bglStop = !window._bglStepStopAt || window._bglStepStopAt.has(pc);
                var _bglSkip = window._bglStepSkipAddrs && window._bglStepSkipAddrs.has(pc);
                if (_bglStop && !_bglSkip) {
                    window._bglSkipPC = null;
                    window._bglStepMode = false;
                    this._bglDebugBreak = true;
                    this.stop = 1;
                    window._bglBreakPausing = true;
                    if (window._bglOnStep) window._bglOnStep(pc);
                    return;
                }
            }

            window._bglSkipPC = null;
            if (!this.jit[pc]) { this.compile(); }
            var result = this.jit[pc](this);
            if (!isNaN(result)) { this.ret(result); }
        }
        } catch(e) {
            var log = window._bglLog || function(){};
            log('[zvm] run() EXCEPTION pc=0x' + (this.pc||0).toString(16) + ': ' + e);
        }
    };

    /* ── Patched resume() ───────────────────────────────────────────── */
    /* ZVM's _origResume calls run() internally.  If run() fires a debug break,
     * _origResume still continues after run() returns and may call both
     * Glk.glk_select (to re-arm input) and Glk.update() (to flush display).
     * Either of those consumes GlkOte's generation counter while we're paused.
     * When _bglContinue later calls Glk.update() after the game reaches @read,
     * GlkOte ignores it (same gen = freeze).
     *
     * Fix: wrap BOTH Glk.glk_select AND Glk.update with no-op guards before
     * calling _origResume, so neither fires while _bglDebugBreak is set. */
    ZVM.prototype.resume = function(resumearg) {
        if (this._bglDebugBreak) {
            /* resume() called while paused at a break — suppress it.
             * Do NOT clear _bglDebugBreak here — leave it set so that
             * subsequent GlkOte events (arrange, timer) are also suppressed.
             * _bglContinue will clear it when the user actually continues. */
            return;
        }
        var self = this;
        var Glk = this.Glk;
        if (Glk) {
            var origSelect = Glk.glk_select;
            var origUpdate = Glk.update;
            Glk.glk_select = function(ref) {
                if (self._bglDebugBreak) { return; }
                return origSelect.call(this, ref);
            };
            Glk.update = function() {
                if (self._bglDebugBreak) { return; }
                return origUpdate.apply(this, arguments);
            };
            try { _origResume.call(this, resumearg); } finally {
                Glk.glk_select = origSelect;
                Glk.update = origUpdate;
            }
        } else {
            _origResume.call(this, resumearg);
        }
    };

    /* ── _bglContinue() ─────────────────────────────────────────────── */
    /* Called from the continue/step message handlers instead of Quixe.resume().
     * Resumes run() directly; if run() stops for a normal Glk-wait reason it
     * re-arms glk_select so the game can accept player input again. */
    ZVM.prototype._bglContinue = function() {
        this._bglDebugBreak = false;
        window._bglBreakPausing = false;
        /* Clear stale glk_event so @aread blocks properly. */
        this.glk_event = null;
        this.run();
        if (this.Glk) {
            if (!this._bglDebugBreak && !this.quit) {
                /* Mirror resume(): arm glk_event for the next input cycle. */
                var Glk = this.Glk;
                this.glk_event = new Glk.RefStruct();
                if (this.glk_blocking_call) {
                    this.glk_event.push_field(this.glk_blocking_call);
                } else {
                    Glk.glk_select(this.glk_event);
                }
            }
            if (window._bglBreakPausing) {
                window._bglBreakPausing = false;
                return;
            }
            try { this.Glk.update(); }
            catch(e) {
                var log = window._bglLog || function(){};
                log('[zvm] _bglContinue: Glk.update() threw: ' + e);
            }
        }
    };

    /* ── Z-machine VM state reader ──────────────────────────────────── */
    window._bglGetVmState = function() {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m) { return { frames: [], globals: {} }; }

        /* Locals live in inst.l[] (0-indexed, 16-bit Z-machine values).
         * Key by byte-offset (each local = 2 bytes) to match .dbg entries. */
        var locs = {};
        if (inst.l) {
            for (var i = 0; i < inst.l.length; i++) { locs[i * 2] = inst.l[i]; }
        }
        var frames = [{ funcAddr: inst.pc || 0, returnPC: 0, locals: locs }];

        /* Globals: Z-machine globals are 16-bit values at their memory addresses. */
        var globals = {};
        if (window._bglTrackedGlobalAddrs && inst.m) {
            var addrs = window._bglTrackedGlobalAddrs;
            for (var k = 0; k < addrs.length; k++) {
                try { globals[addrs[k]] = inst.m.getUint16(addrs[k]); } catch(e) {}
            }
        }
        return { frames: frames, globals: globals };
    };

    /* ── Z-machine write helpers ────────────────────────────────────── */
    window._bglSetGlobal = function(addr, val) {
        var inst = window._bglZvmInstance;
        if (!inst) return 'no-inst';
        if (!inst.ram) return 'no-ram';
        try { inst.ram.setUint16(addr, val & 0xFFFF); return true; }
        catch(e) { return 'err:' + e + ' addr=' + addr + ' ramLen=' + inst.ram.byteLength; }
    };
    window._bglSetLocal = function(stackIdx, offset, val) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.l) return false;
        var idx = offset / 2;
        if (idx >= 0 && idx < inst.l.length) { inst.l[idx] = val & 0xFFFF; return true; }
        return false;
    };

    /* ── Z-machine property table helpers ──────────────────────────── */

    /* Scan the property table of Z-machine object `obj` (1-indexed) for
     * property number `propNum`.  Returns { addr, size } of the data bytes,
     * or null if not found.  Works for Z4+ (Z5 is the primary target). */
    function zvmFindProp(m, obj, propNum) {
        var ver = m.getUint8(0);
        var objectTable      = m.getUint16(0x0A);
        var propDefaultsSize = (ver <= 3) ? 62  : 126; /* 31*2 or 63*2 */
        var objEntrySize     = (ver <= 3) ? 9   : 14;
        var propPtrOffset    = (ver <= 3) ? 7   : 12;

        var objEntry     = objectTable + propDefaultsSize + (obj - 1) * objEntrySize;
        var propTable    = m.getUint16(objEntry + propPtrOffset);

        /* Skip object name (Pascal string: first byte = length in Z-words) */
        var nameLen = m.getUint8(propTable);
        var addr    = propTable + 1 + nameLen * 2;

        /* Walk property list (descending order, terminated by 0x00) */
        while (true) {
            var b = m.getUint8(addr);
            if (b === 0) { return null; }

            var num, dataSize, dataAddr;
            if (ver <= 3) {
                num      = b & 0x1f;
                dataSize = ((b >> 5) & 0x07) + 1;
                dataAddr = addr + 1;
            } else if (b & 0x80) {
                /* Long form: 2-byte header */
                num      = b & 0x3f;
                var sb   = m.getUint8(addr + 1);
                dataSize = (sb & 0x3f) || 64;
                dataAddr = addr + 2;
            } else {
                /* Short form: 1-byte header; bit 6 = size (0→1 byte, 1→2 bytes) */
                num      = b & 0x3f;
                dataSize = (b & 0x40) ? 2 : 1;
                dataAddr = addr + 1;
            }

            if (num === propNum) { return { addr: dataAddr, size: dataSize }; }
            if (num < propNum)   { return null; } /* props are descending */
            addr = dataAddr + dataSize;
        }
    }

    window._bglReadProp = function(obj, propNum) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m) { return null; }
        try {
            var p = zvmFindProp(inst.m, obj, propNum);
            if (!p) { return null; }
            if (p.size === 1) { return inst.m.getUint8(p.addr); }
            if (p.size === 2) { return inst.m.getUint16(p.addr); }
            /* Multi-word property (size > 2): return array of 2-byte values.
             * e.g. name [p.cloak, p.dark, p.velvet] has size=6 → 3 entries. */
            var arr = [];
            for (var i = 0; i < p.size; i += 2) { arr.push(inst.m.getUint16(p.addr + i)); }
            return arr;
        } catch(e) { return null; }
    };

    window._bglSetProp = function(obj, propNum, val) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m) { return false; }
        try {
            var p = zvmFindProp(inst.m, obj, propNum);
            if (!p) { return false; }
            if (p.size === 1) { inst.m.setUint8(p.addr,  val & 0xFF);   return true; }
            if (p.size === 2) { inst.m.setUint16(p.addr, val & 0xFFFF); return true; }
            return false; /* multi-byte properties not supported for set */
        } catch(e) { return false; }
    };

    /* Read the attribute bytes for Z-machine object `obj` (1-indexed).
     * v1-3: 4 attribute bytes (32 attributes) at the start of the 9-byte entry.
     * v4+ : 6 attribute bytes (48 attributes) at the start of the 14-byte entry.
     *
     * Z-machine stores attribute N at byte[N>>3] bit (7 - N%8) — MSB-first.
     * activeAttributeNames() expects LSB-first (Glulx convention), so we
     * bit-reverse each byte before returning. */
    window._bglReadAttrs = function(obj) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m || !obj) { return null; }
        try {
            var m           = inst.m;
            var ver         = m.getUint8(0);
            var objectTable = m.getUint16(0x0A);
            var v3          = ver <= 3;
            var propDefSize = v3 ? 62  : 126;
            var entrySize   = v3 ? 9   : 14;
            var attrCount   = v3 ? 4   : 6;
            var entryAddr   = objectTable + propDefSize + (obj - 1) * entrySize;
            var b = [];
            for (var i = 0; i < attrCount; i++) {
                var byte_ = m.getUint8(entryAddr + i);
                /* Reverse the 8 bits so attr N maps to bit (N%8) from LSB */
                byte_ = (byte_ & 0xF0) >> 4 | (byte_ & 0x0F) << 4;
                byte_ = (byte_ & 0xCC) >> 2 | (byte_ & 0x33) << 2;
                byte_ = (byte_ & 0xAA) >> 1 | (byte_ & 0x55) << 1;
                b.push(byte_);
            }
            return b;
        } catch(e) { return null; }
    };

    /* Decode a Z-machine dictionary word at byte address `addr`.
     * Dictionary entries start with the encoded word text: 4 bytes for v1-3,
     * 6 bytes for v4+ (= 2 or 3 Z-words).  Use ZVM's own decode() which
     * respects the stop bit and handles abbreviations. */
    window._bglDecodeDictWord = function(addr) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m || !addr) { return null; }
        try {
            var ver     = inst.m.getUint8(0);
            var wordLen = (ver <= 3) ? 4 : 6;
            var result  = inst.decode(addr, wordLen);
            if (result === undefined || result === null) { return null; }
            return ('' + result).trim() || null;
        } catch(e) { return null; }
    };

    /* Decode a Beguile string variable for the Variables pane.
     * On Z-machine, string values are PACKED addresses.  Convert to a byte
     * address using addr_multipler (2 for Z3, 4 for Z5/Z6/Z7, 8 for Z8),
     * then use ZVM's own decode() which handles Z-characters and abbreviations.
     * decode() returns either a plain string or an object whose toString()
     * expands abbreviations at call time — both work with '' + result. */
    window._bglDecodeString = function(raw) {
        var inst = window._bglZvmInstance;
        if (!inst || !inst.m || !raw) { return null; }
        try {
            var byteAddr = raw * inst.addr_multipler;
            var result = inst.jit[byteAddr] || inst.decode(byteAddr);
            if (result === undefined || result === null) { return null; }
            return ('' + result).replace(/\r/g, '\n');
        } catch(e) { return null; }
    };
})();
